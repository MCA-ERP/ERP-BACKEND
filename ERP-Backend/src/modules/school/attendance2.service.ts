import { randomBytes } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getRules } from "./attendance.service";
import { roster } from "./student-mgmt.service";

/** Staff attendance, geo check-ins, biometric devices, RFID / QR scans, leave, and attendance reports. */
export const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
export const uid = z.string().uuid();
export const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const TZ = "Asia/Kolkata";
export const istDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: TZ });
export const hm = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) : "");
export const dayRange = (date: string) => ({ from: `${date}T00:00:00+05:30`, to: new Date(Date.parse(`${date}T00:00:00+05:30`) + 86400000).toISOString() });
const STATUS = ["P", "A", "L", "H", "V"] as const;
export type St = (typeof STATUS)[number];
const time = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM.");
const name = (p: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null) => { const x = one(p); return x ? `${x.first_name} ${x.last_name}`.trim() : ""; };

// ═════════════ staff attendance ═════════════
export async function staffList(inst: string) {
  const [u, h] = await Promise.all([
    supabaseAdmin.from("user_profiles").select("id, first_name, last_name, designation, roles:role_id(name, display_name)").eq("institution_id", inst).order("first_name").limit(1000),
    supabaseAdmin.from("hr_staff").select("profile_id, emp_code, department").eq("institution_id", inst).limit(5000),
  ]);
  const rows = check(u) as unknown as { id: string; first_name: string; last_name: string; designation: string | null; roles: { name: string; display_name: string } | { name: string; display_name: string }[] | null }[];
  const H = new Map(((check(h) ?? []) as { profile_id: string; emp_code: string; department: string }[]).map((x) => [x.profile_id, x]));
  return rows.filter((r) => !["Parent", "Student", "Applicant"].includes(one(r.roles)?.name ?? "")).map((r) => ({ id: r.id, name: `${r.first_name} ${r.last_name}`.trim(), emp_code: H.get(r.id)?.emp_code ?? "", department: H.get(r.id)?.department || r.designation || one(r.roles)?.display_name || "Staff" }));
}

export async function staffSheet(inst: string, date: string) {
  iso.parse(date);
  const [staff, recs] = await Promise.all([staffList(inst), supabaseAdmin.from("staff_attendance").select("staff_id, status, in_time, out_time").eq("institution_id", inst).eq("att_date", date)]);
  const by = new Map(((check(recs) ?? []) as { staff_id: string; status: St; in_time: string | null; out_time: string | null }[]).map((r) => [r.staff_id, r]));
  return { date, marked: by.size, items: staff.map((s) => { const r = by.get(s.id); return { ...s, status: r?.status ?? null, in_time: r?.in_time?.slice(0, 5) ?? "", out_time: r?.out_time?.slice(0, 5) ?? "" }; }) };
}

export async function saveStaffSheet(inst: string, input: unknown, actor?: string) {
  const i = z.object({ date: iso, marks: z.array(z.object({ staff_id: uid, status: z.enum(STATUS), in_time: time.nullable().optional(), out_time: time.nullable().optional() })).min(1).max(1000) }).strict().parse(input);
  if (i.date > istDate()) throw new HttpError(400, "You can't mark attendance for a future date.");
  const ok = new Set((await staffList(inst)).map((s) => s.id));
  const rows = i.marks.filter((m) => ok.has(m.staff_id)).map((m) => ({ institution_id: inst, staff_id: m.staff_id, att_date: i.date, status: m.status, in_time: m.in_time ?? null, out_time: m.out_time ?? null, source: "Manual", marked_by: actor ?? null }));
  if (!rows.length) throw new HttpError(400, "None of those people are on the staff list.");
  check(await supabaseAdmin.from("staff_attendance").upsert(rows, { onConflict: "staff_id,att_date" }).select("id"));
  return { saved: rows.length };
}

export async function staffDepartments(inst: string, date: string) {
  const s = await staffSheet(inst, date);
  const by = new Map<string, { department: string; present: number; total: number }>();
  for (const r of s.items) { const d = by.get(r.department) ?? { department: r.department, present: 0, total: 0 }; d.total++; if (r.status === "P" || r.status === "L" || r.status === "H") d.present++; by.set(r.department, d); }
  return { date, marked: s.marked, items: [...by.values()].sort((a, b) => b.total - a.total || a.department.localeCompare(b.department)) };
}

