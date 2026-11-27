import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { createOrder, razorpayConfigured, verifyCheckoutSignature } from "../../lib/razorpay";
import { addConcession, collect, dues, receipt, schedule } from "../school/fees.service";
import { childOf, family, today, type Child } from "./parent-core";

/**
 * A family's fees. Amounts come from the same fee engine the School Admin and Fee & Finance portals use; an online payment
 * is a normal fee_payments row (collected at "Online"), so it shows there at once. The browser only says which fee lines it
 * wants to pay: the amount is worked out here, and a payment counts only after the gateway's signature checks out.
 */
const uid = z.string().uuid("Invalid id.");

type Pay = { id: string; receipt_no: string; total: number; paid_on: string; mode: string; collected_at: string; status: string };
async function payments(inst: string, studentId: string) {
  const rows = (check(await supabaseAdmin.from("fee_payments").select("id, receipt_no, total, paid_on, mode, collected_at, status").eq("institution_id", inst).eq("student_id", studentId).order("paid_on", { ascending: false }).order("created_at", { ascending: false }).limit(200)) ?? []) as Pay[];
  const ids = rows.filter((r) => r.status === "Paid").map((r) => r.id);
  const lines = (ids.length ? check(await supabaseAdmin.from("fee_payment_lines").select("payment_id, line_key, label").in("payment_id", ids)) : []) as { payment_id: string; line_key: string; label: string }[];
  return { rows, lines };
}

/** Term by term, with the receipt that paid each term. */
export async function termRows(inst: string, child: Child) {
  const [s, d, p] = await Promise.all([schedule(inst, child.id), dues(inst, child.id), payments(inst, child.id)]);
  const receipts = new Map(p.rows.map((r) => [r.id, r.receipt_no]));
  const terms = s.terms.filter((t) => t.amount > 0).map((t) => {
    const late = d.lines.filter((l) => l.term === t.term && l.key.endsWith(":late")).reduce((n, l) => n + l.due, 0);
    const nums = [...new Set(p.lines.filter((l) => l.line_key.startsWith(`T${t.term}:`)).map((l) => receipts.get(l.payment_id) ?? ""))].filter(Boolean);
    return { term: t.term, name: t.name, due_date: t.date, amount: t.amount + late, due: t.due + late, late, status: t.status === "Scheduled" ? "Upcoming" : t.status, receipt: nums.join(", ") };
  });
  return { has_plan: s.has_plan, terms, lines: d.lines, outstanding: d.outstanding, payments: p.rows };
}

/** One line for the dashboard tile and the sidebar badge. */
export async function feeSummary(inst: string, child: Child) {
  const f = await termRows(inst, child);
  const overdue = f.terms.filter((t) => t.status === "Overdue");
  const next = f.terms.find((t) => t.due > 0);
  return { has_plan: f.has_plan, overdue: overdue.reduce((n, t) => n + t.due, 0), overdue_terms: overdue, outstanding: f.outstanding, next: next ? { name: next.name, date: next.due_date, amount: next.due } : null };
}

export async function feeStatus(inst: string, me: string) {
  const fam = await family(inst, me);
  const items = await Promise.all(fam.children.map(async (c) => ({ student_id: c.id, name: c.name, class_label: c.class_label, ...(await termRows(inst, c)) })));
  return { items: items.map(({ lines: _l, payments: _p, ...x }) => x) };
}

export async function fees(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  const [f, con] = await Promise.all([
    termRows(inst, child),
    supabaseAdmin.from("fee_concessions").select("id, code, ctype, reason, amount, requested_on, status, source").eq("institution_id", inst).eq("student_id", child.id).order("requested_on", { ascending: false }).limit(100),
  ]);
  return {
    student: { id: child.id, name: child.name, class_label: child.class_label },
    online: razorpayConfigured(),
    ...f,
    concessions: (check(con) ?? []) as { id: string; code: string; ctype: string; reason: string; amount: number; requested_on: string; status: string; source: string }[],
  };
}

async function ownPayment(inst: string, me: string, paymentId: string) {
  const row = check(await supabaseAdmin.from("fee_payments").select("id, student_id, status").eq("id", uid.parse(paymentId)).eq("institution_id", inst).maybeSingle()) as { id: string; student_id: string; status: string } | null;
  const fam = await family(inst, me);
  if (!row || !fam.children.some((c) => c.id === row.student_id) || row.status !== "Paid") throw new HttpError(404, "Receipt not found.");
  return row;
}
export async function feeReceipt(inst: string, me: string, paymentId: string) {
  await ownPayment(inst, me, paymentId);
  return receipt(inst, paymentId);
}

