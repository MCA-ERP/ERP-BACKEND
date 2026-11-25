import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { attendanceCalc, statutory, structures } from "./pay.service";

/** Payroll, part 2: approval, payslips, salary payments, reports, settings, bank and statutory files; transport vehicles. */
const uid = z.string().uuid();
const monthRe = z.string().regex(/^\d{4}-\d{2}$/, "Choose a month.");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).toISOString().slice(0, 10);

// ═════════════ approval ═════════════
async function run(inst: string, month: string) {
  return check(await supabaseAdmin.from("pay_runs").select("id, month, status, staff, gross, deductions, net, payslips_on, paid_on").eq("institution_id", inst).eq("month", month).maybeSingle()) as { id: string; month: string; status: string; staff: number; gross: number; deductions: number; net: number; payslips_on: string | null; paid_on: string | null } | null;
}
async function log(inst: string, month: string, step: string, who: string, note?: string) { check(await supabaseAdmin.from("pay_events").insert({ institution_id: inst, month, step, by_name: who, note: note ?? null }).select("id")); }
export async function approval(inst: string) {
  const cur = today().slice(0, 7);
  const [r, all] = await Promise.all([run(inst, cur), supabaseAdmin.from("pay_runs").select("id, month, status, staff, gross, deductions, net").eq("institution_id", inst).lt("month", cur).order("month", { ascending: false }).limit(24)]);
  const status = r?.status ?? "Draft"; const step = ["Calculated", "Verified", "Approved", "Paid"].indexOf(status) + 1;
  return { month: cur, run: r, status, step, waiting: status === "Draft" ? "Calculate the payroll first" : status === "Calculated" ? "Waiting for HR verification" : status === "Verified" ? "Waiting for finance approval" : status === "Approved" ? "Approved. Record the payments" : "Paid", earlier: check(all) as { id: string; month: string; status: string; staff: number; gross: number; deductions: number; net: number }[] };
}
export async function decideRun(inst: string, input: unknown, role: string, who: string) {
  const i = z.object({ month: monthRe, action: z.enum(["verify", "send_back", "approve"]), note: z.string().trim().max(200).optional() }).strict().parse(input);
  const r = await run(inst, i.month); if (!r) throw new HttpError(404, "Calculate the payroll first.");
  if (i.action === "verify") { if (r.status !== "Calculated") throw new HttpError(409, "Only a calculated payroll can be verified."); if (!["HR", "Principal", "VicePrincipal", "InstitutionAdmin"].includes(role)) throw new HttpError(403, "Only HR or the principal can verify payroll."); check(await supabaseAdmin.from("pay_runs").update({ status: "Verified" }).eq("id", r.id).eq("institution_id", inst).select("id")); await log(inst, i.month, "HR verified", who, i.note); }
  else if (i.action === "approve") { if (r.status !== "Verified") throw new HttpError(409, "HR must verify the payroll first."); if (!["Accountant", "Finance", "Principal", "InstitutionAdmin"].includes(role)) throw new HttpError(403, "Only a finance officer or the principal can approve payroll."); check(await supabaseAdmin.from("pay_runs").update({ status: "Approved" }).eq("id", r.id).eq("institution_id", inst).select("id")); await log(inst, i.month, "Finance approved", who, i.note); }
  else { if (!["Verified", "Calculated"].includes(r.status)) throw new HttpError(409, "It is too late to send this back."); check(await supabaseAdmin.from("pay_runs").update({ status: "Calculated" }).eq("id", r.id).eq("institution_id", inst).select("id")); await log(inst, i.month, "Returned", who, i.note); }
  return { ok: true };
}
export async function history(inst: string) {
  const [e, r] = await Promise.all([supabaseAdmin.from("pay_events").select("id, month, step, by_name, note, at").eq("institution_id", inst).order("at", { ascending: false }).limit(500), supabaseAdmin.from("pay_runs").select("month, status, paid_on, calculated_on").eq("institution_id", inst)]);
  const items = (check(e) as { id: string; month: string; step: string; by_name: string; note: string | null; at: string }[]);
  for (const x of check(r) as { month: string; status: string; paid_on: string | null }[]) if (x.paid_on) items.push({ id: `paid-${x.month}`, month: x.month, step: "Paid", by_name: "Accounts", note: null, at: `${x.paid_on}T12:00:00Z` });
  return { items: items.sort((a, b) => (a.at < b.at ? 1 : -1)) };
}