// ═════════════ geo check-ins ═════════════
export async function listGeo(inst: string, date: string) {
  iso.parse(date);
  const { from, to } = dayRange(date);
  const [rows, staff, marked] = await Promise.all([supabaseAdmin.from("geo_checkins").select("id, staff_id, at, method, place, distance_m, geo_status, selfie, resolution, staff:staff_id(first_name, last_name)").eq("institution_id", inst).gte("at", from).lt("at", to).order("at", { ascending: false }), staffList(inst), supabaseAdmin.from("staff_attendance").select("staff_id").eq("institution_id", inst).eq("att_date", date).in("status", ["P", "L", "H"]).limit(5000)]);
  const here = new Set([...(check(rows) as unknown as { staff_id: string }[]).map((r) => r.staff_id), ...((check(marked) ?? []) as { staff_id: string }[]).map((r) => r.staff_id)]);
  const known = new Set(staff.map((x) => x.id));
  type R = { id: string; staff_id: string; at: string; method: string; place: string; distance_m: number | null; geo_status: string; selfie: string; resolution: string | null; staff: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null };
  const items = (check(rows) as unknown as R[]).map((r) => ({ id: r.id, staff: name(r.staff), time: hm(r.at), method: r.method, place: r.place, distance_m: r.distance_m, geo_status: r.geo_status, selfie: r.selfie, resolution: r.resolution ?? "" }));
  return { date, total_staff: staff.length, checked_in: [...here].filter((id) => known.has(id)).length, items };
}

export async function addGeo(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, method: z.enum(["Mobile app", "Mobile app (field)", "Biometric", "Face scan"]), place: z.string().trim().min(2, "Enter where.").max(120), distance_m: z.number().int().min(0).max(100000).nullable().optional(), geo_status: z.enum(["Inside", "Outside", "Field duty"]), selfie: z.enum(["Matched", "No match"]) }).strict().parse(input);
  const ok = (await staffList(inst)).some((s) => s.id === i.staff_id);
  if (!ok) throw new HttpError(404, "Staff member not found.");
  const row = check(await supabaseAdmin.from("geo_checkins").insert({ institution_id: inst, ...i, distance_m: i.distance_m ?? null }).select("id, at").single()) as { id: string; at: string };
  // a clean check-in counts as present
  if (i.geo_status !== "Outside" && i.selfie === "Matched") await markStaff(inst, i.staff_id, "P", hm(row.at), i.method);
  return { id: row.id };
}

async function markStaff(inst: string, staff: string, status: St, inTime: string | null, source: string) {
  const d = istDate();
  const cur = check(await supabaseAdmin.from("staff_attendance").select("in_time").eq("staff_id", staff).eq("att_date", d).maybeSingle()) as { in_time: string | null } | null;
  check(await supabaseAdmin.from("staff_attendance").upsert({ institution_id: inst, staff_id: staff, att_date: d, status, in_time: cur?.in_time ?? inTime, source }, { onConflict: "staff_id,att_date" }).select("id"));
}

