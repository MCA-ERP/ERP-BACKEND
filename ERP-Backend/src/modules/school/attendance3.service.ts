import { randomBytes } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getRules } from "./attendance.service";
import { dayRange, hm, iso, istDate, lateAfter, one, uid } from "./attendance2.service";
import type { St } from "./attendance2.service";
import { roster } from "./student-mgmt.service";

/** RFID / QR readers, cards and scans, leave, and attendance reports. */

// ═════════════ readers ═════════════
export async function listReaders(inst: string, date: string) {
  const { from, to } = dayRange(date);
  const [d, sc] = await Promise.all([supabaseAdmin.from("rfid_devices").select("id, code, kind, label, location, mode, status, last_sync").eq("institution_id", inst).order("code"), supabaseAdmin.from("scans").select("device_id").eq("institution_id", inst).gte("scanned_at", from).lt("scanned_at", to).limit(100000)]);
  const scans = (check(sc) ?? []) as { device_id: string | null }[];
  return { items: (check(d) as unknown as { id: string; code: string; kind: string; label: string; location: string; mode: string; status: string; last_sync: string | null }[]).map((x) => ({ ...x, scans_today: scans.filter((s) => s.device_id === x.id).length, last_sync_time: hm(x.last_sync), last_sync_date: x.last_sync ? istDate(new Date(x.last_sync)) : "" })), scans_total: scans.length };
}
export async function addReader(inst: string, input: unknown) {
  const i = z.object({ kind: z.enum(["RFID", "QR"]), label: z.string().trim().min(2, "Enter the type.").max(40), location: z.string().trim().min(2, "Enter the location.").max(100), mode: z.enum(["Entry", "Exit", "Both", "Board / drop"]) }).strict().parse(input);
  const prefix = i.kind === "RFID" ? "RD-" : "QS-";
  const have = (check(await supabaseAdmin.from("rfid_devices").select("code").eq("institution_id", inst).eq("kind", i.kind)) as { code: string }[]).map((r) => parseInt(r.code.slice(3), 10) || 0);
  return check(await supabaseAdmin.from("rfid_devices").insert({ institution_id: inst, code: `${prefix}${String(Math.max(0, ...have) + 1).padStart(2, "0")}`, kind: i.kind, label: i.label, location: i.location, mode: i.mode, status: "Online", last_sync: new Date().toISOString() }).select("id, code").single());
}
export async function setReaderStatus(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Online", "Offline", "Low battery"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("rfid_devices").update({ status, ...(status === "Online" ? { last_sync: new Date().toISOString() } : {}) }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Reader not found.");
  return { ok: true };
}

// ═════════════ cards ═════════════
export async function listCards(inst: string) {
  const [ro, cards] = await Promise.all([roster(inst), supabaseAdmin.from("student_cards").select("student_id, rfid_code, qr_code, issued_on, status").eq("institution_id", inst)]);
  const by = new Map(((check(cards) ?? []) as { student_id: string; rfid_code: string; qr_code: string; issued_on: string; status: string }[]).map((c) => [c.student_id, c]));
  return { items: ro.items.filter((r) => r.status === "Enrolled").map((r) => { const c = by.get(r.id); return { student_id: r.id, name: r.name, class_label: r.class_label, registration_no: r.registration_no, rfid_code: c?.rfid_code ?? "", qr_code: c?.qr_code ?? "", issued_on: c?.issued_on ?? "", status: c?.status ?? "Not issued" }; }) };
}
export async function issueCard(inst: string, input: unknown) {
  const { student_id } = z.object({ student_id: uid }).strict().parse(input);
  const s = (await roster(inst)).items.find((r) => r.id === student_id);
  if (!s) throw new HttpError(404, "Student not found.");
  const cur = check(await supabaseAdmin.from("student_cards").select("status").eq("student_id", student_id).maybeSingle()) as { status: string } | null;
  if (cur?.status === "Issued") throw new HttpError(409, "This student already has a card.");
  const row = { institution_id: inst, student_id, rfid_code: `RF-${randomBytes(4).toString("hex").toUpperCase()}`, qr_code: s.registration_no.replace(/[^A-Za-z0-9]+/g, "-").toUpperCase(), issued_on: istDate(), status: "Issued" };
  check(await supabaseAdmin.from("student_cards").upsert(row, { onConflict: "student_id" }).select("id"));
  return { rfid_code: row.rfid_code };
}
export async function markCardLost(inst: string, studentId: string) {
  const r = check(await supabaseAdmin.from("student_cards").update({ status: "Lost" }).eq("student_id", studentId).eq("institution_id", inst).eq("status", "Issued").select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "No issued card for this student.");
  return { ok: true };
}

