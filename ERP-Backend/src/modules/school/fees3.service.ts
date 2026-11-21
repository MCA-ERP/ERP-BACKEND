import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { staffList } from "./attendance2.service";
import { everyone } from "./fees2.service";
import { feeSettings, yearStart } from "./fees.service";

/** Fees, part 3: expenses, the ledger, reports, Tally, canteen wallet, dashboards, insights and reminders. */
const uid = z.string().uuid();
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const MODES = ["Cash", "UPI", "Card", "Cheque", "Bank"] as const;
async function pages<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) { const rows = check(await build(from, from + 999)) as T[]; out.push(...rows); if (rows.length < 1000) break; }
  return out;
}

// ═════════════ expenses ═════════════
export async function expenseCategories(inst: string) {
  const ms = today().slice(0, 7) + "-01";
  const [c, e] = await Promise.all([supabaseAdmin.from("fee_expense_categories").select("id, name, monthly_budget, approver, status").eq("institution_id", inst).order("name"), supabaseAdmin.from("fee_expenses").select("category_id, amount").eq("institution_id", inst).eq("status", "Approved").gte("spent_on", ms).limit(20000)]);
  const E = check(e) as { category_id: string | null; amount: number }[];
  return { items: (check(c) as { id: string; name: string; monthly_budget: number; approver: string; status: string }[]).map((x) => ({ ...x, spent: E.filter((y) => y.category_id === x.id).reduce((n, y) => n + y.amount, 0) })) };
}
const APPROVERS = ["Accountant", "Principal", "Transport manager", "Vice Principal", "School admin"] as const;
export async function addExpenseCategory(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the category.").max(80), monthly_budget: z.number().int().min(0).max(100_000_000), approver: z.enum(APPROVERS) }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("fee_expense_categories").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That category exists.");
  return check(await supabaseAdmin.from("fee_expense_categories").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function setExpenseCategory(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("fee_expense_categories").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function expenseDefaults(inst: string) {
  const have = check(await supabaseAdmin.from("fee_expense_categories").select("id").eq("institution_id", inst)) as unknown[];
  if (have.length) throw new HttpError(409, "Categories are already set up.");
  const rows: [string, number, string][] = [["Electricity", 320000, "Accountant"], ["Diesel", 180000, "Transport manager"], ["Stationery", 60000, "Accountant"], ["Repairs", 100000, "Principal"], ["Events", 75000, "Principal"], ["Housekeeping", 140000, "Accountant"], ["Internet and phone", 40000, "Accountant"]];
  check(await supabaseAdmin.from("fee_expense_categories").insert(rows.map(([name, monthly_budget, approver]) => ({ institution_id: inst, name, monthly_budget, approver }))).select("id"));
  return { added: rows.length };
}
export async function expenses(inst: string) {
  const [rows, cats, staff] = await Promise.all([supabaseAdmin.from("fee_expenses").select("id, voucher, category_id, paid_to, amount, mode, spent_on, raised_by, status, decided_on, cat:category_id(name, approver), who:raised_by(first_name, last_name)").eq("institution_id", inst).order("spent_on", { ascending: false }).order("created_at", { ascending: false }).limit(3000), expenseCategories(inst), staffList(inst)]);
  type R = { id: string; voucher: string; category_id: string | null; paid_to: string; amount: number; mode: string | null; spent_on: string; raised_by: string | null; status: string; decided_on: string | null; cat: { name: string; approver: string } | { name: string; approver: string }[] | null; who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null };
  return { categories: cats.items.filter((c) => c.status === "Active").map((c) => ({ id: c.id, name: c.name })), staff: staff.map((s) => ({ id: s.id, name: s.name })), items: (check(rows) as unknown as R[]).map((x) => { const w = one(x.who); return { id: x.id, voucher: x.voucher, category: one(x.cat)?.name ?? "—", approver: one(x.cat)?.approver ?? "", paid_to: x.paid_to, amount: x.amount, mode: x.mode, spent_on: x.spent_on, raised_by: w ? `${w.first_name} ${w.last_name}`.trim() : "", status: x.status, decided_on: x.decided_on }; }) };
}
export async function addExpense(inst: string, input: unknown, actor?: string) {
  const i = z.object({ voucher: z.string().trim().max(30).optional(), category_id: uid, paid_to: z.string().trim().min(2, "Enter who was paid.").max(120), amount: z.number().int().min(1).max(100_000_000), mode: z.enum(MODES).nullable().optional(), spent_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), raised_by: uid.nullable().optional() }).strict().parse(input);
  const c = check(await supabaseAdmin.from("fee_expense_categories").select("id").eq("id", i.category_id).eq("institution_id", inst).maybeSingle());
  if (!c) throw new HttpError(404, "Category not found.");
  if (i.voucher) { const d = check(await supabaseAdmin.from("fee_expenses").select("id").eq("institution_id", inst).eq("voucher", i.voucher)) as unknown[]; if (d.length) throw new HttpError(409, "That voucher number is already used."); }
  return check(await supabaseAdmin.from("fee_expenses").insert({ institution_id: inst, ...(i.voucher ? { voucher: i.voucher } : {}), category_id: i.category_id, paid_to: i.paid_to, amount: i.amount, mode: i.mode ?? null, spent_on: i.spent_on, raised_by: i.raised_by ?? actor ?? null }).select("id, voucher").single());
}
const BIG = ["InstitutionAdmin", "Principal", "VicePrincipal"];
const APPROVER_ROLES: Record<string, string[]> = { Accountant: ["Accountant", ...BIG], Principal: ["Principal", "InstitutionAdmin"], "Vice Principal": ["VicePrincipal", "Principal", "InstitutionAdmin"], "School admin": ["InstitutionAdmin"], "Transport manager": ["Accountant", ...BIG] };
export async function decideExpense(inst: string, id: string, input: unknown, role: string) {
  const { status } = z.object({ status: z.enum(["Approved", "Rejected"]) }).strict().parse(input);
  const x = check(await supabaseAdmin.from("fee_expenses").select("id, status, cat:category_id(approver)").eq("id", id).eq("institution_id", inst).maybeSingle()) as unknown as { id: string; status: string; cat: { approver: string } | { approver: string }[] | null } | null;
  if (!x) throw new HttpError(404, "Not found.");
  if (x.status !== "Pending") throw new HttpError(409, "That was already decided.");
  const need = one(x.cat)?.approver ?? "Accountant";
  if (!(APPROVER_ROLES[need] ?? BIG).includes(role)) throw new HttpError(403, `Only the ${need} can decide this expense.`);
  check(await supabaseAdmin.from("fee_expenses").update({ status, decided_on: today() }).eq("id", id).select("id"));
  return { ok: true };
}

// ═════════════ the ledger (worked out from receipts, fines, refunds and approved expenses) ═════════════
export interface Entry { date: string; voucher: string; account: string; narration: string; debit: number; credit: number; book: "Cash book" | "Bank book"; kind: "Receipt" | "Payment"; mode: string; status: "Posted" }
const bookOf = (m: string | null): "Cash book" | "Bank book" => (m === "Cash" ? "Cash book" : "Bank book");
export async function entries(inst: string): Promise<Entry[]> {
  const [p, f, r, x, cl] = await Promise.all([
    pages<{ receipt_no: string; total: number; mode: string; paid_on: string; collected_at: string }>((a, b) => supabaseAdmin.from("fee_payments").select("receipt_no, total, mode, paid_on, collected_at").eq("institution_id", inst).eq("status", "Paid").range(a, b)),
    supabaseAdmin.from("fee_fines").select("code, amount, mode, settled_on, reason").eq("institution_id", inst).eq("status", "Paid").limit(5000),
    supabaseAdmin.from("fee_refunds").select("code, amount, paid_on, reason").eq("institution_id", inst).eq("status", "Paid").limit(5000),
    supabaseAdmin.from("fee_expenses").select("voucher, amount, mode, spent_on, paid_to, cat:category_id(name)").eq("institution_id", inst).eq("status", "Approved").limit(5000),
    supabaseAdmin.from("staff_claims").select("code, amount, paid_on, ctype").eq("institution_id", inst).eq("status", "Paid").limit(5000),
  ]);
  const out: Entry[] = [];
  for (const y of p) out.push({ date: y.paid_on, voucher: y.receipt_no, account: "Fee income", narration: y.collected_at === "Online" ? "Online fee payment" : "Fee collected at counter", debit: 0, credit: y.total, book: bookOf(y.mode), kind: "Receipt", mode: y.mode, status: "Posted" });
  for (const y of check(f) as { code: string; amount: number; mode: string | null; settled_on: string | null; reason: string }[]) out.push({ date: y.settled_on ?? today(), voucher: y.code, account: "Fine income", narration: y.reason, debit: 0, credit: y.amount, book: bookOf(y.mode), kind: "Receipt", mode: y.mode ?? "Cash", status: "Posted" });
  for (const y of check(r) as { code: string; amount: number; paid_on: string | null; reason: string }[]) out.push({ date: y.paid_on ?? today(), voucher: y.code, account: "Fee refund", narration: y.reason, debit: y.amount, credit: 0, book: "Bank book", kind: "Payment", mode: "Bank", status: "Posted" });
  for (const y of check(x) as unknown as { voucher: string; amount: number; mode: string | null; spent_on: string; paid_to: string; cat: { name: string } | { name: string }[] | null }[]) out.push({ date: y.spent_on, voucher: y.voucher, account: one(y.cat)?.name ?? "Expense", narration: y.paid_to, debit: y.amount, credit: 0, book: bookOf(y.mode), kind: "Payment", mode: y.mode ?? "Bank", status: "Posted" });
  for (const y of check(cl) as { code: string; amount: number; paid_on: string | null; ctype: string }[]) out.push({ date: y.paid_on ?? today(), voucher: y.code, account: "Staff claims", narration: y.ctype, debit: y.amount, credit: 0, book: "Bank book", kind: "Payment", mode: "Bank", status: "Posted" });
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.voucher < b.voucher ? 1 : -1));
}
export async function ledger(inst: string, book?: string) {
  const all = await entries(inst);
  return { items: book === "Cash book" || book === "Bank book" ? all.filter((e) => e.book === book) : all };
}

