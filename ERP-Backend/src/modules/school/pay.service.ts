import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { directory } from "./hr.service";

/** Payroll, onboarding and probation. Statutory rules: PF 12% of basic capped at ₹1,800; ESI 0.75% up to ₹21,000 gross; professional tax on the Telangana slab. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const monthRe = z.string().regex(/^\d{4}-\d{2}$/, "Choose a month.");
const addMonths = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

// ═════════════ salary heads ═════════════
const HEADS: [string, string, string, string][] = [["Basic pay", "Earning", "Fixed by designation", "Yes"], ["Dearness allowance", "Allowance", "12% of basic", "Yes"], ["House rent allowance", "Allowance", "24% of basic", "Partly"], ["Conveyance allowance", "Allowance", "Fixed ₹1,600", "No"], ["Special allowance", "Allowance", "Balance of the gross", "Yes"], ["Provident fund", "Deduction", "12% of basic, capped at ₹1,800", "—"], ["Employee State Insurance", "Deduction", "0.75% of gross, if gross ≤ ₹21,000", "—"], ["Professional tax", "Deduction", "Telangana slab", "—"], ["Income tax (TDS)", "Deduction", "As per declaration", "—"], ["Advance recovery", "Deduction", "Monthly instalment", "—"], ["Loss of pay", "Deduction", "Gross ÷ 30 a day", "—"]];
export async function heads(inst: string, type?: string) {
  let r = check(await supabaseAdmin.from("pay_heads").select("id, name, htype, calc, taxable, status").eq("institution_id", inst).order("pos")) as { id: string; name: string; htype: string; calc: string; taxable: string; status: string }[];
  if (!r.length) r = check(await supabaseAdmin.from("pay_heads").insert(HEADS.map(([name, htype, calc, taxable]) => ({ institution_id: inst, name, htype, calc, taxable }))).select("id, name, htype, calc, taxable, status")) as typeof r;
  return { items: type ? r.filter((x) => x.htype === type) : r };
}
export async function addHead(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the head.").max(80), htype: z.enum(["Earning", "Allowance", "Deduction"]), calc: z.string().trim().max(120).optional(), taxable: z.enum(["Yes", "No", "Partly", "—"]).optional() }).strict().parse(input);
  await heads(inst);
  const dup = check(await supabaseAdmin.from("pay_heads").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That head exists.");
  return check(await supabaseAdmin.from("pay_heads").insert({ institution_id: inst, name: i.name, htype: i.htype, calc: i.calc ?? "", taxable: i.taxable ?? "Yes" }).select("id").single());
}
export async function setHead(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("pay_heads").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ salary and deductions ═════════════
export const statutory = (gross: number, basic: number, other: number) => { const pf = Math.min(Math.round(basic * 0.12), 1800); const esi = gross > 0 && gross <= 21000 ? Math.round(gross * 0.0075) : 0; const pt = gross > 20000 ? 200 : gross > 15000 ? 150 : 0; return { pf, esi, pt, other, total: pf + esi + pt + other }; };
export async function structures(inst: string) {
  const [d, a, g] = await Promise.all([directory(inst), supabaseAdmin.from("pay_assign").select("staff_id, structure, basic, allow_pct, effective_from, other_ded").eq("institution_id", inst), supabaseAdmin.from("hr_staff").select("profile_id, monthly_salary").eq("institution_id", inst).limit(5000)]);
  const A = new Map((check(a) as { staff_id: string; structure: string; basic: number; allow_pct: number; effective_from: string; other_ded: number }[]).map((x) => [x.staff_id, x]));
  const G = new Map((check(g) as { profile_id: string; monthly_salary: number | null }[]).map((x) => [x.profile_id, x.monthly_salary ?? 0]));
  const items = d.items.map((s) => { const gross = G.get(s.id) ?? 0; const as = A.get(s.id); const basic = as ? as.basic : Math.round(gross * 0.5); const ded = statutory(gross, basic, as?.other_ded ?? 0); return { id: s.id, name: s.name, emp_code: s.emp_code, designation: s.designation, department: s.department, structure: as?.structure ?? s.designation, basic, allowances: Math.max(0, gross - basic), allow_pct: as?.allow_pct ?? (basic ? Math.round(((gross - basic) / basic) * 100) : 0), gross, effective_from: as?.effective_from ?? null, ...ded, deductions: ded.total, net: gross - ded.total }; });
  return { items, staff_count: items.length };
}
export async function assignStructure(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, structure: z.string().trim().max(40).optional(), basic: z.number().int().min(1).max(10_000_000), allow_pct: z.number().int().min(0).max(500), effective_from: date }).strict().parse(input);
  const s = (await directory(inst)).items.find((x) => x.id === i.staff_id); if (!s) throw new HttpError(404, "Staff member not found.");
  const gross = Math.round(i.basic * (1 + i.allow_pct / 100));
  const cur = check(await supabaseAdmin.from("pay_assign").select("other_ded").eq("staff_id", i.staff_id).maybeSingle()) as { other_ded: number } | null;
  check(await supabaseAdmin.from("pay_assign").upsert({ staff_id: i.staff_id, institution_id: inst, structure: i.structure ?? "", basic: i.basic, allow_pct: i.allow_pct, effective_from: i.effective_from, other_ded: cur?.other_ded ?? 0 }, { onConflict: "staff_id" }).select("staff_id"));
  const before = check(await supabaseAdmin.from("hr_staff").select("monthly_salary").eq("profile_id", i.staff_id).maybeSingle()) as { monthly_salary: number | null } | null;
  check(await supabaseAdmin.from("hr_staff").update({ monthly_salary: gross }).eq("profile_id", i.staff_id).eq("institution_id", inst).select("profile_id"));
  if (before?.monthly_salary !== gross) check(await supabaseAdmin.from("hr_salary_history").insert({ institution_id: inst, staff_id: i.staff_id, from_on: i.effective_from, before_amt: before?.monthly_salary ?? null, after_amt: gross, reason: "Salary structure assigned" }).select("id"));
  return { gross };
}
export async function assignEmployee(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, department: z.string().trim().max(60), designation: z.string().trim().max(100), gross: z.number().int().min(1).max(10_000_000), effective_from: date }).strict().parse(input);
  if (!(await directory(inst)).items.some((x) => x.id === i.staff_id)) throw new HttpError(404, "Staff member not found.");
  check(await supabaseAdmin.from("hr_staff").update({ department: i.department }).eq("profile_id", i.staff_id).eq("institution_id", inst).select("profile_id"));
  check(await supabaseAdmin.from("user_profiles").update({ designation: i.designation || null }).eq("id", i.staff_id).eq("institution_id", inst).select("id"));
  return assignStructure(inst, { staff_id: i.staff_id, structure: i.designation, basic: Math.round(i.gross / 2), allow_pct: Math.round(((i.gross - Math.round(i.gross / 2)) / Math.round(i.gross / 2)) * 100), effective_from: i.effective_from });
}
export async function setOtherDeduction(inst: string, id: string, input: unknown) {
  const { amount } = z.object({ amount: z.number().int().min(0).max(10_000_000) }).strict().parse(input);
  const s = (await structures(inst)).items.find((x) => x.id === id); if (!s) throw new HttpError(404, "Staff member not found.");
  check(await supabaseAdmin.from("pay_assign").upsert({ staff_id: id, institution_id: inst, structure: s.structure, basic: s.basic, allow_pct: s.allow_pct, effective_from: s.effective_from ?? today(), other_ded: amount }, { onConflict: "staff_id" }).select("staff_id"));
  return { ok: true };
}

// ═════════════ attendance calculation and runs ═════════════
function workingDays(month: string) { const y = Number(month.slice(0, 4)), m = Number(month.slice(5)) - 1; const n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); let c = 0; for (let d = 1; d <= n; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() !== 0) c++; return c; }
export async function attendanceCalc(inst: string, month: string) {
  monthRe.parse(month); const from = `${month}-01`; const to = addMonths(from, 1);
  const lockRow = check(await supabaseAdmin.from("pay_settings").select("lock_day").eq("institution_id", inst).maybeSingle()) as { lock_day: number } | null; const lockTo = `${month}-${String(Math.min(31, lockRow?.lock_day ?? 25)).padStart(2, "0")}`;
  const [st, att, lv] = await Promise.all([structures(inst), supabaseAdmin.from("staff_attendance").select("staff_id, status").eq("institution_id", inst).gte("att_date", from).lt("att_date", to).lte("att_date", lockTo).limit(100000), supabaseAdmin.from("leave_requests").select("profile_id, days, from_date").eq("institution_id", inst).eq("status", "Approved").gte("from_date", from).lt("from_date", to).limit(50000)]);
  const A = check(att) as { staff_id: string; status: string }[]; const L = check(lv) as { profile_id: string; days: number }[]; const wd = workingDays(month);
  const items = st.items.map((s) => { const mine = A.filter((x) => x.staff_id === s.id); const absent = mine.filter((x) => x.status === "A").length + mine.filter((x) => x.status === "H").length * 0.5; const paid = Math.min(wd, L.filter((x) => x.profile_id === s.id).reduce((n, x) => n + Number(x.days), 0)); const lop = Math.max(0, absent - paid); const present = Math.max(0, wd - lop - paid); const lopAmt = Math.round((s.gross / 30) * lop); return { id: s.id, name: s.name, emp_code: s.emp_code, department: s.department, gross: s.gross, deductions: s.deductions, working_days: wd, present, paid_leave: paid, lop, lop_amount: lopAmt, net: Math.max(0, s.gross - s.deductions - lopAmt) }; });
  return { month, working_days: wd, items };
}
export async function runs(inst: string) {
  const r = check(await supabaseAdmin.from("pay_runs").select("id, month, status, staff, gross, deductions, net").eq("institution_id", inst).order("month", { ascending: false }).limit(60)) as { id: string; month: string; status: string; staff: number; gross: number; deductions: number; net: number }[];
  const cur = today().slice(0, 7); const have = r.some((x) => x.month === cur);
  return { current: cur, items: have ? r : [{ id: "", month: cur, status: "Draft", staff: 0, gross: 0, deductions: 0, net: 0 }, ...r] };
}
export async function calculate(inst: string, input: unknown) {
  const { month } = z.object({ month: monthRe }).strict().parse(input);
  const ex = check(await supabaseAdmin.from("pay_runs").select("id, status").eq("institution_id", inst).eq("month", month).maybeSingle()) as { id: string; status: string } | null;
  if (ex && !["Draft", "Calculated"].includes(ex.status)) throw new HttpError(409, "That payroll is already past calculation.");
  const c = await attendanceCalc(inst, month); const rows = c.items.filter((x) => x.gross > 0);
  if (!rows.length) throw new HttpError(409, "No staff have a salary set. Assign salary structures first.");
  const tot = { staff: rows.length, gross: rows.reduce((n, x) => n + x.gross, 0), deductions: rows.reduce((n, x) => n + x.deductions + x.lop_amount, 0), net: rows.reduce((n, x) => n + x.net, 0) };
  const run = check(await supabaseAdmin.from("pay_runs").upsert({ institution_id: inst, month, status: "Calculated", ...tot, calculated_on: today() }, { onConflict: "institution_id,month" }).select("id").single()) as { id: string };
  check(await supabaseAdmin.from("pay_run_lines").delete().eq("run_id", run.id).select("run_id"));
  check(await supabaseAdmin.from("pay_run_lines").insert(rows.map((x) => ({ run_id: run.id, staff_id: x.id, working_days: x.working_days, present: x.present, paid_leave: x.paid_leave, lop: x.lop, gross: x.gross, deductions: x.deductions + x.lop_amount, net: x.net }))).select("run_id"));
  return { id: run.id, ...tot };
}
export async function runLines(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("pay_runs").select("id, month, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; month: string; status: string } | null;
  if (!r) throw new HttpError(404, "Not found.");
  const [l, st] = await Promise.all([supabaseAdmin.from("pay_run_lines").select("staff_id, working_days, present, paid_leave, lop, gross, deductions, net").eq("run_id", id), directory(inst)]);
  const K = new Map(st.items.map((s) => [s.id, s]));
  return { ...r, items: (check(l) as { staff_id: string; working_days: number; present: number; paid_leave: number; lop: number; gross: number; deductions: number; net: number }[]).map((x) => ({ ...x, name: K.get(x.staff_id)?.name ?? "", emp_code: K.get(x.staff_id)?.emp_code ?? "" })) };
}
export async function payStatus(inst: string) {
  const r = check(await supabaseAdmin.from("pay_runs").select("status").eq("institution_id", inst).eq("month", today().slice(0, 7)).maybeSingle()) as { status: string } | null;
  return r?.status ?? "Draft";
}

// ═════════════ probation ═════════════
export async function probation(inst: string) {
  const [r, st, rv] = await Promise.all([supabaseAdmin.from("hr_probation").select("id, staff_id, started_on, ends_on, reviewer, status, decided_on").eq("institution_id", inst).order("ends_on"), directory(inst), supabaseAdmin.from("hr_appraisals").select("staff_id, rating, status").eq("institution_id", inst).eq("kind", "Reviews").eq("status", "Completed")]);
  const K = new Map(st.items.map((s) => [s.id, s])); const V = check(rv) as { staff_id: string; rating: number | null }[]; const now = today(); const month = now.slice(0, 7);
  const items = (check(r) as { id: string; staff_id: string; started_on: string; ends_on: string; reviewer: string; status: string; decided_on: string | null }[]).map((x) => { const mine = V.filter((y) => y.staff_id === x.staff_id && y.rating); const avg = mine.length ? Math.round((mine.reduce((n, y) => n + (y.rating ?? 0), 0) / mine.length) * 10) / 10 : null; const open = ["On probation", "Extended"].includes(x.status); const due = open && daysBetween(now, x.ends_on) <= 30; return { ...x, name: K.get(x.staff_id)?.name ?? "", detail: [K.get(x.staff_id)?.designation, K.get(x.staff_id)?.department].filter(Boolean).join(" · "), reviews: mine.length, rating: avg, shown: due ? "Due for decision" : x.status }; });
  const weak = items.filter((x) => ["On probation", "Extended"].includes(x.status) && x.rating !== null && x.rating < 3.5)[0];
  return { staff: st.items.map((s) => ({ id: s.id, name: s.name })), items, on: items.filter((x) => ["On probation", "Extended"].includes(x.status)).length, due: items.filter((x) => x.shown === "Due for decision" && x.ends_on.startsWith(month) || (x.shown === "Due for decision" && x.ends_on <= now)).length, confirmed: items.filter((x) => x.status === "Confirmed" && (x.decided_on ?? "").startsWith(now.slice(0, 4))).length, extended: items.filter((x) => x.status === "Extended").length, note: weak ? `${weak.name} scored ${weak.rating} in probation reviews. Extending by 3 months with a mentor is suggested.` : "" };
}
export async function addProbation(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, started_on: date, months: z.number().int().min(1).max(12), reviewer: z.string().trim().max(100).optional() }).strict().parse(input);
  if (!(await directory(inst)).items.some((x) => x.id === i.staff_id)) throw new HttpError(404, "Staff member not found.");
  const open = check(await supabaseAdmin.from("hr_probation").select("id").eq("staff_id", i.staff_id).in("status", ["On probation", "Extended"])) as unknown[];
  if (open.length) throw new HttpError(409, "That person is already on probation.");
  return check(await supabaseAdmin.from("hr_probation").insert({ institution_id: inst, staff_id: i.staff_id, started_on: i.started_on, ends_on: addMonths(i.started_on, i.months), reviewer: i.reviewer ?? "" }).select("id").single());
}
export async function decideProbation(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["confirm", "extend", "end"]) }).strict().parse(input);
  const p = check(await supabaseAdmin.from("hr_probation").select("id, ends_on, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; ends_on: string; status: string } | null;
  if (!p) throw new HttpError(404, "Not found."); if (!["On probation", "Extended"].includes(p.status)) throw new HttpError(409, "That was already decided.");
  const row = action === "extend" ? { status: "Extended", ends_on: addMonths(p.ends_on, 3) } : { status: action === "confirm" ? "Confirmed" : "Ended", decided_on: today() };
  check(await supabaseAdmin.from("hr_probation").update(row).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ onboarding ═════════════
export const ITEMS: [string, string, string][] = [["certs", "Original certificates checked", "HR"], ["ids", "Aadhaar, PAN and bank details", "HR"], ["letter", "Appointment letter signed", "HR"], ["empid", "Employee ID created", "HR"], ["bio", "Biometric and face enrolled", "IT"], ["email", "School email and portal login", "IT"], ["idcard", "ID card printed", "Front office"], ["salary", "Salary structure and PF / ESI", "HR and finance"], ["induction", "Induction: school policies", "Principal's office"], ["pocso", "Child protection (POCSO) training", "Counsellor"], ["buddy", "Buddy teacher assigned", "HOD"], ["timetable", "Timetable and classes allotted", "Academic coordinator"]];
export async function joiners(inst: string) {
  const [c, o, done, chk] = await Promise.all([supabaseAdmin.from("hr_candidates").select("id, name, op:opening_id(position)").eq("institution_id", inst).eq("stage", "Accepted"), supabaseAdmin.from("hr_offers").select("candidate_id, joining_on").eq("institution_id", inst).eq("status", "Accepted"), supabaseAdmin.from("hr_onboard").select("candidate_id, item_key"), supabaseAdmin.from("hr_checks").select("candidate_id, employer, refs, police, certificates, id_address").eq("institution_id", inst)]);
  const O = new Map((check(o) as { candidate_id: string; joining_on: string }[]).map((x) => [x.candidate_id, x.joining_on])); const D = check(done) as { candidate_id: string; item_key: string }[]; const K = new Map((check(chk) as { candidate_id: string; employer: boolean; refs: boolean; police: boolean; certificates: boolean; id_address: boolean }[]).map((x) => [x.candidate_id, x]));
  return { items_def: ITEMS.map(([key, label, owner]) => ({ key, label, owner })), items: (check(c) as unknown as { id: string; name: string; op: { position: string } | { position: string }[] | null }[]).map((x) => { const mine = D.filter((d) => d.candidate_id === x.id).map((d) => d.item_key); const k = K.get(x.id); const all = k ? k.employer && k.refs && k.police && k.certificates && k.id_address : false; const p = Array.isArray(x.op) ? x.op[0]?.position : x.op?.position; return { id: x.id, name: x.name, position: p ?? "", joining_on: O.get(x.id) ?? null, done: mine, count: mine.length, total: ITEMS.length, background: all ? "Verified" : "In progress", status: mine.length === ITEMS.length ? "Ready" : "Joining" }; }) };
}
export async function tick(inst: string, id: string, input: unknown) {
  const i = z.object({ item: z.enum(ITEMS.map((x) => x[0]) as [string, ...string[]]), done: z.boolean() }).strict().parse(input);
  if (!check(await supabaseAdmin.from("hr_candidates").select("id").eq("id", id).eq("institution_id", inst).eq("stage", "Accepted").maybeSingle())) throw new HttpError(404, "Joiner not found.");
  if (i.done) check(await supabaseAdmin.from("hr_onboard").upsert({ candidate_id: id, item_key: i.item }, { onConflict: "candidate_id,item_key" }).select("candidate_id")); else check(await supabaseAdmin.from("hr_onboard").delete().eq("candidate_id", id).eq("item_key", i.item).select("candidate_id"));
  return { ok: true };
}
