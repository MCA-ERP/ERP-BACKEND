import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { staffList } from "./attendance2.service";

/** Hostel: setup, buildings, rooms, beds, allocation, attendance and the mess. */
const uid = z.string().uuid();
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const nowHm = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
const FLOORS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];
const LETTERS = "ABCDEFGHIJKL";

type St = { hostels: { id: string; name: string; warden: string; status: string }[]; buildings: { id: string; hostel_id: string; name: string; use_label: string }[]; floors: { id: string; building_id: string; name: string; sort: number }[]; rooms: { id: string; hostel_id: string; building_id: string; floor_id: string; code: string; room_type: string; beds: number; maintenance: boolean }[]; beds: { id: string; room_id: string; label: string; seq: number }[]; allocs: { id: string; student_id: string; bed_id: string; from_date: string; status: string; transfer_bed_id: string | null; meal_plan_id: string | null }[] };
async function load(inst: string): Promise<St> {
  const q = (t: string, c: string, ord: string) => supabaseAdmin.from(t).select(c).eq("institution_id", inst).order(ord).limit(10000);
  const [h, b, f, r, d, a] = await Promise.all([q("hostels", "id, name, warden, status", "name"), q("hostel_buildings", "id, hostel_id, name, use_label", "name"), q("hostel_floors", "id, building_id, name, sort", "sort"), q("hostel_rooms", "id, hostel_id, building_id, floor_id, code, room_type, beds, maintenance", "code"), q("hostel_beds", "id, room_id, label, seq", "label"), supabaseAdmin.from("hostel_allocations").select("id, student_id, bed_id, from_date, status, transfer_bed_id, meal_plan_id").eq("institution_id", inst).neq("status", "Vacated").limit(10000)]);
  return { hostels: check(h) as never, buildings: check(b) as never, floors: check(f) as never, rooms: check(r) as never, beds: check(d) as never, allocs: check(a) as never };
}
const occ = (s: St, roomId: string) => s.allocs.filter((a) => s.beds.find((b) => b.id === a.bed_id)?.room_id === roomId).length;
const roomStatus = (s: St, r: St["rooms"][number]) => { const o = occ(s, r.id); return r.maintenance ? "Under maintenance" : o >= r.beds ? "Full" : o === 0 ? "Empty" : "Partly full"; };