// ═════════════ reports and the live dashboard ═════════════
const MODE_LABEL: Record<string, string> = { UPI: "UPI", Bank: "Net banking", Cash: "Cash", Card: "Card", Cheque: "Cheque" };
const TYPE_LABEL: Record<string, string> = { fees: "Tuition and school fees", transport: "Transport", hostel: "Hostel", late: "Late fees" };
export async function reports(inst: string) {
  const now = today(); const ms = now.slice(0, 7) + "-01"; const ys = await yearStart(inst);
  const [ov, pays, lines, cons, exps, ro] = await Promise.all([
    everyone(inst),
    pages<{ student_id: string; mode: string; total: number; paid_on: string; created_at: string }>((a, b) => supabaseAdmin.from("fee_payments").select("student_id, mode, total, paid_on, created_at").eq("institution_id", inst).eq("status", "Paid").gte("paid_on", ys).range(a, b)),
    pages<{ line_key: string; amount: number; fee_payments: { paid_on: string } | { paid_on: string }[] }>((a, b) => supabaseAdmin.from("fee_payment_lines").select("line_key, amount, fee_payments:payment_id!inner(institution_id, status, paid_on)").eq("fee_payments.institution_id", inst).eq("fee_payments.status", "Paid").gte("fee_payments.paid_on", ys).range(a, b)),
    supabaseAdmin.from("fee_concessions").select("ctype, amount").eq("institution_id", inst).eq("status", "Approved").limit(20000),
    supabaseAdmin.from("fee_expenses").select("amount").eq("institution_id", inst).eq("status", "Approved").gte("spent_on", ms).limit(20000),
    roster(inst),
  ]);
  const a = ov.agg; const K = new Map(ro.items.map((r) => [r.id, r]));
  const sum = (xs: { total: number }[]) => xs.reduce((n, x) => n + x.total, 0);
  const group = (xs: { k: string; v: number }[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x.k, (m.get(x.k) ?? 0) + x.v); return [...m.entries()].sort((p, q) => q[1] - p[1]); };
  const t = pays.filter((p) => p.paid_on === now); const month = pays.filter((p) => p.paid_on >= ms);
  const typeOf = (k: string) => TYPE_LABEL[k.split(":")[1]] ?? "Other";
  const byHour = new Array(24).fill(0) as number[];
  for (const p of t) byHour[Number(new Date(p.created_at).toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })) % 24] += p.total;
  const given = (check(cons) as { ctype: string; amount: number }[]);
  const cash = (xs: typeof pays, m: string[]) => xs.filter((p) => m.includes(p.mode)).reduce((n, p) => n + p.total, 0);
  return {
    today: now, year_start: ys, students: a.students, annual: a.annual, collected: sum(pays), pending: a.pending, overdue: a.overdue, overdue_students: a.overdue_students, owe_now: a.owe_now,
    by_mode: group(pays.map((p) => ({ k: MODE_LABEL[p.mode] ?? p.mode, v: p.total }))), by_type: group(lines.map((l) => ({ k: typeOf(l.line_key), v: l.amount }))),
    by_class: [...a.by_class.entries()], buckets: a.buckets,
    day: { cash: cash(t, ["Cash"]), online: cash(t, ["UPI", "Bank"]), card: cash(t, ["Card"]), cheque: cash(t, ["Cheque"]), total: sum(t), receipts: t.length },
    month: { income: sum(month), receipts: month.length, expenses: (check(exps) as { amount: number }[]).reduce((n, x) => n + x.amount, 0), by_type: group(lines.filter((l) => one(l.fee_payments)!.paid_on >= ms).map((l) => ({ k: typeOf(l.line_key), v: l.amount }))) },
    by_hour: byHour.slice(8, 17), recent: t.sort((p, q) => (p.created_at < q.created_at ? 1 : -1)).slice(0, 8).map((p) => ({ amount: p.total, student: K.get(p.student_id)?.name ?? "", class_label: K.get(p.student_id)?.class_label ?? "", mode: p.mode, at: p.created_at })),
    concessions: { given: given.reduce((n, x) => n + x.amount, 0), by_type: group(given.map((x) => ({ k: x.ctype, v: x.amount }))) },
  };
}

