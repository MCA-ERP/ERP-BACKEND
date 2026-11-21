import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { directory } from "./hr.service";
import { yearStart } from "./fees.service";

/** HR, part 3: leave types, policy, approvals, balances, comp-offs, staff documents and staff performance. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
async function staffMap(inst: string) { return new Map((await directory(inst)).items.map((s) => [s.id, s])); }
const round1 = (n: number) => Math.round(n * 10) / 10;

// ═════════════ leave types and policy ═════════════
const TYPES: [string, number, string, string][] = [["Casual leave", 12, "No", "No"], ["Sick leave", 10, "Up to 20", "After 2 days"], ["Earned leave", 15, "Up to 45", "No"], ["Maternity leave", 182, "No", "Medical certificate"], ["Paternity leave", 15, "No", "No"], ["Loss of pay", 0, "No", "No"]];
const CORE: Record<string, string> = { "Casual leave": "Casual", "Sick leave": "Sick", "Earned leave": "Earned" };
export async function leaveTypes(inst: string) {
  let r = check(await supabaseAdmin.from("hr_leave_types").select("id, name, days_per_year, carry_forward, needs_proof, status").eq("institution_id", inst).order("name")) as { id: string; name: string; days_per_year: number; carry_forward: string; needs_proof: string; status: string }[];
  if (!r.length) { r = check(await supabaseAdmin.from("hr_leave_types").insert(TYPES.map(([name, d, c, p]) => ({ institution_id: inst, name, days_per_year: d, carry_forward: c, needs_proof: p }))).select("id, name, days_per_year, carry_forward, needs_proof, status")) as typeof r; }
  const order = TYPES.map((t) => t[0]);
  return { items: r.sort((a, b) => (order.indexOf(a.name) + 99) % 99 - (order.indexOf(b.name) + 99) % 99 || a.name.localeCompare(b.name)) };
}
export async function addLeaveType(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the leave type.").max(60), days_per_year: z.number().int().min(0).max(366), carry_forward: z.string().trim().max(40).optional(), needs_proof: z.string().trim().max(40).optional() }).strict().parse(input);
  await leaveTypes(inst);
  const dup = check(await supabaseAdmin.from("hr_leave_types").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That leave type exists.");
  return check(await supabaseAdmin.from("hr_leave_types").insert({ institution_id: inst, name: i.name, days_per_year: i.days_per_year, carry_forward: i.carry_forward || "No", needs_proof: i.needs_proof || "No" }).select("id").single());
}
export async function setLeaveType(inst: string, id: string, input: unknown) {
  const i = z.object({ days_per_year: z.number().int().min(0).max(366).optional(), carry_forward: z.string().trim().max(40).optional(), needs_proof: z.string().trim().max(40).optional(), status: z.enum(["Active", "Inactive"]).optional() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hr_leave_types").update(i).eq("id", id).eq("institution_id", inst).select("name, days_per_year")) as { name: string; days_per_year: number }[];
  if (!r.length) throw new HttpError(404, "Not found.");
  const core = CORE[r[0].name]; // keep the days staff can apply for in step with the type
  if (core && i.days_per_year !== undefined) check(await supabaseAdmin.from("leave_policies").update({ allowed_days: i.days_per_year }).eq("institution_id", inst).eq("leave_type", core).select("leave_type"));
  return { ok: true };
}
const POLICY = { sandwich: ["For casual leave only", "For all leave", "Not applied"], half_day: ["Casual and sick leave", "Casual leave only", "Not allowed"], probation: ["Casual leave after 3 months", "No leave", "All leave allowed"], runout: ["Loss of pay", "Not allowed"] } as const;
export async function leavePolicy(inst: string) {
  const p = check(await supabaseAdmin.from("hr_leave_policy").select("sandwich, half_day, medical_days, earned_notice, carry_forward, encash_year, encash_exit, compoff_days, probation, runout").eq("institution_id", inst).maybeSingle()) as Record<string, string | number> | null;
  return { options: POLICY, ...(p ?? { sandwich: POLICY.sandwich[0], half_day: POLICY.half_day[0], medical_days: 2, earned_notice: 7, carry_forward: 45, encash_year: 10, encash_exit: 45, compoff_days: 60, probation: POLICY.probation[0], runout: POLICY.runout[0] }) } as { options: typeof POLICY; sandwich: string; half_day: string; medical_days: number; earned_notice: number; carry_forward: number; encash_year: number; encash_exit: number; compoff_days: number; probation: string; runout: string };
}
export async function saveLeavePolicy(inst: string, input: unknown) {
  const n = (max: number) => z.number().int().min(0).max(max);
  const i = z.object({ sandwich: z.enum(POLICY.sandwich), half_day: z.enum(POLICY.half_day), medical_days: n(60), earned_notice: n(90), carry_forward: n(365), encash_year: n(365), encash_exit: n(365), compoff_days: z.number().int().min(1).max(365), probation: z.enum(POLICY.probation), runout: z.enum(POLICY.runout) }).strict().parse(input);
  check(await supabaseAdmin.from("hr_leave_policy").upsert({ institution_id: inst, ...i }, { onConflict: "institution_id" }).select("institution_id"));
  return leavePolicy(inst);
}

// ═════════════ approvals: a short chain with time limits ═════════════
const LEVELS = ["HOD or coordinator", "Vice principal", "Principal"]; const SHORT = ["HOD", "Vice principal", "Principal"]; const LIMIT_H = [24, 48, 72];
const needed = (days: number) => (days <= 2 ? 1 : days <= 5 ? 2 : 3);
export async function leaveApprovals(inst: string) {
  const [rows, st] = await Promise.all([supabaseAdmin.from("leave_requests").select("id, code, profile_id, leave_type, from_date, days, level, level_since, created_at").eq("institution_id", inst).eq("status", "Pending").order("created_at").limit(1000), staffMap(inst)]);
  const now = Date.now(); const R = check(rows) as { id: string; code: string; profile_id: string; leave_type: string; from_date: string; days: number; level: number; level_since: string; created_at: string }[];
  for (const r of R) if (r.level < 3 && now - Date.parse(r.level_since) > LIMIT_H[r.level - 1] * 3600000) { r.level += 1; r.level_since = new Date().toISOString(); check(await supabaseAdmin.from("leave_requests").update({ level: r.level, level_since: r.level_since }).eq("id", r.id).select("id")); }
  const items = R.map((r) => { const hrs = Math.floor((now - Date.parse(r.level_since)) / 3600000); const need = Math.max(needed(Number(r.days)), r.level); return { id: r.id, code: r.code, employee: st.get(r.profile_id)?.name ?? "", detail: [st.get(r.profile_id)?.designation, st.get(r.profile_id)?.department].filter(Boolean).join(" · "), leave: `${r.leave_type} leave`, from: r.from_date, days: Number(r.days), route: SHORT.slice(0, need), level: r.level, waiting: hrs < 48 ? `${hrs} h` : `${Math.floor(hrs / 24)} d`, overdue: hrs > LIMIT_H[r.level - 1] * 0.75, status: `With ${SHORT[r.level - 1]}` }; });
  return { levels: LEVELS.map((label, i) => ({ label: `Level ${i + 1} · ${label}`, count: items.filter((x) => x.level === i + 1).length, overdue: items.filter((x) => x.level === i + 1 && x.overdue).length })), items };
}
export async function decideLeaveStep(inst: string, id: string, input: unknown, role: string, actor?: string) {
  const { action } = z.object({ action: z.enum(["approve", "send_back"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("leave_requests").select("id, days, level, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; days: number; level: number; status: string } | null;
  if (!r) throw new HttpError(404, "Not found."); if (r.status !== "Pending") throw new HttpError(409, "That was already decided.");
  const allowed = r.level >= 3 ? ["Principal", "InstitutionAdmin"] : ["VicePrincipal", "Principal", "InstitutionAdmin"];
  if (!allowed.includes(role)) throw new HttpError(403, `Only the ${SHORT[r.level - 1].toLowerCase()} can decide this leave now.`);
  const need = needed(Number(r.days));
  if (action === "send_back") check(await supabaseAdmin.from("leave_requests").update({ status: "Rejected", decided_by: actor ?? null, decided_at: new Date().toISOString() }).eq("id", id).select("id"));
  else if (r.level >= need) check(await supabaseAdmin.from("leave_requests").update({ status: "Approved", decided_by: actor ?? null, decided_at: new Date().toISOString() }).eq("id", id).select("id"));
  else check(await supabaseAdmin.from("leave_requests").update({ level: r.level + 1, level_since: new Date().toISOString() }).eq("id", id).select("id"));
  return { ok: true };
}

// ═════════════ balances and comp-offs ═════════════
export async function leaveBalance(inst: string) {
  const ys = await yearStart(inst);
  const [st, types, reqs] = await Promise.all([directory(inst), leaveTypes(inst), supabaseAdmin.from("leave_requests").select("profile_id, leave_type, days").eq("institution_id", inst).eq("status", "Approved").gte("from_date", ys).limit(50000)]);
  const R = check(reqs) as { profile_id: string; leave_type: string; days: number }[];
  const days = (name: string) => types.items.find((t) => t.name === name)?.days_per_year ?? 0;
  const calc = (id: string, name: string, core: string) => { const allowed = days(name); const used = R.filter((x) => x.profile_id === id && x.leave_type === core).reduce((n, x) => n + Number(x.days), 0); return { allowed, used, left: Math.max(0, allowed - used) }; };
  return { year: ys.slice(0, 4), items: st.items.map((s) => { const casual = calc(s.id, "Casual leave", "Casual"), sick = calc(s.id, "Sick leave", "Sick"), earned = calc(s.id, "Earned leave", "Earned"); return { id: s.id, name: s.name, designation: s.designation, department: s.department, casual, sick, earned, total_left: casual.left + sick.left + earned.left }; }) };
}
export async function compOffs(inst: string) {
  const now = today();
  check(await supabaseAdmin.from("comp_offs").update({ status: "Expired" }).eq("institution_id", inst).eq("status", "Available").lt("use_by", now).select("id"));
  const [r, st] = await Promise.all([supabaseAdmin.from("comp_offs").select("id, profile_id, worked_on, reason, use_by, status").eq("institution_id", inst).order("worked_on", { ascending: false }).limit(1000), staffMap(inst)]);
  return { staff: [...st.values()].map((s) => ({ id: s.id, name: s.name })), items: (check(r) as { id: string; profile_id: string; worked_on: string; reason: string; use_by: string; status: string }[]).map((x) => ({ ...x, employee: st.get(x.profile_id)?.name ?? "" })) };
}
export async function grantCompOff(inst: string, input: unknown) {
  const i = z.object({ profile_id: uid, worked_on: date, reason: z.string().trim().min(2, "Give the reason.").max(200) }).strict().parse(input);
  if (!(await staffMap(inst)).has(i.profile_id)) throw new HttpError(404, "Staff member not found.");
  if (i.worked_on > today()) throw new HttpError(400, "That date is in the future.");
  const p = await leavePolicy(inst);
  return check(await supabaseAdmin.from("comp_offs").insert({ institution_id: inst, profile_id: i.profile_id, worked_on: i.worked_on, reason: i.reason, use_by: addDays(i.worked_on, p.compoff_days) }).select("id").single());
}
export async function useCompOff(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("comp_offs").update({ status: "Used" }).eq("id", id).eq("institution_id", inst).eq("status", "Available").select("id")) as unknown[];
  if (!r.length) throw new HttpError(409, "That comp-off can't be used."); return { ok: true };
}

// ═════════════ staff documents ═════════════
const DOC = ["Certificates", "ID proof", "Contracts"] as const;
export async function documents(inst: string, type: string) {
  const t = z.enum(DOC).parse(type); const now = today();
  const [r, st] = await Promise.all([supabaseAdmin.from("hr_documents").select("id, staff_id, doc_type, file_name, uploaded_on, valid_until, status").eq("institution_id", inst).eq("doc_type", t).order("uploaded_on", { ascending: false }).limit(2000), staffMap(inst)]);
  return { staff: [...st.values()].map((s) => ({ id: s.id, name: s.name })), items: (check(r) as { id: string; staff_id: string; doc_type: string; file_name: string; uploaded_on: string; valid_until: string | null; status: string }[]).map((x) => ({ ...x, staff: st.get(x.staff_id)?.name ?? "", status: x.valid_until && x.valid_until < now ? "Expired" : x.status })) };
}
export async function addDocument(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, doc_type: z.enum(DOC), file_name: z.string().trim().min(2, "Enter the file name.").max(160), valid_until: date.nullable().optional() }).strict().parse(input);
  if (!(await staffMap(inst)).has(i.staff_id)) throw new HttpError(404, "Staff member not found.");
  return check(await supabaseAdmin.from("hr_documents").insert({ institution_id: inst, ...i, valid_until: i.valid_until ?? null, uploaded_on: today() }).select("id").single());
}
export async function verifyDocument(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("hr_documents").update({ status: "Verified" }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ staff performance ═════════════
async function cycleName(inst: string) { const y = Number(Date.parse((await yearStart(inst)) + "T00:00:00Z") ? (await yearStart(inst)).slice(0, 4) : new Date().getFullYear()); return `${y}-${String(y + 1).slice(2)}`; }
export async function appraisals(inst: string, kind: string) {
  const k = z.enum(["Appraisals", "Reviews", "Ratings"]).parse(kind);
  const [r, st] = await Promise.all([supabaseAdmin.from("hr_appraisals").select("id, staff_id, kind, reviewer, period, rating, remarks, status").eq("institution_id", inst).eq("kind", k).order("period", { ascending: false }).limit(2000), staffMap(inst)]);
  return { staff: [...st.values()].map((s) => ({ id: s.id, name: s.name })), items: (check(r) as { id: string; staff_id: string; kind: string; reviewer: string; period: string; rating: number | null; remarks: string; status: string }[]).map((x) => ({ ...x, staff: st.get(x.staff_id)?.name ?? "" })) };
}
export async function addAppraisal(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, kind: z.enum(["Appraisals", "Reviews", "Ratings"]), reviewer: z.string().trim().max(100).optional(), period: z.string().trim().min(2, "Enter the period.").max(30), rating: z.number().int().min(1).max(5).nullable().optional(), remarks: z.string().trim().max(200).optional() }).strict().parse(input);
  if (!(await staffMap(inst)).has(i.staff_id)) throw new HttpError(404, "Staff member not found.");
  return check(await supabaseAdmin.from("hr_appraisals").insert({ institution_id: inst, ...i, rating: i.rating ?? null, reviewer: i.reviewer ?? "", remarks: i.remarks ?? "" }).select("id").single());
}
export async function updateAppraisal(inst: string, id: string, input: unknown) {
  const i = z.object({ status: z.enum(["Scheduled", "In progress", "Completed"]).optional(), rating: z.number().int().min(1).max(5).nullable().optional(), remarks: z.string().trim().max(200).optional() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hr_appraisals").update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
const W360 = { self: 0.1, peers: 0.2, hod: 0.3, students: 0.25, parents: 0.15 };
export async function feedback360(inst: string) {
  const cyc = await cycleName(inst);
  const [st, r] = await Promise.all([directory(inst), supabaseAdmin.from("hr_feedback360").select("staff_id, self_score, peers, hod, students, parents, students_n, parents_n").eq("institution_id", inst).eq("cycle", cyc)]);
  const F = new Map((check(r) as { staff_id: string; self_score: number | null; peers: number | null; hod: number | null; students: number | null; parents: number | null; students_n: number; parents_n: number }[]).map((x) => [x.staff_id, x]));
  const items = st.items.filter((s) => s.type === "Teaching").map((s) => { const f = F.get(s.id); const v = [f?.self_score, f?.peers, f?.hod, f?.students, f?.parents].map((x) => (x === null || x === undefined ? null : Number(x))); const complete = v.every((x) => x !== null); const score = complete ? round1((v[0]! * W360.self + v[1]! * W360.peers + v[2]! * W360.hod + v[3]! * W360.students + v[4]! * W360.parents) * 100) / 100 : null; return { id: s.id, name: s.name, department: s.department, self: v[0], peers: v[1], hod: v[2], students: v[3], parents: v[4], students_n: f?.students_n ?? 0, parents_n: f?.parents_n ?? 0, score: complete ? Math.round((v[0]! * W360.self + v[1]! * W360.peers + v[2]! * W360.hod + v[3]! * W360.students + v[4]! * W360.parents) * 100) / 100 : null, status: complete ? "Complete" : "Collecting" }; });
  void round1;
  return { cycle: cyc, items };
}
export async function saveFeedback360(inst: string, staffId: string, input: unknown) {
  const s = z.number().min(0).max(5).nullable().optional(); const n = z.number().int().min(0).max(100000).optional();
  const i = z.object({ self: s, peers: s, hod: s, students: s, parents: s, students_n: n, parents_n: n }).strict().parse(input);
  const t = (await directory(inst)).items.find((x) => x.id === staffId); if (!t) throw new HttpError(404, "Staff member not found.");
  const row: Record<string, unknown> = { institution_id: inst, staff_id: staffId, cycle: await cycleName(inst) };
  if (i.self !== undefined) row.self_score = i.self; for (const k of ["peers", "hod", "students", "parents", "students_n", "parents_n"] as const) if (i[k] !== undefined) row[k] = i[k];
  check(await supabaseAdmin.from("hr_feedback360").upsert(row, { onConflict: "institution_id,staff_id,cycle" }).select("staff_id"));
  return { ok: true };
}
export const COMPETENCIES: [string, number, string][] = [["Subject knowledge", 5, "Subject refresher with the HOD"], ["Lesson planning", 4, "Lesson-planning workshop"], ["Classroom management", 4, "Positive discipline (CBSE CBP)"], ["Assessment and feedback", 4, "Competency-based assessment (CBSE CBP)"], ["Use of technology", 4, "Digital classroom training"], ["Communication with parents", 4, "Parent communication workshop"], ["Teamwork", 4, "Peer observation pairing"], ["Professional development", 4, "Annual 50-hour CPD plan"]];
export async function competency(inst: string, staffId: string) {
  if (!(await staffMap(inst)).has(staffId)) throw new HttpError(404, "Staff member not found.");
  const r = check(await supabaseAdmin.from("hr_competency").select("competency, level").eq("institution_id", inst).eq("staff_id", staffId)) as { competency: string; level: number }[];
  return { items: COMPETENCIES.map(([name, expected, training]) => { const level = r.find((x) => x.competency === name)?.level ?? 0; return { name, expected, level, gap: level > 0 ? Math.max(0, expected - level) : null, training: level > 0 && level < expected ? training : "" }; }) };
}
export async function saveCompetency(inst: string, staffId: string, input: unknown) {
  const i = z.object({ competency: z.enum(COMPETENCIES.map((c) => c[0]) as [string, ...string[]]), level: z.number().int().min(1).max(5) }).strict().parse(input);
  if (!(await staffMap(inst)).has(staffId)) throw new HttpError(404, "Staff member not found.");
  check(await supabaseAdmin.from("hr_competency").upsert({ institution_id: inst, staff_id: staffId, competency: i.competency, level: i.level }, { onConflict: "institution_id,staff_id,competency" }).select("staff_id"));
  return { ok: true };
}
const BANDS: { from: number; band: string; inc: number }[] = [{ from: 4.3, band: "Outstanding", inc: 10 }, { from: 3.9, band: "Exceeds expectations", inc: 8 }, { from: 3.4, band: "Meets expectations", inc: 6 }, { from: 3.0, band: "Partly meets", inc: 3 }, { from: 0, band: "Below expectations", inc: 0 }];
export const bandOf = (score: number) => BANDS.find((b) => score >= b.from)!;
export async function cycle(inst: string) {
  const cyc = await cycleName(inst);
  const [st, r] = await Promise.all([directory(inst), supabaseAdmin.from("hr_cycle").select("staff_id, reviewer, self_score, reviewer_score, closed").eq("institution_id", inst).eq("cycle", cyc)]);
  const C = new Map((check(r) as { staff_id: string; reviewer: string; self_score: number | null; reviewer_score: number | null; closed: boolean }[]).map((x) => [x.staff_id, x]));
  const items = st.items.filter((s) => C.has(s.id)).map((s) => { const c = C.get(s.id)!; const self = c.self_score === null ? null : Number(c.self_score); const rev = c.reviewer_score === null ? null : Number(c.reviewer_score); const final = self !== null && rev !== null ? Math.round((self * 0.3 + rev * 0.7) * 100) / 100 : null; const b = final !== null ? bandOf(final) : null; return { id: s.id, name: s.name, role: s.type === "Teaching" ? "Teacher" : s.designation || "Staff", type: s.type, reviewer: c.reviewer, self, reviewer_score: rev, final, band: b?.band ?? "", inc: b?.inc ?? null, status: c.closed ? "Closed" : self === null ? "Self-review pending" : rev === null ? "Reviewer pending" : "Moderation" }; });
  const pct = (n: number) => (items.length ? Math.round((n / items.length) * 100) : 0); const fin = items.filter((x) => x.final !== null);
  return { cycle: cyc, started: items.length > 0, items, teaching: items.filter((x) => x.type === "Teaching").length, non_teaching: items.filter((x) => x.type !== "Teaching").length, self_pct: pct(items.filter((x) => x.self !== null).length), reviewer_pct: pct(items.filter((x) => x.reviewer_score !== null).length), avg: fin.length ? Math.round((fin.reduce((n, x) => n + (x.final ?? 0), 0) / fin.length) * 10) / 10 : 0 };
}
export async function startCycle(inst: string, actorName: string) {
  const cyc = await cycleName(inst); const st = await directory(inst);
  const have = new Set((check(await supabaseAdmin.from("hr_cycle").select("staff_id").eq("institution_id", inst).eq("cycle", cyc)) as { staff_id: string }[]).map((x) => x.staff_id));
  const rows = st.items.filter((s) => !have.has(s.id)).map((s) => ({ institution_id: inst, staff_id: s.id, cycle: cyc, reviewer: actorName }));
  if (rows.length) check(await supabaseAdmin.from("hr_cycle").insert(rows).select("staff_id"));
  return { added: rows.length };
}
export async function scoreCycle(inst: string, staffId: string, input: unknown) {
  const i = z.object({ self: z.number().min(0).max(5).optional(), reviewer: z.number().min(0).max(5).optional(), reviewer_name: z.string().trim().max(100).optional(), close: z.boolean().optional() }).strict().parse(input);
  const cyc = await cycleName(inst);
  const c = check(await supabaseAdmin.from("hr_cycle").select("staff_id, self_score, reviewer_score, closed").eq("institution_id", inst).eq("staff_id", staffId).eq("cycle", cyc).maybeSingle()) as { self_score: number | null; reviewer_score: number | null; closed: boolean } | null;
  if (!c) throw new HttpError(404, "Start the cycle first."); if (c.closed) throw new HttpError(409, "That appraisal is closed.");
  const row: Record<string, unknown> = {}; if (i.self !== undefined) row.self_score = i.self; if (i.reviewer !== undefined) row.reviewer_score = i.reviewer; if (i.reviewer_name) row.reviewer = i.reviewer_name;
  if (i.close) { if ((i.self ?? c.self_score) === null || (i.reviewer ?? c.reviewer_score) === null) throw new HttpError(409, "Both scores are needed before closing."); row.closed = true; }
  if (Object.keys(row).length) check(await supabaseAdmin.from("hr_cycle").update(row).eq("institution_id", inst).eq("staff_id", staffId).eq("cycle", cyc).select("staff_id"));
  return { ok: true };
}
export async function increments(inst: string) {
  const cyc = await cycleName(inst);
  const [st, cy, fb, comp, set] = await Promise.all([directory(inst), cycle(inst), feedback360(inst), supabaseAdmin.from("hr_competency").select("staff_id, level").eq("institution_id", inst), supabaseAdmin.from("hr_perf_settings").select("increment_budget").eq("institution_id", inst).maybeSingle()]);
  const sal = new Map((check(await supabaseAdmin.from("hr_staff").select("profile_id, monthly_salary").eq("institution_id", inst).limit(5000)) as { profile_id: string; monthly_salary: number | null }[]).map((x) => [x.profile_id, x.monthly_salary ?? 0]));
  const saved = new Map((check(await supabaseAdmin.from("hr_cycle").select("staff_id, inc_pct, inc_sent").eq("institution_id", inst).eq("cycle", cyc)) as { staff_id: string; inc_pct: number | null; inc_sent: boolean }[]).map((x) => [x.staff_id, x]));
  const C = check(comp) as { staff_id: string; level: number }[]; const budgetPct = Number((check(set) as { increment_budget: number } | null)?.increment_budget ?? 7.2);
  const items = st.items.filter((s) => s.type === "Teaching").map((s) => {
    const kra = cy.items.find((x) => x.id === s.id)?.final ?? 0; const f = fb.items.find((x) => x.id === s.id)?.score ?? 0; const cl = C.filter((x) => x.staff_id === s.id); const cs = cl.length ? cl.reduce((n, x) => n + x.level, 0) / cl.length : 0;
    const combined = Math.round((kra * 0.5 + f * 0.3 + cs * 0.2) * 100) / 100; const b = bandOf(combined); const inc = saved.get(s.id)?.inc_pct ?? b.inc; const salary = sal.get(s.id) ?? 0;
    return { id: s.id, name: s.name, kra, feedback: f, competency: Math.round(cs * 10) / 10, combined, band: b.band, inc, salary, new_salary: Math.round(salary * (1 + inc / 100)), cost: Math.round(salary * (inc / 100)), sent: saved.get(s.id)?.inc_sent ?? false };
  });
  const payroll = items.reduce((n, x) => n + x.salary, 0); const cost = items.reduce((n, x) => n + x.cost, 0); const budget = Math.round(payroll * (budgetPct / 100));
  return { cycle: cyc, bands: BANDS, budget_pct: budgetPct, items, cost, budget, over: Math.max(0, cost - budget) };
}
export async function saveIncrement(inst: string, staffId: string, input: unknown) {
  const { inc_pct } = z.object({ inc_pct: z.number().int().min(0).max(50) }).strict().parse(input);
  const cyc = await cycleName(inst);
  check(await supabaseAdmin.from("hr_cycle").upsert({ institution_id: inst, staff_id: staffId, cycle: cyc, inc_pct }, { onConflict: "institution_id,staff_id,cycle" }).select("staff_id"));
  return { ok: true };
}
export async function sendIncrements(inst: string) {
  const r = await increments(inst); const cyc = r.cycle;
  if (r.over > 0) throw new HttpError(409, `The increments are ₹${r.over.toLocaleString("en-IN")} over the budget. Trim them before sending.`);
  if (!r.items.length) throw new HttpError(409, "There are no teachers to send.");
  check(await supabaseAdmin.from("hr_cycle").upsert(r.items.map((x) => ({ institution_id: inst, staff_id: x.id, cycle: cyc, inc_pct: x.inc, inc_sent: true })), { onConflict: "institution_id,staff_id,cycle" }).select("staff_id"));
  return { sent: r.items.length };
}
const GROUPS = ["Teacher", "Non-teaching", "Driver"] as const;
const KRA_DEFAULT: [string, number, string][] = [["Academic results", 30, "Class average vs target; % above 75 in board / term exams"], ["Quality of teaching", 25, "Two classroom observations by HOD; lesson plans on time"], ["Student and parent feedback", 15, "Term feedback survey score; PTM concerns resolved"], ["Professional development", 10, "20 hours of CPD (CBSE requires 50 over the year); peer sessions"], ["Co-curricular and duties", 10, "Clubs, events, exam duties done"], ["Punctuality and attendance", 10, "Late marks, leave without notice, register submitted on time"]];
export async function kras(inst: string, group: string) {
  const g = z.enum(GROUPS).parse(group);
  let r = check(await supabaseAdmin.from("hr_kras").select("id, area, weight, measure").eq("institution_id", inst)) as { id: string; area: string; weight: number; measure: string; grp?: string }[];
  const all = check(await supabaseAdmin.from("hr_kras").select("id, grp, area, weight, measure").eq("institution_id", inst).order("weight", { ascending: false })) as { id: string; grp: string; area: string; weight: number; measure: string }[];
  void r;
  if (g === "Teacher" && !all.some((x) => x.grp === "Teacher")) { check(await supabaseAdmin.from("hr_kras").insert(KRA_DEFAULT.map(([area, weight, measure]) => ({ institution_id: inst, grp: "Teacher", area, weight, measure }))).select("id")); return kras(inst, group); }
  const items = all.filter((x) => x.grp === g); r = [];
  return { items, total: items.reduce((n, x) => n + x.weight, 0) };
}
export async function addKra(inst: string, input: unknown) {
  const i = z.object({ grp: z.enum(GROUPS), area: z.string().trim().min(2, "Enter the area.").max(100), weight: z.number().int().min(1).max(100), measure: z.string().trim().max(240).optional() }).strict().parse(input);
  const cur = await kras(inst, i.grp);
  if (cur.total + i.weight > 100) throw new HttpError(400, `The weights would add up to ${cur.total + i.weight}. They must add up to 100.`);
  const dup = check(await supabaseAdmin.from("hr_kras").select("id").eq("institution_id", inst).eq("grp", i.grp).ilike("area", i.area)) as unknown[];
  if (dup.length) throw new HttpError(409, "That area exists.");
  return check(await supabaseAdmin.from("hr_kras").insert({ institution_id: inst, grp: i.grp, area: i.area, weight: i.weight, measure: i.measure ?? "" }).select("id").single());
}
export async function removeKra(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("hr_kras").delete().eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
void one;
