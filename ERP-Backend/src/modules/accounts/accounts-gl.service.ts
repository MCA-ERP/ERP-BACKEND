import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { yearStart } from "../school/fees.service";

/**
 * Books of account. Receipts, fines, refunds, expenses and paid claims post to the books from their own records, so a number can
 * never disagree with the screen it came from; manual journal entries and the chart of accounts are stored here. Everything is
 * worked out for the signed-in school only. Postings are on a cash basis: fee income is booked when the receipt is.
 */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
export type Group = "Assets" | "Liabilities" | "Fund" | "Income" | "Expenses";
const DEBIT_NATURE: Group[] = ["Assets", "Expenses"];

const CASH = "1101", BANK = "1102", OTHER_EXP = "5999", CONCESSION = "4991";
const DEFAULT_CHART: [string, string, Group][] = [
  ["1101", "Cash in hand", "Assets"], ["1102", "Bank account", "Assets"], ["1201", "Fees receivable", "Assets"], ["1301", "Fixed assets", "Assets"], ["1401", "Advances and deposits paid", "Assets"],
  ["2101", "Sundry creditors", "Liabilities"], ["2301", "Caution deposits", "Liabilities"], ["2401", "Fees received in advance", "Liabilities"], ["3101", "General fund", "Fund"],
  ["4101", "Tuition fees", "Income"], ["4102", "Admission fees", "Income"], ["4103", "Activity fees", "Income"], ["4104", "Lab fees", "Income"], ["4105", "Computer fees", "Income"], ["4106", "Exam fees", "Income"],
  ["4201", "Transport income", "Income"], ["4202", "Mess income", "Income"], ["4301", "Hostel fees", "Income"], ["4302", "Hostel mess", "Income"], ["4401", "Store sales", "Income"],
  ["4901", "Fines and penalties", "Income"], ["4902", "Library fines", "Income"], ["4991", "Less: concessions allowed", "Income"],
  ["5101", "Salaries and wages", "Expenses"], ["5201", "Electricity and water", "Expenses"], ["5202", "Internet and telephone", "Expenses"], ["5301", "Fuel - transport", "Expenses"], ["5302", "Vehicle maintenance", "Expenses"],
  ["5401", "Mess provisions", "Expenses"], ["5501", "Stationery and printing", "Expenses"], ["5503", "Store purchases (uniforms and books)", "Expenses"], ["5601", "Repairs and maintenance", "Expenses"],
  ["5701", "Lab and library purchases", "Expenses"], ["5702", "IT and classroom equipment", "Expenses"], ["5801", "Events and activities", "Expenses"], ["5901", "Bank charges", "Expenses"], ["5999", "Other expenses", "Expenses"],
];
const INCOME_OF: Record<string, string> = { fees: "4101", transport: "4201", hostel: "4301", late: "4901" };
const book = (mode: string | null) => (mode === "Cash" ? CASH : BANK);

export interface Account { code: string; name: string; grp: Group; opening: number }
export interface Voucher { voucher: string; date: string; narration: string; source: "Receipts" | "Fines" | "Refunds" | "Expenses" | "Claims" | "Manual"; lines: { code: string; dr: number; cr: number }[]; manual_id?: string }

async function accountList(inst: string): Promise<Account[]> {
  const load = async () => check(await supabaseAdmin.from("acc_accounts").select("code, name, grp, opening").eq("institution_id", inst).order("code")) as { code: string; name: string; grp: Group; opening: number }[];
  let a = await load();
  if (!a.length) {
    check(await supabaseAdmin.from("acc_accounts").upsert(DEFAULT_CHART.map(([code, name, grp]) => ({ institution_id: inst, code, name, grp })), { onConflict: "institution_id,code", ignoreDuplicates: true }).select("code"));
    a = await load();
  }
  return a.map((x) => ({ ...x, opening: Number(x.opening) }));
}

async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) { const rows = check(await build(from, from + 999)) as T[]; out.push(...rows); if (rows.length < 1000) break; }
  return out;
}