// ═════════════ Tally ═════════════
const ACCOUNTS_BASE: [string, string, string][] = [["Fee income", "Tuition Fees", "Income (Direct)"], ["Fine income", "Fine Income", "Income (Indirect)"], ["Fee refund", "Fee Refunds", "Direct Expenses"], ["Cash", "Cash", "Cash-in-hand"], ["Bank", "Bank A/c", "Bank Accounts"]];
async function accountList(inst: string) {
  const c = check(await supabaseAdmin.from("fee_expense_categories").select("name").eq("institution_id", inst).order("name")) as { name: string }[];
  return [...ACCOUNTS_BASE.map(([a]) => a), ...c.map((x) => x.name)];
}
export async function ledgerMapping(inst: string) {
  const [acc, m] = await Promise.all([accountList(inst), supabaseAdmin.from("fee_ledger_map").select("account, tally_ledger, tally_group").eq("institution_id", inst)]);
  const M = new Map((check(m) as { account: string; tally_ledger: string; tally_group: string }[]).map((x) => [x.account, x]));
  return { items: acc.map((a) => ({ account: a, tally_ledger: M.get(a)?.tally_ledger ?? "", tally_group: M.get(a)?.tally_group ?? "", status: M.has(a) ? "Completed" : "Needs mapping" })) };
}
export async function saveMapping(inst: string, input: unknown) {
  const i = z.object({ account: z.string().trim().min(1).max(80), tally_ledger: z.string().trim().min(1, "Enter the Tally ledger.").max(80), tally_group: z.string().trim().min(1, "Enter the Tally group.").max(40) }).strict().parse(input);
  if (!(await accountList(inst)).includes(i.account)) throw new HttpError(404, "Account not found.");
  check(await supabaseAdmin.from("fee_ledger_map").upsert({ institution_id: inst, ...i }, { onConflict: "institution_id,account" }).select("account"));
  return { ok: true };
}
export async function standardMapping(inst: string) {
  const [acc, m] = await Promise.all([accountList(inst), supabaseAdmin.from("fee_ledger_map").select("account").eq("institution_id", inst)]);
  const have = new Set((check(m) as { account: string }[]).map((x) => x.account));
  const rows = acc.filter((a) => !have.has(a)).map((a) => { const b = ACCOUNTS_BASE.find(([x]) => x === a); return { institution_id: inst, account: a, tally_ledger: b?.[1] ?? a, tally_group: b?.[2] ?? "Indirect Expenses" }; });
  if (rows.length) check(await supabaseAdmin.from("fee_ledger_map").insert(rows).select("account"));
  return { added: rows.length };
}
export async function tallyVouchers(inst: string, from: string, to: string, type: string) {
  z.object({ f: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), t: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ty: z.enum(["All", "Receipt", "Payment"]) }).parse({ f: from, t: to, ty: type });
  if (from > to) throw new HttpError(400, "The start date is after the end date.");
  const [all, map, sc] = await Promise.all([entries(inst), ledgerMapping(inst), supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle()]);
  const L = new Map(map.items.map((x) => [x.account, x]));
  const list = all.filter((e) => e.date >= from && e.date <= to && (type === "All" || e.kind === type)).reverse();
  const used = new Set<string>(); for (const e of list) { used.add(e.account); used.add(e.book === "Cash book" ? "Cash" : "Bank"); }
  const unmapped = [...used].filter((a) => !L.get(a)?.tally_ledger);
  const vouchers = list.map((e) => { const bank = L.get(e.book === "Cash book" ? "Cash" : "Bank")?.tally_ledger ?? ""; const acct = L.get(e.account)?.tally_ledger ?? ""; const amt = e.kind === "Receipt" ? e.credit : e.debit; return { type: e.kind, date: e.date, voucher: e.voucher, narration: e.narration, amount: amt, debit_ledger: e.kind === "Receipt" ? bank : acct, credit_ledger: e.kind === "Receipt" ? acct : bank }; });
  return { company: (sc.data as { name: string } | null)?.name ?? "", vouchers, unmapped };
}
export async function logExport(inst: string, input: unknown, actor?: string) {
  const i = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), types: z.enum(["All", "Receipt", "Payment"]), vouchers: z.number().int().min(0).max(1_000_000) }).strict().parse(input);
  check(await supabaseAdmin.from("fee_tally_exports").insert({ institution_id: inst, from_date: i.from, to_date: i.to, types: i.types, vouchers: i.vouchers, created_by: actor ?? null }).select("id"));
  return { ok: true };
}
export async function exportLog(inst: string) {
  return { items: (check(await supabaseAdmin.from("fee_tally_exports").select("id, exported_at, from_date, to_date, types, vouchers").eq("institution_id", inst).order("exported_at", { ascending: false }).limit(200)) as { id: string; exported_at: string; from_date: string; to_date: string; types: string; vouchers: number }[]).map((x) => ({ ...x, status: "Exported" })) };
}