export async function resolveGeo(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["accept", "absent"]) }).strict().parse(input);
  const g = check(await supabaseAdmin.from("geo_checkins").select("id, staff_id, at, method, resolution").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; staff_id: string; at: string; method: string; resolution: string | null } | null;
  if (!g) throw new HttpError(404, "Check-in not found.");
  if (g.resolution) throw new HttpError(409, "This check-in was already decided.");
  await markStaff(inst, g.staff_id, action === "accept" ? "P" : "A", action === "accept" ? hm(g.at) : null, g.method);
  check(await supabaseAdmin.from("geo_checkins").update({ resolution: action === "accept" ? "Accepted" : "Absent" }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ biometric ═════════════
export async function listBio(inst: string) {
  const [d, m, s, staff] = await Promise.all([
    supabaseAdmin.from("bio_devices").select("id, code, location, model, status, last_sync").eq("institution_id", inst).order("code"),
    supabaseAdmin.from("bio_mappings").select("id, staff_id, device_id, biometric_id, fingerprints").eq("institution_id", inst),
    supabaseAdmin.from("bio_syncs").select("id, device_id, synced_at, punches, new_marked, status").eq("institution_id", inst).order("synced_at", { ascending: false }).limit(200),
    staffList(inst),
  ]);
  const devices = check(d) as unknown as { id: string; code: string; location: string; model: string; status: string; last_sync: string | null }[];
  const maps = (check(m) ?? []) as { id: string; staff_id: string; device_id: string; biometric_id: string; fingerprints: string }[];
  const syncs = (check(s) ?? []) as { id: string; device_id: string; synced_at: string; punches: number; new_marked: number; status: string }[];
  const code = new Map(devices.map((x) => [x.id, x.code]));
  const sid = new Map(staff.map((x) => [x.id, x]));
  return {
    devices: devices.map((x) => ({ ...x, mapped: maps.filter((y) => y.device_id === x.id).length })),
    mappings: maps.map((x) => ({ id: x.id, staff_id: x.staff_id, staff: sid.get(x.staff_id)?.name ?? "", department: sid.get(x.staff_id)?.department ?? "", device_id: x.device_id, device: code.get(x.device_id) ?? "", biometric_id: x.biometric_id, fingerprints: x.fingerprints })),
    syncs: syncs.map((x) => ({ id: x.id, device: code.get(x.device_id) ?? "", synced_at: x.synced_at, punches: x.punches, new_marked: x.new_marked, status: x.status })),
    staff,
  };
}
export async function addBioDevice(inst: string, input: unknown) {
  const i = z.object({ location: z.string().trim().min(2, "Enter the location.").max(100), model: z.string().trim().min(2, "Enter the model.").max(60) }).strict().parse(input);
  return check(await supabaseAdmin.from("bio_devices").insert({ institution_id: inst, ...i, status: "Offline" }).select("id, code").single());
}
export async function mapBio(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, device_id: uid, biometric_id: z.string().trim().min(1, "Enter the biometric ID.").max(20), fingerprints: z.enum(["Verified", "Missing"]).default("Verified") }).strict().parse(input);
  if (!(await staffList(inst)).some((s) => s.id === i.staff_id)) throw new HttpError(404, "Staff member not found.");
  const dev = check(await supabaseAdmin.from("bio_devices").select("id").eq("id", i.device_id).eq("institution_id", inst).maybeSingle());
  if (!dev) throw new HttpError(404, "Device not found.");
  const dup = check(await supabaseAdmin.from("bio_mappings").select("staff_id").eq("institution_id", inst).eq("biometric_id", i.biometric_id).neq("staff_id", i.staff_id)) as unknown[];
  if (dup.length) throw new HttpError(409, "That biometric ID belongs to someone else.");
  check(await supabaseAdmin.from("bio_mappings").upsert({ institution_id: inst, ...i }, { onConflict: "institution_id,staff_id" }).select("id"));
  return { ok: true };
}
export async function setFingerprints(inst: string, id: string, input: unknown) {
  const { fingerprints } = z.object({ fingerprints: z.enum(["Verified", "Missing"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("bio_mappings").update({ fingerprints }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Mapping not found.");
  return { ok: true };
}
export async function logSync(inst: string, input: unknown) {
  const i = z.object({ device_id: uid, punches: z.number().int().min(0).max(100000), new_marked: z.number().int().min(0).max(100000), status: z.enum(["Success", "Failed"]) }).strict().parse(input);
  if (i.new_marked > i.punches) throw new HttpError(400, "New staff marked can't be more than the punches.");
  const dev = check(await supabaseAdmin.from("bio_devices").select("id").eq("id", i.device_id).eq("institution_id", inst).maybeSingle());
  if (!dev) throw new HttpError(404, "Device not found.");
  check(await supabaseAdmin.from("bio_syncs").insert({ institution_id: inst, ...i }).select("id"));
  check(await supabaseAdmin.from("bio_devices").update({ status: i.status === "Success" ? "Online" : "Offline", ...(i.status === "Success" ? { last_sync: new Date().toISOString() } : {}) }).eq("id", i.device_id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ RFID and QR ═════════════
export async function lateAfter(inst: string) {
  const s = check(await supabaseAdmin.from("att_settings").select("late_after").eq("institution_id", inst).maybeSingle()) as { late_after: string } | null;
  return (s?.late_after ?? "08:15").slice(0, 5);
}

export async function listReaders(inst: string, date: string) {
  const { from, to } = dayRange(date);
  const [d, sc] = await Promise.all([supabaseAdmin.from("rfid_devices").select("id, code, kind, label, location, mode, status, last_sync").eq("institution_id", inst).order("code"), supabaseAdmin.from("scans").select("device_id").eq("institution_id", inst).gte("scanned_at", from).lt("scanned_at", to).limit(100000)]);
  const scans = (check(sc) ?? []) as { device_id: string | null }[];
  return { items: (check(d) as unknown as { id: string; code: string; kind: string; label: string; location: string; mode: string; status: string; last_sync: string | null }[]).map((x) => ({ ...x, scans_today: scans.filter((s) => s.device_id === x.id).length, last_sync_time: hm(x.last_sync), last_sync_date: x.last_sync ? istDate(new Date(x.last_sync)) : "" })), scans_total: scans.length };
}