// ═════════════ scans ═════════════
export async function listScans(inst: string, date: string) {
  iso.parse(date);
  const { from, to } = dayRange(date);
  const [rows, ro] = await Promise.all([supabaseAdmin.from("scans").select("id, student_id, scanned_at, how, direction, result, note, dev:device_id(location)").eq("institution_id", inst).gte("scanned_at", from).lt("scanned_at", to).order("scanned_at", { ascending: false }).limit(5000), roster(inst)]);
  const kids = new Map(ro.items.map((r) => [r.id, r]));
  type R = { id: string; student_id: string; scanned_at: string; how: string; direction: string; result: string; note: string | null; dev: { location: string } | { location: string }[] | null };
  const list = check(rows) as unknown as R[];
  return {
    date, total: list.length, entered: new Set(list.filter((r) => r.direction === "In" && r.result === "OK").map((r) => r.student_id)).size, problems: list.filter((r) => r.result !== "OK").length,
    items: list.map((r) => ({ id: r.id, time: hm(r.scanned_at), student: kids.get(r.student_id)?.name ?? "", class_label: kids.get(r.student_id)?.class_label ?? "", where: one(r.dev)?.location ?? "—", how: r.how, direction: r.direction, result: r.result, note: r.note ?? "" })),
  };
}
export async function addScan(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, device_id: uid.nullable().optional(), how: z.enum(["RFID", "QR"]), direction: z.enum(["In", "Out"]), note: z.string().trim().max(120).optional() }).strict().parse(input);
  if (!(await roster(inst)).items.some((r) => r.id === i.student_id && r.status === "Enrolled")) throw new HttpError(404, "Student not found.");
  if (i.device_id) { const d = check(await supabaseAdmin.from("rfid_devices").select("id").eq("id", i.device_id).eq("institution_id", inst).maybeSingle()); if (!d) throw new HttpError(404, "Reader not found."); }
  const card = check(await supabaseAdmin.from("student_cards").select("status").eq("student_id", i.student_id).maybeSingle()) as { status: string } | null;
  let result: "OK" | "Blocked" | "Duplicate" = "OK";
  let note = i.note ?? "";
  if (i.how === "RFID" && (!card || card.status !== "Issued")) { result = "Blocked"; note = card ? "Lost card" : "No card issued"; }
  else {
    const recent = check(await supabaseAdmin.from("scans").select("id").eq("student_id", i.student_id).eq("direction", i.direction).eq("result", "OK").gte("scanned_at", new Date(Date.now() - 5 * 60000).toISOString()).limit(1)) as unknown[];
    if (recent.length) { result = "Duplicate"; note = "Tapped twice within 5 minutes"; }
  }
  check(await supabaseAdmin.from("scans").insert({ institution_id: inst, student_id: i.student_id, device_id: i.device_id ?? null, how: i.how, direction: i.direction, result, note: note || null }).select("id"));
  if (i.device_id) check(await supabaseAdmin.from("rfid_devices").update({ last_sync: new Date().toISOString(), status: "Online" }).eq("id", i.device_id).select("id"));
  return { result, note };
}

// ═════════════ sync, exceptions and alerts ═════════════
async function leaveToday(inst: string, date: string) {
  return new Set((check(await supabaseAdmin.from("student_leaves").select("student_id").eq("institution_id", inst).eq("status", "Approved").lte("from_date", date).gte("to_date", date)) as { student_id: string }[]).map((x) => x.student_id));
}
async function firstScans(inst: string, date: string) {
  const { from, to } = dayRange(date);
  const rows = check(await supabaseAdmin.from("scans").select("student_id, scanned_at").eq("institution_id", inst).eq("direction", "In").eq("result", "OK").gte("scanned_at", from).lt("scanned_at", to).order("scanned_at").limit(100000)) as { student_id: string; scanned_at: string }[];
  const first = new Map<string, string>();
  for (const r of rows) if (!first.has(r.student_id)) first.set(r.student_id, r.scanned_at);
  return first;
}