// ═════════════ canteen wallet ═════════════
export async function canteen(inst: string) {
  const now = today(); const ms = now.slice(0, 7) + "-01";
  const [rows, ro] = await Promise.all([pages<{ student_id: string; kind: string; amount: number; txn_on: string }>((a, b) => supabaseAdmin.from("canteen_txns").select("student_id, kind, amount, txn_on").eq("institution_id", inst).range(a, b)), roster(inst)]);
  const bal = new Map<string, number>(); for (const r of rows) bal.set(r.student_id, (bal.get(r.student_id) ?? 0) + (r.kind === "Top-up" ? r.amount : -r.amount));
  const m = rows.filter((r) => r.txn_on >= ms); const tops = m.filter((r) => r.kind === "Top-up");
  const days = new Map<string, { top: number; buy: number }>(); for (const r of rows) { const d = days.get(r.txn_on) ?? { top: 0, buy: 0 }; if (r.kind === "Top-up") d.top += r.amount; else d.buy += r.amount; days.set(r.txn_on, d); }
  return {
    students: ro.items.filter((r) => r.status === "Enrolled").map((r) => ({ id: r.id, name: r.name, class_label: r.class_label, balance: bal.get(r.id) ?? 0 })),
    held: [...bal.values()].reduce((n, v) => n + v, 0), wallets: bal.size, topped: tops.reduce((n, r) => n + r.amount, 0), topups: tops.length, spent: m.filter((r) => r.kind === "Purchase").reduce((n, r) => n + r.amount, 0), low: [...bal.values()].filter((v) => v < 100).length,
    daily: [...days.entries()].sort((p, q) => (p[0] < q[0] ? 1 : -1)).slice(0, 30).map(([date, d]) => ({ date, topups: d.top, purchases: d.buy, journal: `JV-${date.slice(2).replace(/-/g, "")}` })),
  };
}
export async function addCanteen(inst: string, input: unknown, actor?: string) {
  const i = z.object({ student_id: uid, kind: z.enum(["Top-up", "Purchase"]), amount: z.number().int().min(1).max(100_000) }).strict().parse(input);
  const c = await canteen(inst); const s = c.students.find((x) => x.id === i.student_id);
  if (!s) throw new HttpError(404, "Student not found.");
  if (i.kind === "Purchase" && i.amount > s.balance) throw new HttpError(409, `The wallet only has ₹${s.balance.toLocaleString("en-IN")}.`);
  check(await supabaseAdmin.from("canteen_txns").insert({ institution_id: inst, ...i, created_by: actor ?? null }).select("id"));
  return { ok: true };
}