async function vouchers(inst: string, accounts: Account[]): Promise<Voucher[]> {
  const [pays, fines, refunds, exps, claims, manual] = await Promise.all([
    pageAll<{ receipt_no: string; mode: string; paid_on: string; concession: number; fee_payment_lines: { line_key: string; amount: number }[] }>((a, b) => supabaseAdmin.from("fee_payments").select("receipt_no, mode, paid_on, concession, fee_payment_lines(line_key, amount)").eq("institution_id", inst).eq("status", "Paid").range(a, b)),
    supabaseAdmin.from("fee_fines").select("code, amount, mode, settled_on, reason").eq("institution_id", inst).eq("status", "Paid").limit(5000),
    supabaseAdmin.from("fee_refunds").select("code, amount, paid_on, reason").eq("institution_id", inst).eq("status", "Paid").limit(5000),
    supabaseAdmin.from("fee_expenses").select("voucher, amount, mode, spent_on, paid_to, cat:category_id(name)").eq("institution_id", inst).eq("status", "Approved").limit(5000),
    supabaseAdmin.from("staff_claims").select("code, amount, paid_on, ctype").eq("institution_id", inst).eq("status", "Paid").limit(5000),
    supabaseAdmin.from("acc_journal").select("id, voucher, entry_date, narration, amount, debit_code, credit_code").eq("institution_id", inst).limit(5000),
  ]);
  const out: Voucher[] = [];
  // fee receipts: one voucher a day for cash and one for bank, with the income split by fee type
  const days = new Map<string, { date: string; acc: string; n: number; income: Map<string, number>; concession: number }>();
  for (const p of pays) {
    const acc = book(p.mode); const k = `${p.paid_on}|${acc}`;
    const d = days.get(k) ?? { date: p.paid_on, acc, n: 0, income: new Map(), concession: 0 };
    d.n++; d.concession += p.concession;
    for (const l of p.fee_payment_lines) { const code = INCOME_OF[l.line_key.split(":")[1]] ?? "4101"; d.income.set(code, (d.income.get(code) ?? 0) + l.amount); }
    days.set(k, d);
  }
  for (const d of days.values()) {
    const gross = [...d.income.values()].reduce((n, v) => n + v, 0);
    const lines = [{ code: d.acc, dr: gross - d.concession, cr: 0 }, ...(d.concession ? [{ code: CONCESSION, dr: d.concession, cr: 0 }] : []), ...[...d.income.entries()].map(([code, v]) => ({ code, dr: 0, cr: v }))];
    out.push({ voucher: `RCPT-${d.date.replace(/-/g, "")}-${d.acc === CASH ? "CASH" : "BANK"}`, date: d.date, narration: `Fee receipts · ${d.n} receipt${d.n === 1 ? "" : "s"} · ${d.acc === CASH ? "cash" : "bank"}`, source: "Receipts", lines });
  }
  for (const f of check(fines) as { code: string; amount: number; mode: string | null; settled_on: string | null; reason: string }[]) out.push({ voucher: f.code, date: f.settled_on ?? today(), narration: `Fine · ${f.reason}`, source: "Fines", lines: [{ code: book(f.mode), dr: f.amount, cr: 0 }, { code: "4901", dr: 0, cr: f.amount }] });
  for (const r of check(refunds) as { code: string; amount: number; paid_on: string | null; reason: string }[]) out.push({ voucher: r.code, date: r.paid_on ?? today(), narration: `Refund · ${r.reason}`, source: "Refunds", lines: [{ code: "4101", dr: r.amount, cr: 0 }, { code: BANK, dr: 0, cr: r.amount }] });
  const byName = new Map(accounts.filter((a) => a.grp === "Expenses").map((a) => [a.name.toLowerCase(), a.code]));
  for (const e of check(exps) as unknown as { voucher: string; amount: number; mode: string | null; spent_on: string; paid_to: string; cat: { name: string } | { name: string }[] | null }[]) { const cat = one(e.cat)?.name ?? ""; out.push({ voucher: e.voucher, date: e.spent_on, narration: `${e.paid_to}${cat ? ` · ${cat}` : ""}`, source: "Expenses", lines: [{ code: byName.get(cat.toLowerCase()) ?? OTHER_EXP, dr: e.amount, cr: 0 }, { code: book(e.mode), dr: 0, cr: e.amount }] }); }
  for (const c of check(claims) as { code: string; amount: number; paid_on: string | null; ctype: string }[]) out.push({ voucher: c.code, date: c.paid_on ?? today(), narration: `Staff claim · ${c.ctype}`, source: "Claims", lines: [{ code: OTHER_EXP, dr: c.amount, cr: 0 }, { code: BANK, dr: 0, cr: c.amount }] });
  for (const m of check(manual) as { id: string; voucher: string; entry_date: string; narration: string; amount: number; debit_code: string; credit_code: string }[]) out.push({ voucher: m.voucher, date: m.entry_date, narration: m.narration, source: "Manual", manual_id: m.id, lines: [{ code: m.debit_code, dr: Number(m.amount), cr: 0 }, { code: m.credit_code, dr: 0, cr: Number(m.amount) }] });
  return out.sort((a, b) => (a.date === b.date ? (a.voucher < b.voucher ? -1 : 1) : a.date < b.date ? -1 : 1));
}

