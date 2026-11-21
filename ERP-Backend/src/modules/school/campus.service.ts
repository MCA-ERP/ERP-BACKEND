import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { staffList } from "./attendance2.service";
import { allocations, mealPlans, rooms } from "./hostel.service";
import { payments } from "./fees.service";

/** Hostel complaints, fees and canteen; day-scholar menu; visitors, gate passes and incidents; student health. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const hm = z.string().regex(/^\d{2}:\d{2}$/, "Use a time like 10:30.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const nowHm = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
const enrolled = async (inst: string) => (await roster(inst)).items.filter((x) => x.status === "Enrolled" || x.enrol_status === "Enrolled");
const upd = async (table: string, inst: string, id: string, row: object, where: Record<string, string> = {}) => {
  let q = supabaseAdmin.from(table).update(row).eq("id", id).eq("institution_id", inst); for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
  const r = check(await q.select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That can't be done in its current state."); return { ok: true };
};

// ═════════════ hostel complaints ═════════════
export async function complaints(inst: string) {
  const [c, a, s] = await Promise.all([supabaseAdmin.from("hostel_complaints").select("id, code, student_id, room_code, issue, assigned_to, status, raised_on").eq("institution_id", inst).order("raised_on", { ascending: false }).order("code", { ascending: false }).limit(3000), allocations(inst), staffList(inst)]);
  const K = new Map(a.items.map((x) => [x.student_id, x])); const ro = (await roster(inst)).items; const N = new Map(ro.map((x) => [x.id, x.name]));
  return { students: a.items.map((x) => ({ id: x.student_id, name: x.student, room: x.room })), staff: s.map((x) => `${x.department} · ${x.name}`), items: (check(c) as { id: string; code: string; student_id: string | null; room_code: string; issue: string; assigned_to: string; status: string; raised_on: string }[]).map((x) => ({ ...x, student: x.student_id ? N.get(x.student_id) ?? K.get(x.student_id)?.student ?? "" : "" })) };
}
export async function addComplaint(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, issue: z.string().trim().min(3, "Describe the issue.").max(160), assigned_to: z.string().trim().max(80).optional(), raised_on: date.optional() }).strict().parse(input);
  const al = (await allocations(inst)).items.find((x) => x.student_id === i.student_id); if (!al) throw new HttpError(404, "That student is not in the hostel.");
  return check(await supabaseAdmin.from("hostel_complaints").insert({ institution_id: inst, student_id: i.student_id, room_code: al.room, issue: i.issue, assigned_to: i.assigned_to ?? "", status: i.assigned_to ? "Assigned" : "Open", raised_on: i.raised_on ?? today() }).select("id, code").single());
}
export async function complaintAction(inst: string, id: string, input: unknown) {
  const i = z.object({ action: z.enum(["assign", "start", "resolve"]), assigned_to: z.string().trim().min(2).max(80).optional() }).strict().parse(input);
  if (i.action === "assign") { if (!i.assigned_to) throw new HttpError(400, "Pick who it goes to."); return upd("hostel_complaints", inst, id, { assigned_to: i.assigned_to, status: "Assigned" }); }
  if (i.action === "start") return upd("hostel_complaints", inst, id, { status: "In progress" }, {});
  return upd("hostel_complaints", inst, id, { status: "Resolved", resolved_on: today() });
}

// ═════════════ hostel fees ═════════════
export async function hostelFees(inst: string) {
  const [r, p, pay] = await Promise.all([rooms(inst), mealPlans(inst), payments(inst)]);
  return { structure: [...r.types.map((t) => ({ fee: `Hostel fee · ${t.name}`, amount: t.fee_per_year, unit: "a year", billed: "3 term instalments" })), ...p.items.map((x) => ({ fee: `Mess · ${x.name}`, amount: x.per_month, unit: "a month", billed: "Monthly, on the 1st" }))], collection: pay.items.filter((x) => /hostel|mess/i.test(x.fee)) };
}

// ═════════════ canteen ═════════════
export async function canteen(inst: string) {
  const t = today(); const [i, s, st] = await Promise.all([supabaseAdmin.from("canteen_items").select("id, name, price, peanuts").eq("institution_id", inst).eq("active", true).order("name"), supabaseAdmin.from("canteen_sales").select("student_id, items, amount, sold_at").eq("institution_id", inst).gte("sold_at", `${t}T00:00:00+05:30`).order("sold_at", { ascending: false }), enrolled(inst)]); const K = new Map(st.map((x) => [x.id, x]));
  return { students: st.slice(0, 3000).map((x) => ({ id: x.id, name: `${x.name} · ${x.class_label} · ${x.registration_no}` })), items: check(i) as { id: string; name: string; price: number; peanuts: boolean }[], sales: (check(s) as { student_id: string; items: string; amount: number; sold_at: string }[]).map((x) => ({ ...x, student: `${K.get(x.student_id)?.name ?? ""} · ${K.get(x.student_id)?.class_label ?? ""}` })) };
}
export async function canteenCard(inst: string, studentId: string) {
  const st = (await enrolled(inst)).find((x) => x.id === studentId); if (!st) throw new HttpError(404, "Student not found.");
  const [w, h, sp] = await Promise.all([supabaseAdmin.from("canteen_wallets").select("balance, daily_limit").eq("student_id", studentId).maybeSingle(), supabaseAdmin.from("student_health").select("allergies").eq("student_id", studentId).maybeSingle(), supabaseAdmin.from("canteen_sales").select("amount").eq("institution_id", inst).eq("student_id", studentId).gte("sold_at", `${today()}T00:00:00+05:30`)]);
  const W = (check(w) as { balance: number; daily_limit: number } | null) ?? { balance: 0, daily_limit: 150 }; const al = (check(h) as { allergies: string } | null)?.allergies ?? "";
  return { name: st.name, class_label: st.class_label, registration_no: st.registration_no, balance: W.balance, daily_limit: W.daily_limit, spent_today: (check(sp) as { amount: number }[]).reduce((n, x) => n + x.amount, 0), blocked: /peanut/i.test(al) ? ["Peanuts"] : [] };
}
export async function addCanteenItem(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2).max(60), price: z.number().int().min(0).max(100000), peanuts: z.boolean() }).strict().parse(input);
  if ((check(await supabaseAdmin.from("canteen_items").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[]).length) throw new HttpError(409, "That item exists.");
  return check(await supabaseAdmin.from("canteen_items").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function topUp(inst: string, studentId: string, input: unknown) {
  const i = z.object({ amount: z.number().int().min(1).max(100000), daily_limit: z.number().int().min(0).max(100000).optional() }).strict().parse(input); const c = await canteenCard(inst, studentId);
  check(await supabaseAdmin.from("canteen_wallets").upsert({ student_id: studentId, institution_id: inst, balance: c.balance + i.amount, daily_limit: i.daily_limit ?? c.daily_limit }).select("student_id")); return { balance: c.balance + i.amount };
}
export async function sell(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, lines: z.array(z.object({ item_id: uid, qty: z.number().int().min(1).max(20) }).strict()).min(1, "Tap an item to add it.").max(20) }).strict().parse(input);
  const [c, it] = await Promise.all([canteenCard(inst, i.student_id), canteen(inst)]); let total = 0; const names: string[] = [];
  for (const l of i.lines) { const x = it.items.find((y) => y.id === l.item_id); if (!x) throw new HttpError(404, "Item not found."); if (x.peanuts && c.blocked.includes("Peanuts")) throw new HttpError(409, `${x.name} contains peanuts and this student has a peanut allergy.`); total += x.price * l.qty; names.push(l.qty > 1 ? `${x.name} × ${l.qty}` : x.name); }
  if (total <= 0) throw new HttpError(400, "Nothing to charge."); if (total > c.balance) throw new HttpError(409, `The wallet has only ₹${c.balance}.`); if (c.spent_today + total > c.daily_limit) throw new HttpError(409, `That goes over the daily limit of ₹${c.daily_limit}.`);
  check(await supabaseAdmin.from("canteen_wallets").upsert({ student_id: i.student_id, institution_id: inst, balance: c.balance - total, daily_limit: c.daily_limit }).select("student_id"));
  check(await supabaseAdmin.from("canteen_sales").insert({ institution_id: inst, student_id: i.student_id, items: names.join(", "), amount: total }).select("id")); return { amount: total, balance: c.balance - total };
}

// ═════════════ day-scholar daily menu ═════════════
const monday = (d: string) => { const x = new Date(`${d}T00:00:00Z`); return new Date(x.getTime() - ((x.getUTCDay() + 6) % 7) * 86400000); };
const iso = (x: Date) => x.toISOString().slice(0, 10);
export async function dayMenu(inst: string, from?: string) {
  const mon = monday(from ?? today()); const days = Array.from({ length: 6 }, (_, k) => iso(new Date(mon.getTime() + k * 86400000)));
  const [m, p, o] = await Promise.all([supabaseAdmin.from("day_menu_items").select("menu_date, slot, name, peanuts, pos").eq("institution_id", inst).in("menu_date", days).order("pos"), supabaseAdmin.from("day_menu_published").select("week_start").eq("institution_id", inst).eq("week_start", days[0]).maybeSingle(), supabaseAdmin.from("mess_day_students").select("allergy").eq("institution_id", inst).eq("opted", true)]);
  const M = check(m) as { menu_date: string; slot: string; name: string; peanuts: boolean }[];
  return { today: today(), week_start: days[0], published: !!check(p), allergy_opted: (check(o) as { allergy: string }[]).filter((x) => /peanut/i.test(x.allergy)).length, days: days.map((d) => ({ date: d, name: new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }), short: new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }), slots: { morning: M.filter((x) => x.menu_date === d && x.slot === "morning"), lunch: M.filter((x) => x.menu_date === d && x.slot === "lunch"), evening: M.filter((x) => x.menu_date === d && x.slot === "evening") } })) };
}
export async function saveDayMenu(inst: string, input: unknown) {
  const dish = z.object({ name: z.string().trim().min(1).max(80), peanuts: z.boolean() }).strict();
  const i = z.object({ date, morning: z.array(dish).max(12), lunch: z.array(dish).max(12), evening: z.array(dish).max(12) }).strict().parse(input);
  check(await supabaseAdmin.from("day_menu_items").delete().eq("institution_id", inst).eq("menu_date", i.date).select("id"));
  const rows = (["morning", "lunch", "evening"] as const).flatMap((slot) => i[slot].map((d, pos) => ({ institution_id: inst, menu_date: i.date, slot, name: d.name, peanuts: d.peanuts, pos })));
  if (rows.length) check(await supabaseAdmin.from("day_menu_items").insert(rows).select("id")); check(await supabaseAdmin.from("day_menu_published").delete().eq("institution_id", inst).eq("week_start", iso(monday(i.date))).select("week_start")); return { ok: true };
}
export async function publishDayMenu(inst: string, input: unknown) {
  const { week_start } = z.object({ week_start: date }).strict().parse(input); const n = (check(await supabaseAdmin.from("day_menu_items").select("id").eq("institution_id", inst).gte("menu_date", week_start).lte("menu_date", iso(new Date(new Date(`${week_start}T00:00:00Z`).getTime() + 6 * 86400000))).limit(1)) as unknown[]).length; if (!n) throw new HttpError(409, "Add the menu first.");
  check(await supabaseAdmin.from("day_menu_published").upsert({ institution_id: inst, week_start }).select("week_start")); return { ok: true };
}

// ═════════════ visitors ═════════════
const PURPOSES = ["Maintenance / service", "Admission enquiry", "Parent meeting", "Official visit", "Interview", "Delivery", "Other"];
const ID_TYPES = ["Aadhaar", "PAN", "Driving licence", "Passport", "Voter ID", "Other"];
export async function visitors(inst: string) {
  return { purposes: PURPOSES, id_types: ID_TYPES, items: check(await supabaseAdmin.from("visitors").select("id, visit_date, name, purpose, details, meeting, id_type, id_last4, in_time, out_time, status").eq("institution_id", inst).order("visit_date", { ascending: false }).order("in_time", { ascending: false, nullsFirst: true }).limit(3000)) as { id: string; visit_date: string; name: string; purpose: string; details: string; meeting: string; id_type: string; id_last4: string; in_time: string | null; out_time: string | null; status: string }[] };
}
export async function addVisitor(inst: string, input: unknown) {
  const i = z.object({ visit_date: date, name: z.string().trim().min(2, "Enter the visitor's name.").max(80), purpose: z.enum(PURPOSES as [string, ...string[]]), details: z.string().trim().max(200).optional(), meeting: z.string().trim().max(80).optional(), id_type: z.enum(ID_TYPES as [string, ...string[]]), id_last4: z.string().regex(/^\d{4}$|^[A-Za-z0-9]{3}$|^$/, "Give the last 4 digits of the ID.").optional(), in_time: hm.nullable().optional(), out_time: hm.nullable().optional() }).strict().parse(input);
  if (i.out_time && !i.in_time) throw new HttpError(400, "Enter the time in as well.");
  if (i.in_time && i.out_time && i.out_time < i.in_time) throw new HttpError(400, "Out must be after in.");
  return check(await supabaseAdmin.from("visitors").insert({ institution_id: inst, visit_date: i.visit_date, name: i.name, purpose: i.purpose, details: i.details ?? "", meeting: i.meeting ?? "", id_type: i.id_type, id_last4: i.id_last4 ?? "", in_time: i.in_time ?? null, out_time: i.out_time ?? null, status: i.out_time ? "Checked out" : i.in_time ? "Checked in" : "Awaiting approval" }).select("id").single());
}
export async function visitorAction(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["verify", "reject", "check_in", "check_out", "cancel"]) }).strict().parse(input);
  if (action === "verify") return upd("visitors", inst, id, { status: "Approved" }, { status: "Awaiting approval" });
  if (action === "reject") return upd("visitors", inst, id, { status: "Rejected" }, { status: "Awaiting approval" });
  if (action === "check_in") return upd("visitors", inst, id, { status: "Checked in", in_time: nowHm() }, { status: "Approved" });
  if (action === "check_out") return upd("visitors", inst, id, { status: "Checked out", out_time: nowHm() }, { status: "Checked in" });
  const v = check(await supabaseAdmin.from("visitors").select("status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { status: string } | null; if (!v) throw new HttpError(404, "Not found."); if (!["Awaiting approval", "Approved"].includes(v.status)) throw new HttpError(409, "Only a pass that has not been used can be cancelled.");
  return upd("visitors", inst, id, { status: "Cancelled" });
}

// ═════════════ gate passes ═════════════
export async function gatePasses(inst: string, kind: string) {
  const k = z.enum(["Student", "Staff"]).parse(kind); const [g, st, sf] = await Promise.all([supabaseAdmin.from("gate_passes").select("id, code, for_kind, name, class_dept, reason, out_at, picked_up_by, pass_date, status").eq("institution_id", inst).eq("for_kind", k).order("pass_date", { ascending: false }).order("code", { ascending: false }).limit(3000), k === "Student" ? enrolled(inst) : Promise.resolve([]), k === "Staff" ? staffList(inst) : Promise.resolve([])]);
  return { people: k === "Student" ? st.slice(0, 3000).map((x) => ({ id: x.id, name: x.name, dept: x.class_label })) : sf.map((x) => ({ id: x.id, name: x.name, dept: x.department })), items: check(g) as { id: string; code: string; for_kind: string; name: string; class_dept: string; reason: string; out_at: string | null; picked_up_by: string; pass_date: string; status: string }[] };
}
export async function addGatePass(inst: string, input: unknown) {
  const i = z.object({ for_kind: z.enum(["Student", "Staff"]), person_id: uid, reason: z.string().trim().min(3, "Give the reason.").max(160), out_at: hm.nullable().optional(), picked_up_by: z.string().trim().max(80).optional(), pass_date: date.optional(), code: z.string().trim().max(12).optional() }).strict().parse(input);
  const p = (await gatePasses(inst, i.for_kind)).people.find((x) => x.id === i.person_id); if (!p) throw new HttpError(404, "Person not found.");
  const pre = i.for_kind === "Student" ? "GP-S-" : "GP-T-"; let code = i.code;
  if (!code) { const ex = (check(await supabaseAdmin.from("gate_passes").select("code").eq("institution_id", inst).eq("for_kind", i.for_kind).like("code", `${pre}%`)) as { code: string }[]).map((x) => Number(x.code.slice(pre.length)) || 0); code = pre + String(Math.max(i.for_kind === "Student" ? 230 : 118, ...ex) + 1).padStart(4, "0"); }
  if ((check(await supabaseAdmin.from("gate_passes").select("id").eq("institution_id", inst).eq("code", code)) as unknown[]).length) throw new HttpError(409, "That pass number is used.");
  return check(await supabaseAdmin.from("gate_passes").insert({ institution_id: inst, code, for_kind: i.for_kind, person_ref: i.person_id, name: p.name, class_dept: p.dept, reason: i.reason, out_at: i.out_at ?? null, picked_up_by: i.picked_up_by ?? "", pass_date: i.pass_date ?? today() }).select("id, code").single());
}
export async function gatePassAction(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["approve", "reject", "left", "returned"]) }).strict().parse(input);
  if (action === "approve") return upd("gate_passes", inst, id, { status: "Expected" }, { status: "Pending approval" }); if (action === "reject") return upd("gate_passes", inst, id, { status: "Rejected" }, { status: "Pending approval" });
  if (action === "left") return upd("gate_passes", inst, id, { status: "Left", out_at: nowHm() }, { status: "Expected" }); return upd("gate_passes", inst, id, { status: "Returned" }, { status: "Left" });
}

// ═════════════ incidents and emergency contacts ═════════════
export async function incidents(inst: string) {
  return { items: check(await supabaseAdmin.from("campus_incidents").select("id, code, what, location, reported_by, incident_date, severity, status").eq("institution_id", inst).order("incident_date", { ascending: false }).order("code", { ascending: false }).limit(3000)) as { id: string; code: string; what: string; location: string; reported_by: string; incident_date: string; severity: string; status: string }[] };
}
export async function addIncident(inst: string, input: unknown) {
  const i = z.object({ what: z.string().trim().min(3, "Say what happened.").max(200), location: z.string().trim().min(2).max(60), reported_by: z.string().trim().min(2).max(80), severity: z.enum(["Low", "Medium", "High"]), incident_date: date.optional() }).strict().parse(input);
  return check(await supabaseAdmin.from("campus_incidents").insert({ institution_id: inst, ...i, incident_date: i.incident_date ?? today() }).select("id, code").single());
}
export async function setIncident(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Open", "Investigating", "Closed"]) }).strict().parse(input); return upd("campus_incidents", inst, id, { status });
}
export async function emergencyContacts(inst: string) {
  if (!(check(await supabaseAdmin.from("emergency_contacts").select("id").eq("institution_id", inst).limit(1)) as unknown[]).length) check(await supabaseAdmin.from("emergency_contacts").insert([["Police", "100"], ["Fire station", "101"], ["Ambulance", "108"]].map(([service, number]) => ({ institution_id: inst, service, number }))).select("id"));
  return { items: check(await supabaseAdmin.from("emergency_contacts").select("id, service, number, distance, status").eq("institution_id", inst).order("service")) as { id: string; service: string; number: string; distance: string; status: string }[] };
}
export async function editContact(inst: string, id: string, input: unknown) {
  const i = z.object({ number: z.string().trim().min(3).max(60), distance: z.string().trim().max(20), status: z.enum(["Not verified", "Verified"]) }).strict().parse(input); return upd("emergency_contacts", inst, id, i);
}

// ═════════════ student health ═════════════
export const VACCINES = ["BCG", "Hepatitis B", "Polio", "MMR", "Typhoid", "Tdap booster"];
export async function health(inst: string) {
  const [st, h, v, u] = await Promise.all([enrolled(inst), supabaseAdmin.from("student_health").select("student_id, blood_group, allergies, conditions, contact1_name, contact1_mobile, contact2_name, contact2_mobile").eq("institution_id", inst).limit(10000), supabaseAdmin.from("student_vaccines").select("student_id, vaccine, status").eq("institution_id", inst).limit(60000), supabaseAdmin.from("parent_health_updates").select("id, code, student_id, parent_name, kind, details, attachment, sent_on, status").eq("institution_id", inst).order("sent_on", { ascending: false }).limit(2000)]);
  const H = new Map((check(h) as { student_id: string; blood_group: string; allergies: string; conditions: string; contact1_name: string; contact1_mobile: string; contact2_name: string; contact2_mobile: string }[]).map((x) => [x.student_id, x])); const V = check(v) as { student_id: string; vaccine: string; status: string }[]; const K = new Map(st.map((x) => [x.id, x]));
  return { vaccines: VACCINES, students: st.slice(0, 2000).map((x) => { const r = H.get(x.id); return { id: x.id, name: x.name, class_label: x.class_label, blood_group: r?.blood_group ?? "", allergies: r?.allergies ?? "", conditions: r?.conditions ?? "", contact1_name: r?.contact1_name ?? "", contact1_mobile: r?.contact1_mobile ?? "", contact2_name: r?.contact2_name ?? "", contact2_mobile: r?.contact2_mobile ?? "", vax: Object.fromEntries(VACCINES.map((n) => [n, V.find((y) => y.student_id === x.id && y.vaccine === n)?.status ?? "Not due"])) as Record<string, string> }; }),
    updates: (check(u) as { id: string; code: string; student_id: string; parent_name: string; kind: string; details: string; attachment: string; sent_on: string; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "" })) };
}
export async function saveHealth(inst: string, studentId: string, input: unknown) {
  const i = z.object({ blood_group: z.enum(["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]), allergies: z.string().trim().max(160), conditions: z.string().trim().max(160), contact1_name: z.string().trim().max(80), contact1_mobile: z.string().trim().max(20), contact2_name: z.string().trim().max(80), contact2_mobile: z.string().trim().max(20) }).strict().parse(input);
  if (!(await enrolled(inst)).some((x) => x.id === studentId)) throw new HttpError(404, "Student not found."); check(await supabaseAdmin.from("student_health").upsert({ student_id: studentId, institution_id: inst, ...i, updated_on: today() }).select("student_id")); return { ok: true };
}
export async function saveVaccines(inst: string, studentId: string, input: unknown) {
  const i = z.object({ vax: z.record(z.string(), z.enum(["Given", "Due", "Not due"])) }).strict().parse(input); const rows = Object.entries(i.vax).filter(([n]) => VACCINES.includes(n)).map(([vaccine, status]) => ({ student_id: studentId, institution_id: inst, vaccine, status }));
  if (!(await enrolled(inst)).some((x) => x.id === studentId)) throw new HttpError(404, "Student not found."); if (rows.length) check(await supabaseAdmin.from("student_vaccines").upsert(rows).select("student_id")); return { ok: true };
}
export async function remindParent(inst: string, studentId: string) {
  const h = (await health(inst)).students.find((x) => x.id === studentId); if (!h) throw new HttpError(404, "Student not found."); const due = VACCINES.filter((n) => h.vax[n] === "Due"); if (!due.length) throw new HttpError(409, "Nothing is due.");
  return check(await supabaseAdmin.from("comm_messages").insert({ institution_id: inst, channel: "In-App", title: `Vaccination due · ${h.name}`, message: `${h.name} is due for: ${due.join(", ")}. Please share the vaccination card.`, audience: "All parents", class_label: h.class_label, recipients: 1 }).select("ref").single());
}
export async function decideHealthUpdate(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["accept", "return"]) }).strict().parse(input); return upd("parent_health_updates", inst, id, { status: action === "accept" ? "Accepted" : "Returned" }, { status: "Pending" });
}

// ═════════════ medical visits and first aid ═════════════
export const COMPLAINTS = ["Headache", "Fever", "Injury", "Allergic reaction", "Vomiting", "Asthma attack", "Stomach ache", "Other"];
export async function medicalVisits(inst: string) {
  const [v, st, sf] = await Promise.all([supabaseAdmin.from("medical_visits").select("id, visit_date, student_id, complaint, treatment, seen_by, in_time, status").eq("institution_id", inst).order("visit_date", { ascending: false }).order("in_time", { ascending: false }).limit(3000), enrolled(inst), staffList(inst)]); const K = new Map(st.map((x) => [x.id, x]));
  return { complaints: COMPLAINTS, staff: sf.map((x) => x.name), students: st.slice(0, 3000).map((x) => ({ id: x.id, name: `${x.name} · ${x.class_label}` })), items: (check(v) as { id: string; visit_date: string; student_id: string; complaint: string; treatment: string; seen_by: string; in_time: string | null; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "" })) };
}
export async function addVisit(inst: string, input: unknown) {
  const i = z.object({ visit_date: date, student_id: uid, complaint: z.enum(COMPLAINTS as [string, ...string[]]), treatment: z.string().trim().min(2, "Say what was done.").max(120), seen_by: z.string().trim().min(2).max(80), in_time: hm.nullable().optional() }).strict().parse(input);
  if (!(await enrolled(inst)).some((x) => x.id === i.student_id)) throw new HttpError(404, "Student not found."); return check(await supabaseAdmin.from("medical_visits").insert({ institution_id: inst, ...i, in_time: i.in_time ?? nowHm() }).select("id").single());
}
export async function setVisit(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Back to class", "Sent home", "Hospital"]) }).strict().parse(input); return upd("medical_visits", inst, id, { status }, { status: "In clinic" });
}
export async function firstAid(inst: string) {
  const [f, st] = await Promise.all([supabaseAdmin.from("first_aid").select("id, code, student_id, what, place, severity, parent_told, incident_date, status").eq("institution_id", inst).order("incident_date", { ascending: false }).order("code", { ascending: false }).limit(3000), enrolled(inst)]); const K = new Map(st.map((x) => [x.id, x]));
  return { students: st.slice(0, 3000).map((x) => ({ id: x.id, name: `${x.name} · ${x.class_label}` })), items: (check(f) as { id: string; code: string; student_id: string; what: string; place: string; severity: string; parent_told: string; incident_date: string; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "" })) };
}
export async function addFirstAid(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, what: z.string().trim().min(3, "Say what happened.").max(160), place: z.string().trim().max(60).optional(), severity: z.enum(["Minor", "Moderate", "Serious"]), parent_told: z.string().trim().max(60).optional(), incident_date: date.optional() }).strict().parse(input);
  if (!(await enrolled(inst)).some((x) => x.id === i.student_id)) throw new HttpError(404, "Student not found."); return check(await supabaseAdmin.from("first_aid").insert({ institution_id: inst, student_id: i.student_id, what: i.what, place: i.place ?? "", severity: i.severity, parent_told: i.parent_told ?? "", incident_date: i.incident_date ?? today() }).select("id, code").single());
}
export async function setFirstAid(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Open", "Follow-up", "Closed"]) }).strict().parse(input); return upd("first_aid", inst, id, { status });
}