// ═════════════ payslips ═════════════
export function breakdown(gross: number, basic: number, ded: { pf: number; esi: number; pt: number; other: number }) {
  const da = Math.round(basic * 0.12), hra = Math.round(basic * 0.24), conv = Math.min(1600, Math.max(0, gross - basic - da - hra)); const special = Math.max(0, gross - basic - da - hra - conv);
  return { earnings: [["Basic pay", basic], ["Dearness allowance", da], ["House rent allowance", hra], ["Transport allowance", conv], ["Special allowance", special]] as [string, number][], deductions: [["Provident fund", ded.pf], ["ESI", ded.esi], ["Professional tax", ded.pt], ["TDS / other", ded.other]] as [string, number][] };
}
/** One employee's current assignment and what it pays a month. The bank account shows its last four digits only. */
export async function assignment(inst: string, id: string) {
  const s = (await structures(inst)).items.find((x) => x.id === id); if (!s) throw new HttpError(404, "Staff member not found.");
  const b = check(await supabaseAdmin.from("hr_staff").select("bank_name, bank_account").eq("profile_id", id).eq("institution_id", inst).maybeSingle()) as { bank_name: string | null; bank_account: string | null } | null;
  return { staff_id: s.id, name: s.name, department: s.department, designation: s.designation, structure: s.effective_from ? s.structure : "", gross: s.gross, effective_from: s.effective_from, bank: b?.bank_account ? `${b.bank_name ?? "Bank"} ••${b.bank_account.slice(-4)}` : "", ...breakdown(s.gross, s.basic, s), total_deductions: s.deductions, net: s.net };
}
async function slips(inst: string, month: string) {
  const [r, st, hs] = await Promise.all([run(inst, month), structures(inst), supabaseAdmin.from("hr_staff").select("profile_id, bank_name, bank_account").eq("institution_id", inst).limit(5000)]);
  const B = new Map((check(hs) as { profile_id: string; bank_name: string | null; bank_account: string | null }[]).map((x) => [x.profile_id, x]));
  if (!r) return { run: null, items: [] as ReturnType<typeof mk>[] };
  const l = check(await supabaseAdmin.from("pay_run_lines").select("staff_id, working_days, present, paid_leave, lop, gross, deductions, net").eq("run_id", r.id)) as { staff_id: string; working_days: number; present: number; paid_leave: number; lop: number; gross: number; deductions: number; net: number }[];
  const mk = (x: (typeof l)[number], s: (typeof st.items)[number]) => ({ staff_id: x.staff_id, name: s.name, emp_code: s.emp_code, designation: s.designation, department: s.department, days_paid: Number(x.present) + Number(x.paid_leave), working_days: Number(x.working_days), gross: x.gross, net: x.net, lop_amount: x.deductions - (s.pf + s.esi + s.pt + s.other), bank: B.get(x.staff_id)?.bank_account ? `${B.get(x.staff_id)?.bank_name ?? ""} ••${(B.get(x.staff_id)?.bank_account ?? "").slice(-4)}` : "", ...breakdown(x.gross, s.basic, s) });
  const K = new Map(st.items.map((s) => [s.id, s]));
  return { run: r, items: l.filter((x) => K.has(x.staff_id)).map((x) => mk(x, K.get(x.staff_id)!)).sort((a, b) => a.emp_code.localeCompare(b.emp_code, undefined, { numeric: true })) };
}
export async function payslips(inst: string, month: string) {
  monthRe.parse(month); const s = await slips(inst, month); const ready = !!s.run && ["Approved", "Paid"].includes(s.run.status);
  const paid = check(await supabaseAdmin.from("pay_payments").select("staff_id, status").eq("institution_id", inst).eq("month", month)) as { staff_id: string; status: string }[];
  const sc = check(await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle()) as { name: string } | null;
  return { month, school: sc?.name ?? "", status: s.run?.status ?? "Draft", ready, shared: !!s.run?.payslips_on, shared_on: s.run?.payslips_on ?? null, paid_on: s.run?.paid_on ?? null, items: s.items.map((x) => ({ ...x, paid: paid.find((p) => p.staff_id === x.staff_id)?.status === "Paid" })) };
}
export async function sharePayslips(inst: string, input: unknown) {
  const { month } = z.object({ month: monthRe }).strict().parse(input);
  const r = await run(inst, month); if (!r || !["Approved", "Paid"].includes(r.status)) throw new HttpError(409, "Payslips can be generated once finance approves.");
  check(await supabaseAdmin.from("pay_runs").update({ payslips_on: today() }).eq("id", r.id).eq("institution_id", inst).select("id")); return { ok: true };
}