export async function syncSummary(inst: string, date: string) {
  iso.parse(date);
  const [ro, first, onLeave, late, cards, st, links] = await Promise.all([
    roster(inst), firstScans(inst, date), leaveToday(inst, date), lateAfter(inst),
    supabaseAdmin.from("student_cards").select("student_id, status").eq("institution_id", inst),
    supabaseAdmin.from("att_settings").select("last_push_at").eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("student_guardians").select("student_id, relation, guardians:guardian_id!inner(institution_id, full_name, phone)").eq("guardians.institution_id", inst).limit(20000),
  ]);
  const active = ro.items.filter((r) => r.status === "Enrolled");
  const card = new Map(((check(cards) ?? []) as { student_id: string; status: string }[]).map((c) => [c.student_id, c.status]));
  const par = new Map<string, { name: string; phone: string }>();
  for (const l of (check(links) ?? []) as unknown as { student_id: string; relation: string; guardians: { full_name: string; phone: string } | { full_name: string; phone: string }[] | null }[]) { const g = one(l.guardians); if (g && (!par.has(l.student_id) || l.relation === "Father")) par.set(l.student_id, { name: g.full_name, phone: g.phone === "-" ? "" : g.phone }); }
  const present = active.filter((s) => first.has(s.id));
  const lateOnes = present.filter((s) => hm(first.get(s.id) ?? null) > late);
  const none = active.filter((s) => !first.has(s.id) && !onLeave.has(s.id));
  const row = (s: (typeof active)[number], status: string) => ({ student_id: s.id, name: s.name, class_label: s.class_label, card: card.get(s.id) ?? "Not issued", first_scan: hm(first.get(s.id) ?? null), status, parent: par.get(s.id)?.name ?? "", phone: par.get(s.id)?.phone ?? "" });
  return { date, total: active.length, present: present.length, late: lateOnes.length, no_scan: none.length, late_after: late, last_push_at: (st.data as { last_push_at: string | null } | null)?.last_push_at ?? null, items: [...none.map((s) => row(s, "No scan")), ...lateOnes.map((s) => row(s, "Late"))] };
}

export async function pushAttendance(inst: string, actor?: string) {
  const date = istDate();
  const [ro, first, late] = await Promise.all([roster(inst), firstScans(inst, date), lateAfter(inst)]);
  const ids = [...first.keys()];
  if (!ids.length) throw new HttpError(409, "There are no gate scans today to push.");
  const have = new Set((check(await supabaseAdmin.from("attendance_records").select("student_id").eq("institution_id", inst).eq("att_date", date).in("student_id", ids)) as { student_id: string }[]).map((r) => r.student_id));
  const rows = ro.items.filter((r) => first.has(r.id) && !have.has(r.id) && r.status === "Enrolled").map((r) => ({ institution_id: inst, student_id: r.id, section_id: r.section_id, att_date: date, status: hm(first.get(r.id) ?? null) > late ? "L" : "P", marked_by: actor ?? null }));
  if (rows.length) check(await supabaseAdmin.from("attendance_records").insert(rows).select("id"));
  check(await supabaseAdmin.from("att_settings").upsert({ institution_id: inst, last_push_at: new Date().toISOString() }, { onConflict: "institution_id" }).select("institution_id"));
  return { pushed: rows.length, kept: ids.length - rows.length };
}
export async function markException(inst: string, input: unknown, actor?: string) {
  const i = z.object({ student_id: uid, status: z.enum(["P", "A"]) }).strict().parse(input);
  const s = (await roster(inst)).items.find((r) => r.id === i.student_id);
  if (!s) throw new HttpError(404, "Student not found.");
  check(await supabaseAdmin.from("attendance_records").upsert({ institution_id: inst, student_id: i.student_id, section_id: s.section_id, att_date: istDate(), status: i.status, marked_by: actor ?? null, updated_at: new Date().toISOString() }, { onConflict: "student_id,att_date" }).select("id"));
  return { ok: true };
}
export async function parentAlerts(inst: string, date: string) {
  const sum = await syncSummary(inst, date);
  const onLeave = (await leaveToday(inst, date)).size;
  return { date, late_after: sum.late_after, no_tap: sum.no_scan, on_leave: onLeave, items: sum.items.filter((x) => x.status === "No scan").map((x) => ({ student_id: x.student_id, name: x.name, class_label: x.class_label, parent: x.parent, phone: x.phone })) };
}