// ═════════════ alert rules and insights ═════════════
export const RULES: [string, string, string, boolean][] = [["duplicate", "Same vendor, same amount, within 15 days", "Possible duplicate payment", true], ["budget", "Any category over its monthly budget", "Budget alert", true], ["collections", "More than 10% of the annual fees overdue", "Collections alert", true], ["cash", "Cash below 5 months of salaries in the next 6 months", "Cash alert", true], ["vendor", "Price up more than 5% without a new contract", "Vendor alert", true], ["timing", "Expense booked on a Sunday", "Unusual timing", false]];
export async function alertRules(inst: string) {
  const r = check(await supabaseAdmin.from("fee_alert_rules").select("rule_key, enabled").eq("institution_id", inst)) as { rule_key: string; enabled: boolean }[];
  return { items: RULES.map(([key, check_, raises, on]) => ({ key, check: check_, raises, on: r.find((x) => x.rule_key === key)?.enabled ?? on })) };
}
export async function saveAlertRule(inst: string, input: unknown) {
  const i = z.object({ key: z.enum(["duplicate", "budget", "collections", "cash", "vendor", "timing"]), on: z.boolean() }).strict().parse(input);
  check(await supabaseAdmin.from("fee_alert_rules").upsert({ institution_id: inst, rule_key: i.key, enabled: i.on }, { onConflict: "institution_id,rule_key" }).select("rule_key"));
  return alertRules(inst);
}
export async function insights(inst: string) {
  const now = today(); const ms = now.slice(0, 7) + "-01";
  const [rules, ex, cats, ov, st] = await Promise.all([alertRules(inst), supabaseAdmin.from("fee_expenses").select("id, paid_to, amount, spent_on, status").eq("institution_id", inst).neq("status", "Rejected").gte("spent_on", new Date(Date.parse(now) - 60 * 86400000).toISOString().slice(0, 10)).limit(5000), expenseCategories(inst), everyone(inst), supabaseAdmin.from("fee_insight_state").select("insight_key").eq("institution_id", inst)]);
  const on = (k: string) => rules.items.find((r) => r.key === k)?.on;
  const E = (check(ex) as { id: string; paid_to: string; amount: number; spent_on: string; status: string }[]).sort((a, b) => (a.spent_on < b.spent_on ? -1 : 1));
  const done = new Set((check(st) as { insight_key: string }[]).map((x) => x.insight_key));
  const out: { key: string; level: "high" | "medium"; title: string; text: string; suggest: string }[] = [];
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  if (on("duplicate")) for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) if (E[i].amount === E[j].amount && E[i].paid_to.toLowerCase() === E[j].paid_to.toLowerCase() && daysBetween(E[i].spent_on, E[j].spent_on) <= 15) out.push({ key: `dup:${E[i].id}:${E[j].id}`, level: "high", title: "Possible duplicate payment", text: `${E[i].paid_to} ${inr(E[i].amount)} was booked on ${E[i].spent_on} and again on ${E[j].spent_on}.`, suggest: `Recover ${inr(E[j].amount)} or adjust against the next bill.` });
  if (on("budget")) for (const c of cats.items) if (c.status === "Active" && c.monthly_budget > 0 && c.spent > c.monthly_budget) out.push({ key: `budget:${c.id}:${ms}`, level: "medium", title: `${c.name} over budget`, text: `This month's ${c.name.toLowerCase()} spending is ${inr(c.spent)} against ${inr(c.monthly_budget)} budgeted.`, suggest: "Review the bills and ask the approver to hold new ones." });
  const a = ov.agg;
  if (on("collections") && a.annual > 0 && a.overdue > a.annual * 0.1) out.push({ key: `coll:${ms}`, level: "medium", title: "Collections are behind", text: `${a.overdue_students} families are overdue by ${inr(a.overdue)}, ${Math.round((a.overdue / a.annual) * 100)}% of the annual fees.`, suggest: "Open Pending Fees and send reminders this week." });
  if (on("timing")) for (const e of E) if (new Date(e.spent_on + "T00:00:00Z").getUTCDay() === 0) out.push({ key: `sun:${e.id}`, level: "medium", title: "Expense booked on a Sunday", text: `${e.paid_to} ${inr(e.amount)} is dated ${e.spent_on}, a Sunday.`, suggest: "Check the bill and who raised it." });
  return { items: out.filter((x) => !done.has(x.key)) };
}
export async function reviewInsight(inst: string, input: unknown) {
  const { key } = z.object({ key: z.string().trim().min(1).max(100) }).strict().parse(input);
  check(await supabaseAdmin.from("fee_insight_state").upsert({ institution_id: inst, insight_key: key, reviewed_on: today() }, { onConflict: "institution_id,insight_key" }).select("insight_key"));
  return { ok: true };
}