// ═════════════ salary payments ═════════════
export async function payments(inst: string, failedOnly: boolean) {
  let q = supabaseAdmin.from("pay_payments").select("id, month, staff_id, net, bank, utr, paid_on, status").eq("institution_id", inst).order("paid_on", { ascending: false }).limit(3000); if (failedOnly) q = q.eq("status", "Failed");
  const [r, st, cur] = await Promise.all([q, structures(inst), run(inst, today().slice(0, 7))]);
  const K = new Map(st.items.map((s) => [s.id, s]));
  return { can_pay: cur?.status === "Approved", month: today().slice(0, 7), items: (check(r) as { id: string; month: string; staff_id: string; net: number; bank: string; utr: string; paid_on: string; status: string }[]).map((x) => ({ ...x, name: K.get(x.staff_id)?.name ?? "", emp_code: K.get(x.staff_id)?.emp_code ?? "" })) };
}
export async function recordPayments(inst: string, input: unknown, role: string, who: string) {
  const { month } = z.object({ month: monthRe }).strict().parse(input);
  if (!["Accountant", "Finance", "Principal", "InstitutionAdmin"].includes(role)) throw new HttpError(403, "Only accounts or the principal can record salary payments.");
  const r = await run(inst, month); if (!r || r.status !== "Approved") throw new HttpError(409, "Finance must approve the payroll first.");
  const s = await slips(inst, month); const d = today();
  check(await supabaseAdmin.from("pay_payments").upsert(s.items.map((x) => ({ institution_id: inst, month, staff_id: x.staff_id, net: x.net, bank: x.bank, utr: "", paid_on: d, status: x.bank ? "Paid" : "Failed" })), { onConflict: "institution_id,month,staff_id" }).select("id"));
  check(await supabaseAdmin.from("pay_runs").update({ status: "Paid", paid_on: d }).eq("id", r.id).eq("institution_id", inst).select("id"));
  await log(inst, month, "Paid", who); return { paid: s.items.filter((x) => x.bank).length, failed: s.items.filter((x) => !x.bank).length };
}
export async function updatePayment(inst: string, id: string, input: unknown) {
  const i = z.object({ status: z.enum(["Paid", "Failed", "Pending"]).optional(), utr: z.string().trim().max(30).optional() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("pay_payments").update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ reports ═════════════
export async function annual(inst: string, year: string) {
  z.string().regex(/^\d{4}$/).parse(year);
  const runs = check(await supabaseAdmin.from("pay_runs").select("id, month").eq("institution_id", inst).gte("month", `${year}-01`).lte("month", `${year}-12`)) as { id: string; month: string }[];
  const [l, st] = await Promise.all([runs.length ? supabaseAdmin.from("pay_run_lines").select("run_id, staff_id, gross, deductions, net").in("run_id", runs.map((x) => x.id)) : Promise.resolve({ data: [], error: null }), structures(inst)]);
  const L = check(l) as { staff_id: string; gross: number; deductions: number; net: number }[]; const K = new Map(st.items.map((s) => [s.id, s]));
  const by = new Map<string, { gross: number; deductions: number; net: number; months: number }>();
  for (const x of L) { const c = by.get(x.staff_id) ?? { gross: 0, deductions: 0, net: 0, months: 0 }; c.gross += x.gross; c.deductions += x.deductions; c.net += x.net; c.months++; by.set(x.staff_id, c); }
  return { year, runs: runs.length, items: [...by.entries()].map(([id, c]) => ({ id, name: K.get(id)?.name ?? "", emp_code: K.get(id)?.emp_code ?? "", designation: K.get(id)?.designation ?? "", ...c })).sort((a, b) => a.emp_code.localeCompare(b.emp_code, undefined, { numeric: true })) };
}
export async function deductionReport(inst: string) {
  const st = await structures(inst); const items = st.items.filter((s) => s.gross > 0);
  return { items: items.map((s) => ({ id: s.id, name: s.name, emp_code: s.emp_code, gross: s.gross, pf: s.pf, esi: s.esi, pt: s.pt, other: s.other, total: s.deductions })) };
}

// ═════════════ settings ═════════════
const OPT = { pay_period: ["1st - last day of the month", "26th - 25th of the month"], pay_by: ["Bank transfer (NEFT)", "Bank transfer (IMPS)", "Cheque", "Cash"], tax_regime: ["New regime", "Old regime"], proofs_month: ["December", "January", "February"], recover_months: ["1 month", "3 months", "6 months", "12 months"], arrears_with: ["Next month's salary", "Separate payment"], adv_limit: ["1 month's net pay", "2 months' net pay", "No advances"], paid_on: ["Last working day", "1st of next month", "7th of next month"] } as const;
const DEF = { pay_period: OPT.pay_period[0], paid_on: OPT.paid_on[0], lock_day: 25, pay_by: OPT.pay_by[0], tax_regime: "New regime", proofs_month: "January", form16: true, adv_limit: OPT.adv_limit[0], recover_months: "3 months", arrears_with: OPT.arrears_with[0], encash: true, debit_account: "" };
export async function settings(inst: string) { const r = check(await supabaseAdmin.from("pay_settings").select("pay_period, paid_on, lock_day, pay_by, tax_regime, proofs_month, form16, adv_limit, recover_months, arrears_with, encash, debit_account").eq("institution_id", inst).maybeSingle()) as typeof DEF | null; return { options: OPT, ...(r ?? DEF) }; }
export async function saveSettings(inst: string, input: unknown) {
  const i = z.object({ pay_period: z.enum(OPT.pay_period), paid_on: z.enum(OPT.paid_on), lock_day: z.number().int().min(1).max(31), pay_by: z.enum(OPT.pay_by), tax_regime: z.enum(OPT.tax_regime), proofs_month: z.enum(OPT.proofs_month), form16: z.boolean(), adv_limit: z.enum(OPT.adv_limit), recover_months: z.enum(OPT.recover_months), arrears_with: z.enum(OPT.arrears_with), encash: z.boolean(), debit_account: z.string().trim().max(30) }).strict().parse(input);
  check(await supabaseAdmin.from("pay_settings").upsert({ institution_id: inst, ...i }, { onConflict: "institution_id" }).select("institution_id")); return settings(inst);
}

// ═════════════ bank and statutory files ═════════════
async function base(inst: string, month: string) {
  monthRe.parse(month);
  const [r, st, hs, set] = await Promise.all([run(inst, month), structures(inst), supabaseAdmin.from("hr_staff").select("profile_id, bank_name, bank_account, ifsc, uan, esi_no").eq("institution_id", inst).limit(5000), settings(inst)]);
  const H = new Map((check(hs) as { profile_id: string; bank_name: string | null; bank_account: string | null; ifsc: string | null; uan: string | null; esi_no: string | null }[]).map((x) => [x.profile_id, x]));
  const calc = r ? null : await attendanceCalc(inst, month); const lines = r ? ((check(await supabaseAdmin.from("pay_run_lines").select("staff_id, present, paid_leave, gross, net").eq("run_id", r.id)) as { staff_id: string; present: number; paid_leave: number; gross: number; net: number }[])) : (calc?.items ?? []).filter((x) => x.gross > 0).map((x) => ({ staff_id: x.id, present: x.present, paid_leave: x.paid_leave, gross: x.gross, net: x.net }));
  const K = new Map(st.items.map((s) => [s.id, s]));
  return { run: r, set, rows: lines.filter((l) => K.has(l.staff_id)).map((l) => ({ ...l, s: K.get(l.staff_id)!, h: H.get(l.staff_id) })).sort((a, b) => a.s.emp_code.localeCompare(b.s.emp_code, undefined, { numeric: true })) };
}
const mon = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).toUpperCase().replace(" ", " ");
export async function bankFile(inst: string, month: string) {
  const b = await base(inst, month); const ok = b.rows.filter((x) => x.h?.bank_account && x.h?.ifsc); const missing = b.rows.length - ok.length;
  const text = ok.map((x, i) => `N,${String(i + 1).padStart(4, "0")},${b.set.debit_account},${x.net},${x.s.name.toUpperCase()},${x.h!.bank_account},${x.h!.ifsc},SALARY ${mon(month)} ${x.s.emp_code}`).join("\n");
  return { month, approved: !!b.run && ["Approved", "Paid"].includes(b.run.status), status: b.run?.status ?? "Draft", debit_account: b.set.debit_account, pay_date: lastDay(month), total: ok.reduce((n, x) => n + x.net, 0), transfers: ok.length, missing, text, items: b.rows.map((x) => ({ id: x.staff_id, name: x.s.name, emp_code: x.s.emp_code, account: x.h?.bank_account ? `••••${x.h.bank_account.slice(-4)}` : "", ifsc: x.h?.ifsc ?? "", bank: x.h?.bank_name ?? "", net: x.net, ok: !!(x.h?.bank_account && x.h?.ifsc) })) };
}
export async function pfEcr(inst: string, month: string) {
  const b = await base(inst, month); const rows = b.rows.filter((x) => x.s.pf > 0).map((x) => { const w = Math.min(x.s.basic, 15000); const ee = Math.round(w * 0.12); const eps = Math.round(w * 0.0833); return { id: x.staff_id, name: x.s.name, uan: x.h?.uan ?? "", gross: x.gross, wages: w, ee, eps, epf: ee - eps }; });
  const wages = rows.reduce((n, x) => n + x.wages, 0);
  return { month, approved: !!b.run && ["Approved", "Paid"].includes(b.run.status), members: rows.length, ee: rows.reduce((n, x) => n + x.ee, 0), er: rows.reduce((n, x) => n + x.ee, 0), admin: Math.max(500, Math.round(wages * 0.005)), missing_uan: rows.filter((x) => !x.uan).length, text: rows.filter((x) => x.uan).map((x) => `${x.uan}#~#${x.name.toUpperCase()}#~#${x.gross}#~#${x.wages}#~#${x.wages}#~#${x.wages}#~#${x.ee}#~#${x.eps}#~#${x.epf}#~#0#~#0`).join("\n"), items: rows };
}
export async function esiFile(inst: string, month: string) {
  const b = await base(inst, month); const rows = b.rows.filter((x) => x.gross <= 21000 && x.s.esi > 0).map((x) => ({ id: x.staff_id, name: x.s.name, ip: x.h?.esi_no ?? "", days: Number(x.present) + Number(x.paid_leave), wages: x.gross, ee: x.s.esi, er: Math.round(x.gross * 0.0325) }));
  return { month, approved: !!b.run && ["Approved", "Paid"].includes(b.run.status), insured: rows.length, ee: rows.reduce((n, x) => n + x.ee, 0), er: rows.reduce((n, x) => n + x.er, 0), missing_ip: rows.filter((x) => !x.ip).length, text: ["IP Number,IP Name,No of Days,Total Monthly Wages,Reason,Last Working Day", ...rows.filter((x) => x.ip).map((x) => `${x.ip},${x.name.toUpperCase()},${x.days},${x.wages},,`)].join("\n"), items: rows };
}
export async function ptTds(inst: string, month: string) {
  const b = await base(inst, month); const pt = b.rows.reduce((n, x) => n + x.s.pt, 0);
  const slabs = [["Up to ₹15,000", "Nil", b.rows.filter((x) => x.gross <= 15000).length], ["₹15,001 – ₹20,000", "₹150", b.rows.filter((x) => x.gross > 15000 && x.gross <= 20000).length], ["Above ₹20,000", "₹200", b.rows.filter((x) => x.gross > 20000).length]];
  const tds = b.rows.filter((x) => x.s.other > 0).map((x) => ({ id: x.staff_id, name: x.s.name, annual: x.gross * 12, tds: x.s.other }));
  return { month, approved: !!b.run && ["Approved", "Paid"].includes(b.run.status), pt, tds_total: tds.reduce((n, x) => n + x.tds, 0), slabs, tds, regime: b.set.tax_regime };
}
export async function setBank(inst: string, id: string, input: unknown) {
  const i = z.object({ bank_name: z.string().trim().max(40), bank_account: z.string().trim().regex(/^(\d{6,20})?$/, "Account numbers are 6 to 20 digits."), ifsc: z.string().trim().toUpperCase().regex(/^([A-Z]{4}0[A-Z0-9]{6})?$/, "IFSC looks like HDFC0001234."), uan: z.string().trim().regex(/^(\d{12})?$/, "UAN has 12 digits."), esi_no: z.string().trim().max(14), debit_account: z.string().trim().max(30).optional() }).strict().parse(input);
  const { debit_account, ...row } = i; void debit_account;
  const r = check(await supabaseAdmin.from("hr_staff").update({ bank_name: row.bank_name || null, bank_account: row.bank_account || null, ifsc: row.ifsc || null, uan: row.uan || null, esi_no: row.esi_no || null }).eq("profile_id", id).eq("institution_id", inst).select("profile_id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Staff member not found."); return { ok: true };
}
export async function staffBank(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("hr_staff").select("bank_name, bank_account, ifsc, uan, esi_no").eq("profile_id", id).eq("institution_id", inst).maybeSingle()) as { bank_name: string | null; bank_account: string | null; ifsc: string | null; uan: string | null; esi_no: string | null } | null;
  return { bank_name: r?.bank_name ?? "", bank_account: r?.bank_account ?? "", ifsc: r?.ifsc ?? "", uan: r?.uan ?? "", esi_no: r?.esi_no ?? "" };
}

// ═════════════ transport: vehicles ═════════════
export async function vehicles(inst: string) {
  const [v, d] = await Promise.all([supabaseAdmin.from("tr_vehicles").select("id, reg_no, vtype, seats, route, fitness_until, gps, status").eq("institution_id", inst).order("reg_no"), supabaseAdmin.from("tr_vehicle_docs").select("id, vehicle_id, doc_type, file_name, valid_until").eq("institution_id", inst).order("valid_until")]);
  const now = today(); const D = check(d) as { id: string; vehicle_id: string; doc_type: string; file_name: string; valid_until: string | null }[]; const V = check(v) as { id: string; reg_no: string; vtype: string; seats: number; route: string; fitness_until: string | null; gps: string; status: string }[];
  const soon = new Date(Date.parse(now) + 30 * 86400000).toISOString().slice(0, 10); const st = (x: string | null) => (x && x < now ? "Expired" : x && x <= soon ? "Expiring soon" : "Valid");
  return { routes: [...new Set(V.map((x) => x.route).filter(Boolean))], items: V.map((x) => ({ ...x, fitness: x.fitness_until ? st(x.fitness_until) : "—" })), docs: D.map((x) => ({ ...x, vehicle: V.find((y) => y.id === x.vehicle_id)?.reg_no ?? "", state: st(x.valid_until) })) };
}
export async function addVehicle(inst: string, input: unknown) {
  const i = z.object({ reg_no: z.string().trim().toUpperCase().min(3, "Enter the vehicle number.").max(30), vtype: z.enum(["Bus", "Mini bus", "Van", "Car"]), seats: z.number().int().min(1).max(80), route: z.string().trim().max(60).optional(), fitness_until: date.nullable().optional(), gps: z.enum(["Online", "Offline", "None"]) }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("tr_vehicles").select("id").eq("institution_id", inst).eq("reg_no", i.reg_no)) as unknown[]; if (dup.length) throw new HttpError(409, "That vehicle is already listed.");
  return check(await supabaseAdmin.from("tr_vehicles").insert({ institution_id: inst, ...i, route: i.route ?? "", fitness_until: i.fitness_until ?? null }).select("id").single());
}
export async function setVehicle(inst: string, id: string, input: unknown) {
  const i = z.object({ status: z.enum(["Active", "In maintenance", "Inactive"]).optional(), gps: z.enum(["Online", "Offline", "None"]).optional(), route: z.string().trim().max(60).optional(), fitness_until: date.nullable().optional() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("tr_vehicles").update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function addVehicleDoc(inst: string, input: unknown) {
  const i = z.object({ vehicle_id: uid, doc_type: z.string().trim().min(2, "Enter the document.").max(30), file_name: z.string().trim().min(2).max(160), valid_until: date.nullable().optional() }).strict().parse(input);
  if (!check(await supabaseAdmin.from("tr_vehicles").select("id").eq("id", i.vehicle_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Vehicle not found.");
  return check(await supabaseAdmin.from("tr_vehicle_docs").insert({ institution_id: inst, ...i, valid_until: i.valid_until ?? null }).select("id").single());
}
void statutory;
