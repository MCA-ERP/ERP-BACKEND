import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { schedule, yearStart } from "../school/fees.service";
import { expenseCategories } from "../school/fees3.service";

/** The accountant's expense pages (summary, vendors) and the student fee ledger. Dues and payments themselves stay in the School Admin fee services. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

// ═════════════ expense summary ═════════════
export async function expenseSummary(inst: string) {
  const ys = await yearStart(inst);
  const now = today(); const ms = now.slice(0, 7) + "-01";
  const rows = check(await supabaseAdmin.from("fee_expenses").select("amount, spent_on, status, cat:category_id(name)").eq("institution_id", inst).gte("spent_on", ys).limit(50000)) as unknown as { amount: number; spent_on: string; status: string; cat: { name: string } | { name: string }[] | null }[];
  const ok = rows.filter((r) => r.status === "Approved");
  const months: { key: string; label: string; total: number; current: boolean }[] = [];
  for (let d = new Date(`${ys.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= now.slice(0, 7); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), total: 0, current: d.toISOString().slice(0, 7) === now.slice(0, 7) });
  const heads = new Map<string, number>();
  for (const r of ok) { const m = months.find((x) => x.key === r.spent_on.slice(0, 7)); if (m) m.total += r.amount; const h = one(r.cat)?.name ?? "Other"; heads.set(h, (heads.get(h) ?? 0) + r.amount); }
  const waiting = rows.filter((r) => r.status === "Pending");
  return {
    year_start: ys, today: now,
    tiles: { month: ok.filter((r) => r.spent_on >= ms).reduce((n, r) => n + r.amount, 0), year: ok.reduce((n, r) => n + r.amount, 0), waiting: waiting.length, waiting_amount: waiting.reduce((n, r) => n + r.amount, 0), count: rows.length },
    by_month: months.map((m) => ({ label: m.label, total: m.total, current: m.current })),
    by_head: [...heads.entries()].sort((a, b) => b[1] - a[1]).map(([label, total]) => ({ label, total })),
  };
}

// ═════════════ vendors ═════════════
export async function vendors(inst: string) {
  const ys = await yearStart(inst);
  const [v, ex, cats] = await Promise.all([
    supabaseAdmin.from("fee_vendors").select("id, code, name, supplies, gstin, category_id, cat:category_id(name)").eq("institution_id", inst).order("code"),
    supabaseAdmin.from("fee_expenses").select("paid_to, amount").eq("institution_id", inst).eq("status", "Approved").gte("spent_on", ys).limit(50000),
    expenseCategories(inst),
  ]);
  const paid = new Map<string, number>();
  for (const e of (check(ex) ?? []) as { paid_to: string; amount: number }[]) paid.set(e.paid_to.toLowerCase(), (paid.get(e.paid_to.toLowerCase()) ?? 0) + e.amount);
  const items = ((check(v) ?? []) as unknown as { id: string; code: string; name: string; supplies: string; gstin: string | null; cat: { name: string } | { name: string }[] | null }[]).map((x) => ({ id: x.id, code: x.code, name: x.name, supplies: x.supplies, gstin: x.gstin, usual_head: one(x.cat)?.name ?? "—", paid_this_year: paid.get(x.name.toLowerCase()) ?? 0 }));
  return { items, categories: cats.items.filter((c) => c.status === "Active").map((c) => ({ id: c.id, name: c.name })) };
}

export async function addVendor(inst: string, profile: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the vendor's name.").max(120), supplies: z.string().trim().max(120).optional(), category_id: z.string().uuid().nullable().optional(), gstin: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, "A GSTIN has 15 letters and digits.").optional().or(z.literal("")) }).strict().parse(input);
  if (i.category_id) { const c = check(await supabaseAdmin.from("fee_expense_categories").select("id").eq("id", i.category_id).eq("institution_id", inst).maybeSingle()); if (!c) throw new HttpError(400, "Choose one of the expense heads."); }
  const dup = check(await supabaseAdmin.from("fee_vendors").select("id").eq("institution_id", inst).ilike("name", i.name).limit(1)) as unknown[];
  if (dup.length) throw new HttpError(409, "That vendor is already in the list.");
  const n = (await supabaseAdmin.from("fee_vendors").select("id", { count: "exact", head: true }).eq("institution_id", inst)).count ?? 0;
  return check(await supabaseAdmin.from("fee_vendors").insert({ institution_id: inst, code: `VN-${String(n + 1).padStart(2, "0")}`, name: i.name, supplies: i.supplies ?? "", category_id: i.category_id ?? null, gstin: i.gstin || null, created_by: profile }).select("id, code").single());
}

// ═════════════ student ledger ═════════════
export async function studentLedger(inst: string, studentId: string) {
  const s = await schedule(inst, studentId);
  const [pays, inv] = await Promise.all([
    supabaseAdmin.from("fee_payments").select("id, receipt_no, total, paid_on, mode, reference, created_at, fee_payment_lines(line_key, label, amount)").eq("institution_id", inst).eq("student_id", studentId).eq("status", "Paid").order("paid_on").limit(500),
    supabaseAdmin.from("fee_invoices").select("term, invoice_date").eq("institution_id", inst).eq("student_id", studentId),
  ]);
  const I = new Map(((check(inv) ?? []) as { term: number; invoice_date: string }[]).map((x) => [x.term, x.invoice_date]));
  type E = { date: string; order: number; particulars: string; debit: number; credit: number };
  const list: E[] = [];
  const now = today();
  for (const t of s.terms) if (t.amount > 0 && (t.paid > 0 || t.date <= now || I.has(t.term))) list.push({ date: I.get(t.term) ?? t.date, order: 0, particulars: `Demand · ${t.name}`, debit: t.amount, credit: 0 });
  for (const p of (check(pays) ?? []) as unknown as { receipt_no: string; total: number; paid_on: string; mode: string; reference: string | null; fee_payment_lines: { line_key: string; label: string; amount: number }[] }[]) {
    for (const l of p.fee_payment_lines.filter((x) => x.line_key.endsWith(":late"))) list.push({ date: p.paid_on, order: 1, particulars: l.label, debit: l.amount, credit: 0 });
    list.push({ date: p.paid_on, order: 2, particulars: `Receipt ${p.receipt_no} · ${p.reference ? p.reference.replace(/\s*·\s*pay_\w+$/, "") : p.mode}`, debit: 0, credit: p.total });
  }
  list.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
  let bal = 0;
  const items = list.map((e) => { bal += e.debit - e.credit; return { ...e, balance: bal }; });
  return { student: s.student, items, balance: bal };
}