const total = (v: Voucher) => v.lines.reduce((n, l) => n + l.dr, 0);
const signed = (grp: Group, dr: number, cr: number) => (DEBIT_NATURE.includes(grp) ? dr - cr : cr - dr);

async function books(inst: string) {
  const accounts = await accountList(inst);
  const vs = await vouchers(inst, accounts);
  const bal = new Map(accounts.map((a) => [a.code, a.opening]));
  for (const v of vs) for (const l of v.lines) { const a = accounts.find((x) => x.code === l.code); if (a) bal.set(a.code, (bal.get(a.code) ?? 0) + signed(a.grp, l.dr, l.cr)); }
  return { accounts, vouchers: vs, balance: (code: string) => bal.get(code) ?? 0 };
}

// ═════════════ chart of accounts ═════════════
export async function chart(inst: string) {
  const b = await books(inst);
  return { items: b.accounts.map((a) => ({ code: a.code, name: a.name, grp: a.grp, balance: b.balance(a.code) })), groups: ["Assets", "Liabilities", "Fund", "Income", "Expenses"] };
}
export async function addAccount(inst: string, input: unknown) {
  const i = z.object({ code: z.string().trim().regex(/^\d{4}$/, "Use a four-digit code like 5802."), name: z.string().trim().min(2, "Enter the account name.").max(80), grp: z.enum(["Assets", "Liabilities", "Fund", "Income", "Expenses"]) }).strict().parse(input);
  const a = await accountList(inst);
  if (a.some((x) => x.code === i.code)) throw new HttpError(409, "That code is already used.");
  if (a.some((x) => x.name.toLowerCase() === i.name.toLowerCase())) throw new HttpError(409, "That account name is already used.");
  check(await supabaseAdmin.from("acc_accounts").insert({ institution_id: inst, code: i.code, name: i.name, grp: i.grp }).select("code"));
  return { ok: true };
}

// ═════════════ journal ═════════════
export async function journal(inst: string) {
  const b = await books(inst);
  const name = new Map(b.accounts.map((a) => [a.code, a.name]));
  return { accounts: b.accounts.map((a) => ({ code: a.code, name: a.name })), items: [...b.vouchers].reverse().map((v) => ({ voucher: v.voucher, date: v.date, narration: v.narration, source: v.source, amount: total(v), lines: v.lines.map((l) => ({ code: l.code, account: name.get(l.code) ?? l.code, dr: l.dr, cr: l.cr })) })) };
}
export async function addJournal(inst: string, profile: string, input: unknown) {
  const i = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date."), amount: z.number().int().min(1, "Enter the amount.").max(10_000_000_000), debit: z.string().regex(/^\d{4}$/), credit: z.string().regex(/^\d{4}$/), narration: z.string().trim().min(3, "Say what it is for.").max(200) }).strict().parse(input);
  if (i.debit === i.credit) throw new HttpError(400, "Choose two different accounts.");
  if (i.date > today()) throw new HttpError(400, "The date cannot be in the future.");
  const codes = new Set((await accountList(inst)).map((a) => a.code));
  if (!codes.has(i.debit) || !codes.has(i.credit)) throw new HttpError(400, "Choose accounts from the chart of accounts.");
  const n = (await supabaseAdmin.from("acc_journal").select("id", { count: "exact", head: true }).eq("institution_id", inst)).count ?? 0;
  const voucher = `JV-${String(n + 1).padStart(4, "0")}`;
  check(await supabaseAdmin.from("acc_journal").insert({ institution_id: inst, voucher, entry_date: i.date, narration: i.narration, amount: i.amount, debit_code: i.debit, credit_code: i.credit, created_by: profile }).select("id"));
  return { voucher };
}

// ═════════════ general ledger ═════════════
export async function ledger(inst: string, code: string) {
  const b = await books(inst);
  const acc = b.accounts.find((a) => a.code === code);
  if (!acc) throw new HttpError(404, "That account is not in the chart.");
  const ys = await yearStart(inst);
  let run = acc.opening;
  const items: { date: string; voucher: string; narration: string; debit: number; credit: number; balance: number }[] = [];
  if (acc.opening) items.push({ date: ys, voucher: "—", narration: "Opening balance", debit: 0, credit: 0, balance: run });
  for (const v of b.vouchers) for (const l of v.lines.filter((x) => x.code === code)) { run += signed(acc.grp, l.dr, l.cr); items.push({ date: v.date, voucher: v.voucher, narration: v.narration, debit: l.dr, credit: l.cr, balance: run }); }
  return { account: { code: acc.code, name: acc.name, grp: acc.grp }, accounts: b.accounts.map((a) => ({ code: a.code, name: a.name })), items, balance: b.balance(code) };
}