// ═════════════ automatic reminders ═════════════
export const CHANNELS = ["Parent app and email", "Parent app and SMS", "WhatsApp", "WhatsApp and SMS", "Call list for the accounts office", "Letter from the Principal"] as const;
interface Step { key: string; offset: number; title: string; note: string; channel: (typeof CHANNELS)[number]; on: boolean; text: string }
const STEPS: Step[] = [
  { key: "d-7", offset: -7, title: "7 days before", note: "Friendly heads-up", channel: "Parent app and email", on: true, text: "Dear {parent}, {child}'s {instalment} of {amount} is due on {due}. Pay in the parent app in under a minute. Thank you!" },
  { key: "d0", offset: 0, title: "On the due date", note: "Due today", channel: "Parent app and SMS", on: true, text: "Reminder: {child}'s {instalment} of {amount} is due today. Pay now in the parent app to avoid a late fee from {latefrom}." },
  { key: "d3", offset: 3, title: "3 days after", note: "Gentle reminder", channel: "WhatsApp", on: true, text: "Hello {parent}, {child}'s {instalment} ({amount}) is still pending. A late fee applies from {latefrom}. Need more time? Reply to request an extension." },
  { key: "d10", offset: 10, title: "10 days after", note: "Late fee has started", channel: "WhatsApp and SMS", on: true, text: "{child}'s {instalment} is overdue. Amount now {amount} including late fee. Please pay or speak to the accounts office." },
  { key: "d20", offset: 20, title: "20 days after", note: "Personal call", channel: "Call list for the accounts office", on: true, text: "Accounts office to call the family, note the reason and a promised payment date." },
  { key: "d30", offset: 30, title: "30 days after", note: "Final notice", channel: "Letter from the Principal", on: false, text: "Formal letter from the Principal about the pending fee and next steps." },
];
const RULES_R = [["skip_paid", "Skip families who have already paid"], ["skip_extension", "Skip families with an approved extension"], ["skip_concession", "Skip families whose concession request is under review"], ["quiet", "Quiet hours: nothing between 9 pm and 8 am"], ["language", "Send in the parent's language (English, Hindi or Telugu)"], ["stop", "Stop after 2 unanswered WhatsApp messages and move to the call list"]] as const;
export async function reminderConfig(inst: string) {
  const c = check(await supabaseAdmin.from("fee_reminder_config").select("steps, rules").eq("institution_id", inst).maybeSingle()) as { steps: Step[]; rules: Record<string, boolean> } | null;
  return { channels: CHANNELS, steps: c?.steps ?? STEPS, rules: RULES_R.map(([key, text]) => ({ key, text, on: c?.rules[key] ?? true })) };
}
export async function saveReminderConfig(inst: string, input: unknown) {
  const i = z.object({ steps: z.array(z.object({ key: z.string().max(10), on: z.boolean(), channel: z.enum(CHANNELS), text: z.string().trim().min(1, "Write the message.").max(500) }).strict()).length(6), rules: z.record(z.string().max(20), z.boolean()) }).strict().parse(input);
  const steps = STEPS.map((s) => { const x = i.steps.find((y) => y.key === s.key); if (!x) throw new HttpError(400, "A reminder step is missing."); return { ...s, on: x.on, channel: x.channel, text: x.text }; });
  check(await supabaseAdmin.from("fee_reminder_config").upsert({ institution_id: inst, steps, rules: i.rules }, { onConflict: "institution_id" }).select("institution_id"));
  return reminderConfig(inst);
}
const short = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
export const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? `{${k}}`);
export async function reminderQueue(inst: string) {
  const now = today();
  const [cfg, ov, set, open] = await Promise.all([reminderConfig(inst), everyone(inst), feeSettings(inst), supabaseAdmin.from("fee_concessions").select("student_id").eq("institution_id", inst).in("status", ["Pending", "Under review", "Info asked"])]);
  const skip = cfg.rules.find((r) => r.key === "skip_concession")?.on ? new Set((check(open) as { student_id: string }[]).map((x) => x.student_id)) : new Set<string>();
  const items: { student_id: string; student: string; class_label: string; father: string; mobile: string; step: string; channel: string; app: boolean; amount: number; message: string }[] = [];
  for (const d of ov.detail) {
    if (skip.has(d.student_id)) continue;
    for (const s of cfg.steps) { if (!s.on) continue; const t = d.terms.find((x) => x.due > 0 && daysBetween(x.date, now) === s.offset); if (!t) continue;
      const late = new Date(Date.parse(t.date + "T00:00:00Z") + set.late_grace * 86400000).toISOString().slice(0, 10);
      items.push({ student_id: d.student_id, student: d.student, class_label: d.class_label, father: d.father, mobile: d.mobile, step: s.title, channel: s.channel, app: s.channel.startsWith("Parent app"), amount: t.due, message: fill(s.text, { parent: d.father || "Parent", child: d.student.split(" ")[0], instalment: t.name, amount: `₹${t.due.toLocaleString("en-IN")}`, due: short(t.date), latefrom: short(late) }) }); }
  }
  return { items };
}
export async function runReminders(inst: string, actor?: string) {
  const { items } = await reminderQueue(inst); const now = today();
  const sent = check(await supabaseAdmin.from("fee_reminders").select("student_id").eq("institution_id", inst).eq("sent_on", now)) as { student_id: string }[];
  const did = new Set(sent.map((x) => x.student_id));
  const todo = items.filter((x) => x.app && !did.has(x.student_id)).filter((x, i, a) => a.findIndex((y) => y.student_id === x.student_id) === i);
  const g = todo.length ? (check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, relation, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).in("student_id", todo.map((t) => t.student_id))) as { student_id: string; guardian_id: string; relation: string }[]) : [];
  const msgs: Record<string, unknown>[] = []; const logs: Record<string, unknown>[] = [];
  for (const t of todo) { const kin = g.filter((x) => x.student_id === t.student_id); const p = kin.find((x) => x.relation === "Father") ?? kin[0]; if (!p) continue; msgs.push({ institution_id: inst, kind: "notification", guardian_id: p.guardian_id, student_id: t.student_id, subject: "Fee reminder", body: t.message, created_by: actor ?? null }); logs.push({ institution_id: inst, student_id: t.student_id, sent_on: now, amount: t.amount, created_by: actor ?? null }); }
  if (msgs.length) { check(await supabaseAdmin.from("parent_messages").insert(msgs).select("id")); check(await supabaseAdmin.from("fee_reminders").insert(logs).select("id")); }
  return { sent: msgs.length, left: items.length - msgs.length };
}
export async function reminderLog(inst: string) {
  const [rows, ro] = await Promise.all([supabaseAdmin.from("fee_reminders").select("id, student_id, sent_on, amount").eq("institution_id", inst).order("sent_on", { ascending: false }).limit(1000), roster(inst)]);
  const K = new Map(ro.items.map((r) => [r.id, r]));
  return { items: (check(rows) as { id: string; student_id: string; sent_on: string; amount: number }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "", channel: "Parent app" })) };
}
export async function reminderResults(inst: string) {
  const since = new Date(Date.parse(today()) - 30 * 86400000).toISOString().slice(0, 10);
  const [rows, ov] = await Promise.all([supabaseAdmin.from("fee_reminders").select("student_id, amount").eq("institution_id", inst).gte("sent_on", since).limit(20000), everyone(inst)]);
  const R = check(rows) as { student_id: string; amount: number }[]; const fam = new Set(R.map((r) => r.student_id)); const still = new Set(ov.rows.map((r) => r.student_id));
  const cleared = [...fam].filter((s) => !still.has(s)).length;
  return { sent: R.length, families: fam.size, paid_after: cleared, still_due: fam.size - cleared };
}