// ═════════════ setup ═════════════
export async function hostels(inst: string) {
  const [s, w] = await Promise.all([load(inst), staffList(inst)]);
  return { wardens: w.map((x) => x.name), items: s.hostels.map((h) => { const rs = s.rooms.filter((r) => r.hostel_id === h.id); const bs = s.beds.filter((b) => rs.some((r) => r.id === b.room_id)); return { ...h, buildings: s.buildings.filter((b) => b.hostel_id === h.id).length, rooms: rs.length, beds: bs.length, occupied: s.allocs.filter((a) => bs.some((b) => b.id === a.bed_id)).length }; }) };
}
export async function addHostel(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the hostel name.").max(80), warden: z.string().trim().max(80), buildings: z.number().int().min(1).max(10), rooms: z.number().int().min(1).max(500), beds: z.number().int().min(1).max(6000) }).strict().parse(input);
  if (i.rooms < i.buildings) throw new HttpError(400, "There must be at least one room in each building.");
  if (i.beds < i.rooms) throw new HttpError(400, "There must be at least one bed in every room.");
  if (i.beds > i.rooms * 12) throw new HttpError(400, "A room holds at most 12 beds.");
  if ((check(await supabaseAdmin.from("hostels").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[]).length) throw new HttpError(409, "That hostel exists.");
  const parts = i.name.split(/\s[–-]\s/); const use = parts.length > 1 ? parts[0] : i.name; const prefix = (i.name.match(/[A-Za-z]/)?.[0] ?? "H").toUpperCase();
  const h = check(await supabaseAdmin.from("hostels").insert({ institution_id: inst, name: i.name, warden: i.warden }).select("id").single()) as { id: string };
  try {
    const baseR = Math.floor(i.rooms / i.buildings); const extraR = i.rooms % i.buildings; const baseBeds = Math.floor(i.beds / i.rooms); const extraBeds = i.beds % i.rooms; let roomNo = 0; const types = new Set<string>();
    for (let b = 0; b < i.buildings; b++) {
      const nm = parts.length > 1 ? (i.buildings > 1 ? `${parts[1]} ${LETTERS[b]}` : parts[1]) : i.buildings > 1 ? `${i.name} ${LETTERS[b]}` : i.name; const n = baseR + (b < extraR ? 1 : 0);
      const bd = check(await supabaseAdmin.from("hostel_buildings").insert({ institution_id: inst, hostel_id: h.id, name: nm, use_label: use }).select("id").single()) as { id: string };
      const nFloors = Math.ceil(n / 12); const fl = check(await supabaseAdmin.from("hostel_floors").insert([{ institution_id: inst, building_id: bd.id, name: "Ground", sort: 0 }, ...Array.from({ length: nFloors }, (_, k) => ({ institution_id: inst, building_id: bd.id, name: FLOORS[k], sort: k + 1 }))]).select("id, sort")) as { id: string; sort: number }[];
      const rooms: object[] = []; const meta: { code: string; beds: number }[] = [];
      for (let k = 0; k < n; k++) { const floor = Math.floor(k / 12) + 1; const code = `${prefix}${i.buildings > 1 ? LETTERS[b] : ""}-${floor}${String((k % 12) + 1).padStart(2, "0")}`; const beds = baseBeds + (roomNo < extraBeds ? 1 : 0); roomNo++; const type = `${beds}-bed`; types.add(type); meta.push({ code, beds }); rooms.push({ institution_id: inst, hostel_id: h.id, building_id: bd.id, floor_id: fl.find((x) => x.sort === floor)!.id, code, room_type: type, beds }); }
      const made = check(await supabaseAdmin.from("hostel_rooms").insert(rooms).select("id, code, beds")) as { id: string; code: string; beds: number }[];
      check(await supabaseAdmin.from("hostel_beds").insert(made.flatMap((r) => Array.from({ length: r.beds }, (_, k) => ({ institution_id: inst, room_id: r.id, label: `${r.code}-${k + 1}`, seq: k + 1 })))).select("id"));
    }
    for (const t of types) await supabaseAdmin.from("hostel_room_types").upsert({ institution_id: inst, name: t }, { onConflict: "institution_id,name", ignoreDuplicates: true });
  } catch (e) { await supabaseAdmin.from("hostels").delete().eq("id", h.id).eq("institution_id", inst); throw e; }
  return h;
}
export async function buildings(inst: string) {
  const s = await load(inst);
  return { buildings: s.buildings.map((b) => { const fl = s.floors.filter((f) => f.building_id === b.id); return { id: b.id, name: b.name, use: b.use_label, floors: fl.length, rooms: s.rooms.filter((r) => r.building_id === b.id).length }; }), floors: s.floors.map((f) => { const b = s.buildings.find((x) => x.id === f.building_id)!; const rs = s.rooms.filter((r) => r.floor_id === f.id); return { id: f.id, building: b.name, floor: f.name, rooms: f.sort === 0 ? "Common area" : rs.length ? (rs.length === 1 ? rs[0].code : `${rs[0].code} – ${rs[rs.length - 1].code}`) : "—" }; }).sort((a, b) => a.building.localeCompare(b.building)) };
}

// ═════════════ rooms and beds ═════════════
export async function rooms(inst: string) {
  const [s, t] = await Promise.all([load(inst), supabaseAdmin.from("hostel_room_types").select("name, fee_per_year, for_classes").eq("institution_id", inst).order("name")]);
  return { items: s.rooms.map((r) => ({ id: r.id, code: r.code, hostel: s.hostels.find((h) => h.id === r.hostel_id)?.name ?? "", floor: s.floors.find((f) => f.id === r.floor_id)?.sort ?? 0, type: r.room_type, beds: r.beds, occupied: occ(s, r.id), maintenance: r.maintenance, status: roomStatus(s, r) })), types: check(t) as { name: string; fee_per_year: number | null; for_classes: string }[] };
}
export async function setMaintenance(inst: string, id: string, input: unknown) {
  const { maintenance } = z.object({ maintenance: z.boolean() }).strict().parse(input); const s = await load(inst); const r = s.rooms.find((x) => x.id === id); if (!r) throw new HttpError(404, "Not found.");
  if (maintenance && occ(s, id) > 0) throw new HttpError(409, "Move the students out of this room first.");
  check(await supabaseAdmin.from("hostel_rooms").update({ maintenance }).eq("id", id).eq("institution_id", inst).select("id")); return { ok: true };
}
export async function editRoomType(inst: string, name: string, input: unknown) {
  const i = z.object({ fee_per_year: z.number().int().min(0).max(10_000_000).nullable(), for_classes: z.string().trim().max(40) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hostel_room_types").update(i).eq("institution_id", inst).eq("name", name).select("name")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function beds(inst: string) {
  const [s, ro] = await Promise.all([load(inst), roster(inst)]); const K = new Map(ro.items.map((x) => [x.id, x]));
  const held = new Set(s.allocs.map((a) => a.student_id));
  return { students: ro.items.filter((x) => (x.status === "Enrolled" || x.enrol_status === "Enrolled") && !held.has(x.id)).slice(0, 2000).map((x) => ({ id: x.id, name: `${x.name} · ${x.class_label}` })), items: s.beds.map((b) => { const r = s.rooms.find((x) => x.id === b.room_id)!; const a = s.allocs.find((x) => x.bed_id === b.id); return { id: b.id, label: b.label, hostel: s.hostels.find((h) => h.id === r.hostel_id)?.name ?? "", room: r.code, status: r.maintenance ? "Blocked" : a ? "Occupied" : "Available", student: a ? K.get(a.student_id)?.name ?? "" : "" }; }) };
}

// ═════════════ allocation ═════════════
export async function allocations(inst: string) {
  const [s, ro, plans] = await Promise.all([load(inst), roster(inst), mealPlans(inst)]); const K = new Map(ro.items.map((x) => [x.id, x]));
  const where = (bedId: string | null) => { const b = s.beds.find((x) => x.id === bedId); const r = b ? s.rooms.find((x) => x.id === b.room_id) : null; return { room: r?.code ?? "", hostel: r ? s.hostels.find((h) => h.id === r.hostel_id)?.name ?? "" : "", bed: b ? LETTERS[b.seq - 1] ?? String(b.seq) : "" }; };
  return { plans: plans.items.map((p) => ({ id: p.id, name: p.name })), free: s.beds.filter((b) => !s.allocs.some((a) => a.bed_id === b.id) && !s.rooms.find((r) => r.id === b.room_id)?.maintenance).map((b) => ({ id: b.id, label: `${b.label} · ${s.hostels.find((h) => h.id === s.rooms.find((r) => r.id === b.room_id)?.hostel_id)?.name ?? ""}` })),
    items: s.allocs.map((a) => ({ id: a.id, student_id: a.student_id, student: K.get(a.student_id)?.name ?? "", class_label: K.get(a.student_id)?.class_label ?? "", ...where(a.bed_id), from: a.from_date, status: a.status, transfer_to: a.transfer_bed_id ? s.beds.find((b) => b.id === a.transfer_bed_id)?.label ?? "" : "", meal_plan_id: a.meal_plan_id })).sort((p, q) => q.from.localeCompare(p.from)) };
}
export async function allocate(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, bed_id: uid }).strict().parse(input); const s = await load(inst);
  const bed = s.beds.find((b) => b.id === i.bed_id); if (!bed) throw new HttpError(404, "Bed not found."); const room = s.rooms.find((r) => r.id === bed.room_id)!; if (room.maintenance) throw new HttpError(409, "That room is under maintenance.");
  if (s.allocs.some((a) => a.bed_id === i.bed_id)) throw new HttpError(409, "That bed is taken."); if (s.allocs.some((a) => a.student_id === i.student_id)) throw new HttpError(409, "That student already has a bed.");
  if (!(await roster(inst)).items.some((x) => x.id === i.student_id)) throw new HttpError(404, "Student not found.");
  return check(await supabaseAdmin.from("hostel_allocations").insert({ institution_id: inst, ...i, from_date: today() }).select("id").single());
}
export async function allocationAction(inst: string, id: string, input: unknown) {
  const i = z.object({ action: z.enum(["vacate", "request_transfer", "approve_transfer", "cancel_transfer", "set_plan"]), bed_id: uid.optional(), meal_plan_id: uid.nullable().optional() }).strict().parse(input); const s = await load(inst); const a = s.allocs.find((x) => x.id === id); if (!a) throw new HttpError(404, "Not found.");
  const up = async (row: object) => { check(await supabaseAdmin.from("hostel_allocations").update(row).eq("id", id).eq("institution_id", inst).select("id")); return { ok: true }; };
  if (i.action === "vacate") return up({ status: "Vacated", transfer_bed_id: null });
  if (i.action === "set_plan") { if (i.meal_plan_id && !check(await supabaseAdmin.from("hostel_meal_plans").select("id").eq("id", i.meal_plan_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Plan not found."); return up({ meal_plan_id: i.meal_plan_id ?? null }); }
  if (i.action === "request_transfer") { if (!i.bed_id) throw new HttpError(400, "Pick the new bed."); const b = s.beds.find((x) => x.id === i.bed_id); if (!b || s.allocs.some((x) => x.bed_id === i.bed_id) || s.rooms.find((r) => r.id === b.room_id)?.maintenance) throw new HttpError(409, "That bed is not free."); if (a.status === "Transfer requested") throw new HttpError(409, "A transfer is already requested."); return up({ status: "Transfer requested", transfer_bed_id: i.bed_id }); }
  if (a.status !== "Transfer requested" || !a.transfer_bed_id) throw new HttpError(409, "No transfer is waiting.");
  if (i.action === "cancel_transfer") return up({ status: "Active", transfer_bed_id: null });
  if (s.allocs.some((x) => x.bed_id === a.transfer_bed_id && x.id !== id)) throw new HttpError(409, "That bed has been taken.");
  return up({ bed_id: a.transfer_bed_id, transfer_bed_id: null, status: "Active" });
}

// ═════════════ attendance ═════════════
export async function attendance(inst: string) {
  const [a, s, ro] = await Promise.all([supabaseAdmin.from("hostel_attendance").select("id, student_id, att_date, kind, out_time, in_time, reason, status").eq("institution_id", inst).order("att_date", { ascending: false }).order("out_time", { ascending: false, nullsFirst: false }).limit(3000), load(inst), roster(inst)]); const K = new Map(ro.items.map((x) => [x.id, x]));
  const roomOf = (sid: string) => { const al = s.allocs.find((x) => x.student_id === sid); const b = al ? s.beds.find((x) => x.id === al.bed_id) : null; return b ? s.rooms.find((r) => r.id === b.room_id)?.code ?? "" : ""; };
  return { students: s.allocs.map((x) => ({ id: x.student_id, name: K.get(x.student_id)?.name ?? "" })), items: (check(a) as { id: string; student_id: string; att_date: string; kind: string; out_time: string | null; in_time: string | null; reason: string; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", room: roomOf(x.student_id) })) };
}
export async function rollCall(inst: string) {
  const s = await load(inst); const t = today(); const done = new Set((check(await supabaseAdmin.from("hostel_attendance").select("student_id").eq("institution_id", inst).eq("att_date", t).eq("kind", "Night roll call")) as { student_id: string }[]).map((x) => x.student_id));
  const out = new Set((check(await supabaseAdmin.from("hostel_attendance").select("student_id").eq("institution_id", inst).eq("status", "Out")) as { student_id: string }[]).map((x) => x.student_id));
  const rows = s.allocs.filter((a) => a.status === "Active" && !done.has(a.student_id) && !out.has(a.student_id)).map((a) => ({ institution_id: inst, student_id: a.student_id, att_date: t, kind: "Night roll call", in_time: "21:00", reason: "Roll call", status: "Present" }));
  if (!rows.length) throw new HttpError(409, "Roll call is already done for everyone in the hostel today.");
  check(await supabaseAdmin.from("hostel_attendance").insert(rows).select("id")); return { marked: rows.length };
}
export async function recordOut(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, kind: z.enum(["Home leave", "Outing"]), reason: z.string().trim().min(2, "Give the reason.").max(80), out_time: z.string().regex(/^\d{2}:\d{2}$/).optional() }).strict().parse(input); const s = await load(inst); const a = s.allocs.find((x) => x.student_id === i.student_id); if (!a) throw new HttpError(404, "That student is not in the hostel.");
  if ((check(await supabaseAdmin.from("hostel_attendance").select("id").eq("institution_id", inst).eq("student_id", i.student_id).eq("status", "Out")) as unknown[]).length) throw new HttpError(409, "That student is already out.");
  check(await supabaseAdmin.from("hostel_attendance").insert({ institution_id: inst, student_id: i.student_id, att_date: today(), kind: i.kind, out_time: i.out_time ?? nowHm(), reason: i.reason, status: "Out" }).select("id"));
  if (i.kind === "Home leave") check(await supabaseAdmin.from("hostel_allocations").update({ status: "On home leave" }).eq("id", a.id).eq("institution_id", inst).select("id")); return { ok: true };
}
export async function markReturned(inst: string, id: string) {
  const e = check(await supabaseAdmin.from("hostel_attendance").update({ status: "Returned", in_time: nowHm() }).eq("id", id).eq("institution_id", inst).eq("status", "Out").select("student_id")) as { student_id: string }[]; if (!e.length) throw new HttpError(409, "Already back.");
  check(await supabaseAdmin.from("hostel_allocations").update({ status: "Active" }).eq("institution_id", inst).eq("student_id", e[0].student_id).eq("status", "On home leave").select("id")); return { ok: true };
}

// ═════════════ mess ═════════════
export async function mealPlans(inst: string) {
  if (!(check(await supabaseAdmin.from("hostel_meal_plans").select("id").eq("institution_id", inst).limit(1)) as unknown[]).length) check(await supabaseAdmin.from("hostel_meal_plans").insert(["Veg", "Non-veg", "Jain"].map((name) => ({ institution_id: inst, name }))).select("id"));
  const [p, a] = await Promise.all([supabaseAdmin.from("hostel_meal_plans").select("id, name, meals, per_month, status").eq("institution_id", inst).order("name"), supabaseAdmin.from("hostel_allocations").select("meal_plan_id").eq("institution_id", inst).neq("status", "Vacated").not("meal_plan_id", "is", null)]);
  const A = check(a) as { meal_plan_id: string }[]; return { items: (check(p) as { id: string; name: string; meals: string; per_month: number | null; status: string }[]).map((x) => ({ ...x, students: A.filter((y) => y.meal_plan_id === x.id).length })) };
}
export async function editPlan(inst: string, id: string, input: unknown) {
  const i = z.object({ per_month: z.number().int().min(0).max(1_000_000).nullable(), meals: z.string().trim().min(2).max(80), status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hostel_meal_plans").update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export async function menu(inst: string) {
  const m = check(await supabaseAdmin.from("hostel_menu").select("day, breakfast, lunch, snacks, dinner").eq("institution_id", inst)) as { day: number; breakfast: string; lunch: string; snacks: string; dinner: string }[];
  const d = new Date(`${today()}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; const mon = new Date(d.getTime() - dow * 86400000); const sun = new Date(mon.getTime() + 6 * 86400000);
  const f = (x: Date) => x.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
  return { week: `${f(mon)} – ${f(sun)}`, today: dow, rows: DAYS.map((name, day) => ({ name, ...(m.find((x) => x.day === day) ?? { breakfast: "", lunch: "", snacks: "", dinner: "" }), day })) };
}
export async function saveMenu(inst: string, input: unknown) {
  const i = z.object({ rows: z.array(z.object({ day: z.number().int().min(0).max(6), breakfast: z.string().trim().max(80), lunch: z.string().trim().max(80), snacks: z.string().trim().max(80), dinner: z.string().trim().max(80) }).strict()).min(1).max(7) }).strict().parse(input);
  check(await supabaseAdmin.from("hostel_menu").upsert(i.rows.map((r) => ({ institution_id: inst, ...r }))).select("day")); return { ok: true };
}
export async function dayScholars(inst: string) {
  const [s, ro, m] = await Promise.all([load(inst), roster(inst), supabaseAdmin.from("mess_day_students").select("student_id, meals, diet, since, per_month, allergy, opted").eq("institution_id", inst)]);
  const held = new Set(s.allocs.map((a) => a.student_id)); const M = new Map((check(m) as { student_id: string; meals: string; diet: string; since: string; per_month: number | null; allergy: string; opted: boolean }[]).map((x) => [x.student_id, x]));
  const items = ro.items.filter((x) => (x.status === "Enrolled" || x.enrol_status === "Enrolled") && !held.has(x.id)).map((x) => { const o = M.get(x.id); return { id: x.id, name: x.name, class_label: x.class_label, opted: !!o?.opted, meals: o?.meals ?? "", diet: o?.diet ?? "", since: o?.opted ? o.since : null, allergy: o?.opted ? o.allergy : "", per_month: o?.opted ? o.per_month : null }; });
  const opted = items.filter((x) => x.opted);
  return { items: items.slice(0, 1500), total: items.length, opted: opted.length, not_opted: items.length - opted.length, veg: opted.filter((x) => x.diet === "Veg" || x.diet === "Jain").length, allergies: opted.filter((x) => x.allergy).length };
}
export async function startMess(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, meals: z.enum(["Lunch", "Lunch + snacks"]), diet: z.enum(["Veg", "Non-veg", "Jain"]), per_month: z.number().int().min(0).max(100000).nullable().optional(), allergy: z.string().trim().max(40).optional() }).strict().parse(input);
  if (!(await roster(inst)).items.some((x) => x.id === i.student_id)) throw new HttpError(404, "Student not found.");
  check(await supabaseAdmin.from("mess_day_students").upsert({ institution_id: inst, student_id: i.student_id, meals: i.meals, diet: i.diet, per_month: i.per_month ?? null, allergy: i.allergy ?? "", opted: true, since: today() }, { onConflict: "student_id" }).select("id")); return { ok: true };
}
export async function stopMess(inst: string, studentId: string) {
  const r = check(await supabaseAdmin.from("mess_day_students").update({ opted: false }).eq("institution_id", inst).eq("student_id", studentId).eq("opted", true).select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "Not on the mess."); return { ok: true };
}
export async function messRequests(inst: string) {
  const [r, ro] = await Promise.all([supabaseAdmin.from("mess_requests").select("id, code, parent_name, start_on, student_id, meals, diet, requested_on, status").eq("institution_id", inst).order("requested_on", { ascending: false }).limit(2000), roster(inst)]); const K = new Map(ro.items.map((x) => [x.id, x]));
  return { items: (check(r) as { id: string; code: string; parent_name: string; start_on: string | null; student_id: string; meals: string; diet: string; requested_on: string; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "" })) };
}
export async function decideRequest(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["approve", "decline"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("mess_requests").update({ status: action === "approve" ? "Approved" : "Declined" }).eq("id", id).eq("institution_id", inst).eq("status", "Pending").select("student_id, meals, diet, start_on")) as { student_id: string; meals: string; diet: string; start_on: string | null }[]; if (!r.length) throw new HttpError(409, "That was already decided.");
  if (action === "approve") check(await supabaseAdmin.from("mess_day_students").upsert({ institution_id: inst, student_id: r[0].student_id, meals: r[0].meals, diet: r[0].diet, opted: true, since: r[0].start_on ?? today() }, { onConflict: "student_id" }).select("id")); return { ok: true };
}
export async function charges(inst: string) {
  const [d, a, p, ro] = await Promise.all([dayScholars(inst), allocations(inst), mealPlans(inst), roster(inst)]); void ro;
  const hostel = a.items.map((x) => { const pl = p.items.find((y) => y.id === x.meal_plan_id); return { student: x.student, class_label: x.class_label, kind: "Hostel", plan: pl?.name ?? "No plan", per_month: pl?.per_month ?? null }; });
  const day = d.items.filter((x) => x.opted).map((x) => ({ student: x.name, class_label: x.class_label, kind: "Day scholar", plan: `${x.meals} · ${x.diet}`, per_month: x.per_month }));
  const items = [...hostel, ...day]; return { items, total: items.reduce((n, x) => n + (x.per_month ?? 0), 0) };
}