// ═════════════ statements ═════════════
export async function statements(inst: string) {
  const b = await books(inst);
  const ys = await yearStart(inst);
  const rows = b.accounts.map((a) => ({ ...a, balance: b.balance(a.code) }));
  const trial = rows.filter((r) => r.balance !== 0).map((r) => { const onDebit = DEBIT_NATURE.includes(r.grp) ? r.balance >= 0 : r.balance < 0; const v = Math.abs(r.balance); return { code: r.code, name: r.name, debit: onDebit ? v : 0, credit: onDebit ? 0 : v }; });
  const income = rows.filter((r) => r.grp === "Income" && r.balance !== 0 && r.code !== CONCESSION).map((r) => ({ name: r.name, amount: r.balance }));
  const concessions = rows.find((r) => r.code === CONCESSION)?.balance ?? 0;
  const expenses = rows.filter((r) => r.grp === "Expenses" && r.balance !== 0).map((r) => ({ name: r.name, amount: r.balance }));
  const totalIncome = income.reduce((n, x) => n + x.amount, 0) + concessions; // the concessions account carries a debit, so its balance is negative
  const totalExp = expenses.reduce((n, x) => n + x.amount, 0);
  const surplus = totalIncome - totalExp;
  const fund = rows.filter((r) => r.grp === "Fund" && r.balance !== 0).map((r) => ({ name: r.name, amount: r.balance }));
  const liabilities = rows.filter((r) => r.grp === "Liabilities" && r.balance !== 0).map((r) => ({ name: r.name, amount: r.balance }));
  const assets = rows.filter((r) => r.grp === "Assets" && r.balance !== 0).map((r) => ({ name: r.name, amount: r.balance }));
  const left = fund.reduce((n, x) => n + x.amount, 0) + surplus + liabilities.reduce((n, x) => n + x.amount, 0);
  const right = assets.reduce((n, x) => n + x.amount, 0);
  return {
    as_on: today(), from: ys,
    trial: { items: trial, debit: trial.reduce((n, x) => n + x.debit, 0), credit: trial.reduce((n, x) => n + x.credit, 0) },
    income_exp: { income, concessions, total_income: totalIncome, expenses, total_expenditure: totalExp, surplus },
    balance_sheet: { fund, surplus, liabilities, assets, total_left: left, total_assets: right, balanced: left === right },
  };
}

// ═════════════ bank reconciliation ═════════════
export async function bank(inst: string) {
  const b = await books(inst);
  const marks = new Set(((check(await supabaseAdmin.from("acc_bank_marks").select("voucher").eq("institution_id", inst).limit(20000)) ?? []) as { voucher: string }[]).map((x) => x.voucher));
  const since = (() => { const d = new Date(`${today().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
  const items = [...b.vouchers].reverse().flatMap((v) => v.lines.filter((l) => l.code === BANK).map((l) => ({ voucher: v.voucher, date: v.date, narration: v.narration, deposit: l.dr, withdrawal: l.cr, on_statement: marks.has(v.voucher) }))).filter((x) => x.date >= since);
  const pendingDeposits = items.filter((x) => !x.on_statement).reduce((n, x) => n + x.deposit, 0);
  const pendingPayments = items.filter((x) => !x.on_statement).reduce((n, x) => n + x.withdrawal, 0);
  const books_balance = b.balance(BANK);
  return { since, books: books_balance, pending_deposits: pendingDeposits, pending_payments: pendingPayments, statement: books_balance - pendingDeposits + pendingPayments, items };
}
export async function markBank(inst: string, profile: string, input: unknown) {
  const { voucher } = z.object({ voucher: z.string().trim().min(2).max(40) }).strict().parse(input);
  const b = await books(inst);
  if (!b.vouchers.some((v) => v.voucher === voucher && v.lines.some((l) => l.code === BANK))) throw new HttpError(404, "That entry is not in the bank account.");
  check(await supabaseAdmin.from("acc_bank_marks").upsert({ institution_id: inst, voucher, marked_on: today(), marked_by: profile }, { onConflict: "institution_id,voucher" }).select("voucher"));
  return { ok: true };
}