const orderSchema = z.object({ student_id: uid, line_keys: z.array(z.string().max(20)).min(1, "Choose at least one fee.").max(40) }).strict();
export async function payOrder(inst: string, me: string, input: unknown) {
  const i = orderSchema.parse(input);
  const { fam, child } = await childOf(inst, me, i.student_id);
  const d = await dues(inst, child.id);
  const keys = [...new Set(i.line_keys)];
  const chosen = keys.map((k) => d.lines.find((l) => l.key === k));
  if (chosen.some((c) => !c)) throw new HttpError(409, "One of those fees is already paid or not due yet. Reload the page.");
  const amount = chosen.reduce((n, l) => n + (l?.due ?? 0), 0);
  if (amount <= 0) throw new HttpError(400, "There is nothing to pay.");
  if (!razorpayConfigured()) throw new HttpError(503, "Online payments are not set up for this school yet. Please pay at the school's fee counter.");
  const order = await createOrder({ amountPaise: amount * 100, receipt: `${child.registration_no}-${Date.now().toString(36)}`, notes: { institution_id: inst, student_id: child.id, purpose: "school_fee" } });
  // an earlier checkout of this parent that never finished is closed, so the fee office sees one open attempt at most
  check(await supabaseAdmin.from("fee_payments").update({ status: "Failed" }).eq("institution_id", inst).eq("student_id", child.id).eq("created_by", me).eq("collected_at", "Online").eq("status", "Pending").like("reference", "order%").select("id"));
  await collect(inst, { student_id: child.id, line_keys: keys, mode: "UPI", reference: order.id.slice(0, 60), concession: 0, collected_at: "Online", status: "Pending" }, me);
  return { order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID ?? "", name: child.name, parent: fam.guardian.full_name };
}

const verifySchema = z.object({ razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]{4,40}$/), razorpay_payment_id: z.string().min(1).max(60), razorpay_signature: z.string().min(1).max(200) }).strict();
export async function payVerify(inst: string, me: string, input: unknown) {
  const i = verifySchema.parse(input);
  const fam = await family(inst, me);
  const rows = (check(await supabaseAdmin.from("fee_payments").select("id, student_id, status, receipt_no, total, reference").eq("institution_id", inst).eq("created_by", me).eq("collected_at", "Online").like("reference", `${i.razorpay_order_id}%`).limit(5)) ?? []) as { id: string; student_id: string; status: string; receipt_no: string; total: number; reference: string }[];
  const p = rows.find((r) => r.reference.split(" ")[0] === i.razorpay_order_id && fam.children.some((c) => c.id === r.student_id));
  if (!p) throw new HttpError(404, "Payment not found.");
  if (!verifyCheckoutSignature(i.razorpay_order_id, i.razorpay_payment_id, i.razorpay_signature)) throw new HttpError(400, "The payment could not be verified. If money was taken it will be matched by the school.");
  if (p.status !== "Paid") check(await supabaseAdmin.from("fee_payments").update({ status: "Paid", paid_on: today(), reference: `${i.razorpay_order_id} ${i.razorpay_payment_id}`.slice(0, 60) }).eq("id", p.id).eq("institution_id", inst).in("status", ["Pending", "Failed"]).select("id"));
  return { ok: true, payment_id: p.id, receipt_no: p.receipt_no, total: p.total };
}

/** The gateway's own notice that money arrived (signature already checked by the webhook), for a browser closed too early. */
export async function settleFeeOrder(orderId: string, paymentId: string): Promise<boolean> {
  if (!/^order_[A-Za-z0-9]{4,40}$/.test(orderId)) return false;
  const rows = (check(await supabaseAdmin.from("fee_payments").select("id, institution_id, status, reference").eq("collected_at", "Online").like("reference", `${orderId}%`).limit(5)) ?? []) as { id: string; institution_id: string; status: string; reference: string }[];
  const p = rows.find((r) => r.reference.split(" ")[0] === orderId);
  if (!p) return false;
  if (p.status !== "Paid") check(await supabaseAdmin.from("fee_payments").update({ status: "Paid", paid_on: today(), reference: `${orderId} ${paymentId}`.slice(0, 60) }).eq("id", p.id).eq("institution_id", p.institution_id).in("status", ["Pending", "Failed"]).select("id"));
  return true;
}

export async function askConcession(inst: string, me: string, input: unknown) {
  const i = z.object({ student_id: uid, ctype: z.enum(["Scholarship", "Sibling", "Staff ward", "Financial aid", "Discount", "Fee waiver", "Other"]), reason: z.string().trim().min(3, "Tell the school why.").max(200), amount: z.number().int().min(1, "Enter the amount.").max(10_000_000) }).strict().parse(input);
  const { child } = await childOf(inst, me, i.student_id);
  const open = (check(await supabaseAdmin.from("fee_concessions").select("id").eq("institution_id", inst).eq("student_id", child.id).eq("source", "Parent").in("status", ["Pending", "Under review", "Info asked"]).limit(1)) ?? []) as unknown[];
  if (open.length) throw new HttpError(409, "A concession request for this child is already waiting for a decision.");
  return addConcession(inst, { student_id: child.id, ctype: i.ctype, reason: i.reason, amount: i.amount, source: "Parent" });
}