// ═════════════ leave ═════════════
const nonSundays = (from: string, to: string) => { const out: string[] = []; for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d = new Date(d.getTime() + 86400000)) if (d.getUTCDay() !== 0) out.push(d.toISOString().slice(0, 10)); return out; };
type Who = { first_name: string; last_name: string; designation: string | null; roles: { display_name: string } | { display_name: string }[] | null };

export async function listLeaves(inst: string) {
  const [s, st, ro] = await Promise.all([
    supabaseAdmin.from("student_leaves").select("id, code, student_id, leave_type, from_date, to_date, days, applied_on, status").eq("institution_id", inst).order("applied_on", { ascending: false }).limit(2000),
    supabaseAdmin.from("leave_requests").select("id, leave_type, from_date, to_date, days, created_at, status, who:profile_id(first_name, last_name, designation, roles:role_id(display_name))").eq("institution_id", inst).order("created_at", { ascending: false }).limit(2000),
    roster(inst),
  ]);
  const kids = new Map(ro.items.map((r) => [r.id, r]));
  type SL = { id: string; code: string; student_id: string; leave_type: string; from_date: string; to_date: string; days: number; applied_on: string; status: string };
  type TL = { id: string; leave_type: string; from_date: string; to_date: string; days: number; created_at: string; status: string; who: Who | Who[] | null };
  return {
    students: (check(s) as unknown as SL[]).map((r) => ({ id: r.id, ref: r.code, who: "Student" as const, name: kids.get(r.student_id)?.name ?? "", detail: kids.get(r.student_id)?.class_label ?? "", leave_type: r.leave_type, from_date: r.from_date, to_date: r.to_date, days: r.days, applied_on: r.applied_on, waiting_hours: 0, status: r.status })),
    staff: (check(st) as unknown as TL[]).map((r) => { const w = one(r.who); return { id: r.id, ref: `LV-${r.id.slice(0, 4).toUpperCase()}`, who: "Staff" as const, name: w ? `${w.first_name} ${w.last_name}`.trim() : "", detail: w?.designation || one(w?.roles ?? null)?.display_name || "Staff", leave_type: `${r.leave_type} leave`, from_date: r.from_date, to_date: r.to_date, days: Number(r.days), applied_on: r.created_at.slice(0, 10), waiting_hours: Math.max(0, Math.round((Date.now() - Date.parse(r.created_at)) / 3600000)), status: r.status }; }),
    students_list: ro.items.filter((r) => r.status === "Enrolled").map((r) => ({ id: r.id, name: r.name, class_label: r.class_label })),
  };
}
export async function addStudentLeave(inst: string, input: unknown, actor?: string) {
  const i = z.object({ student_id: uid, leave_type: z.string().trim().min(2, "Enter the leave type.").max(40), from_date: iso, to_date: iso }).strict().parse(input);
  if (i.to_date < i.from_date) throw new HttpError(400, "The end date is before the start.");
  if (!(await roster(inst)).items.some((r) => r.id === i.student_id)) throw new HttpError(404, "Student not found.");
  const days = nonSundays(i.from_date, i.to_date).length;
  if (!days) throw new HttpError(400, "Those dates are all Sundays.");
  const clash = check(await supabaseAdmin.from("student_leaves").select("id").eq("student_id", i.student_id).in("status", ["Pending", "Approved"]).lte("from_date", i.to_date).gte("to_date", i.from_date).limit(1)) as unknown[];
  if (clash.length) throw new HttpError(409, "That student already has leave on some of those dates.");
  return check(await supabaseAdmin.from("student_leaves").insert({ institution_id: inst, ...i, days, created_by: actor ?? null }).select("id, code").single());
}
export async function decideLeave(inst: string, who: "student" | "staff", id: string, input: unknown, actor?: string) {
  const { status } = z.object({ status: z.enum(["Approved", "Rejected"]) }).strict().parse(input);
  if (who === "staff") {
    const r = check(await supabaseAdmin.from("leave_requests").update({ status, decided_by: actor ?? null, decided_at: new Date().toISOString() }).eq("id", id).eq("institution_id", inst).eq("status", "Pending").select("id")) as unknown[];
    if (!r.length) throw new HttpError(409, "That leave isn't waiting for a decision.");
    return { ok: true };
  }
  const l = check(await supabaseAdmin.from("student_leaves").select("id, student_id, from_date, to_date, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; student_id: string; from_date: string; to_date: string; status: string } | null;
  if (!l) throw new HttpError(404, "Leave application not found.");
  if (l.status !== "Pending") throw new HttpError(409, "That leave isn't waiting for a decision.");
  check(await supabaseAdmin.from("student_leaves").update({ status, decided_by: actor ?? null }).eq("id", id).select("id"));
  if (status === "Approved") {
    const days = nonSundays(l.from_date, l.to_date).filter((d) => d <= istDate());
    if (days.length) {
      const s = (await roster(inst)).items.find((r) => r.id === l.student_id);
      const have = check(await supabaseAdmin.from("attendance_records").select("att_date, status").eq("student_id", l.student_id).in("att_date", days)) as { att_date: string; status: string }[];
      const keep = new Set(have.filter((h) => h.status !== "A").map((h) => h.att_date));
      const rows = days.filter((d) => !keep.has(d)).map((d) => ({ institution_id: inst, student_id: l.student_id, section_id: s?.section_id ?? null, att_date: d, status: "V", marked_by: actor ?? null }));
      if (rows.length) check(await supabaseAdmin.from("attendance_records").upsert(rows, { onConflict: "student_id,att_date" }).select("id"));
    }
  }
  return { ok: true };
}

// ═════════════ reports ═════════════
const attended = (s: St) => s === "P" || s === "L" || s === "H";
export async function monthly(inst: string) {
  const y = check(await supabaseAdmin.from("academic_years").select("name, start_date").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { name: string; start_date: string } | null;
  if (!y) return { year: "", items: [] as { month: string; label: string; avg: number; days: number }[] };
  const R = check(await supabaseAdmin.from("attendance_records").select("att_date, status").eq("institution_id", inst).gte("att_date", y.start_date).limit(500000)) as { att_date: string; status: St }[];
  const by = new Map<string, { a: number; n: number; d: Set<string> }>();
  for (const r of R) { const k = r.att_date.slice(0, 7); const m = by.get(k) ?? { a: 0, n: 0, d: new Set<string>() }; m.n++; m.d.add(r.att_date); if (attended(r.status)) m.a++; by.set(k, m); }
  const LB = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return { year: y.name, items: [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, m]) => ({ month: k, label: LB[+k.slice(5) - 1], avg: Math.round((m.a / m.n) * 1000) / 10, days: m.d.size })) };
}
export async function studentWise(inst: string) {
  const [ro, y, rules] = await Promise.all([roster(inst), supabaseAdmin.from("academic_years").select("start_date").eq("institution_id", inst).eq("is_current", true).maybeSingle(), getRules(inst)]);
  const start = (y.data as { start_date: string } | null)?.start_date;
  const R = start ? (check(await supabaseAdmin.from("attendance_records").select("student_id, status").eq("institution_id", inst).gte("att_date", start).limit(500000)) as { student_id: string; status: St }[]) : [];
  const tot = new Map<string, { a: number; n: number }>();
  for (const r of R) { const t = tot.get(r.student_id) ?? { a: 0, n: 0 }; t.n++; if (attended(r.status)) t.a++; tot.set(r.student_id, t); }
  return { min: rules.min_attendance, items: ro.items.filter((r) => r.status === "Enrolled").map((r) => { const t = tot.get(r.id); return { student_id: r.id, name: r.name, class_label: r.class_label, days_present: t?.a ?? 0, days_marked: t?.n ?? 0, pct: t ? Math.round((t.a / t.n) * 100) : null }; }) };
}
