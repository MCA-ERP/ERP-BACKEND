import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { parsePage, safeSearch } from "../../lib/query";
import * as razorpay from "../../lib/razorpay";
import { getSetting } from "../admin/settings.service";
import { quoteRenewal } from "./pricing";
import { emitEvent } from "../integrations/events";
import { appUrl, notifySchoolSafely } from "../messaging/messaging.service";

/** Throws unless this method may be recorded by hand (set under Payment gateway). */
async function assertMethodAllowed(method: string) {
  const allowed = await getSetting<string[]>("payments.manual_methods", [...METHODS]);
  if (!allowed.includes(method)) throw new HttpError(400, `${method} is not accepted. Allowed: ${allowed.join(", ")}.`);
}
async function assertOnlineEnabled() {
  if (!(await getSetting<boolean>("payments.online_enabled", true))) throw new HttpError(503, "Online payments are switched off. Please pay by another method or contact support.");
}

export const METHODS = ["UPI", "Card", "Net banking", "Bank transfer", "Cheque", "Cash", "Other"] as const;

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const longDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Run a SQL function; its RAISE EXCEPTION messages are written for people, so show them. */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) {
    if (error.code === "P0001") throw new HttpError(400, error.message);
    if (error.code === "23503") throw new HttpError(400, "A referenced record does not exist.");
    throw new HttpError(500, error.message);
  }
  return data as T;
}

interface ReceiptInvoice {
  number: string;
  institution_id: string;
  balance_paise: number;
}

/** Thank-you email after a payment. The payment id is the dedupe key, so a repeated webhook sends nothing twice. */
async function sendReceipt(inv: ReceiptInvoice, amountPaise: number, paymentId: string) {
  notifySchoolSafely(
    "payment_received", inv.institution_id,
    { invoice_number: inv.number, amount: rupees(amountPaise), date: longDate(day()) },
    { relatedType: "invoice", relatedId: paymentId, dedupe: `payment_received:${paymentId}`, channels: ["email"] }
  );
}

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unit_price_paise: number;
}

// ─────────────────────────────────────────────
//  Invoices
// ─────────────────────────────────────────────
export async function listInvoices(query: Record<string, unknown>, institutionId?: string) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("platform_invoice_overview")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (institutionId) q = q.eq("institution_id", institutionId);
  else if (query.school_id) q = q.eq("institution_id", String(query.school_id));
  if (query.status) q = q.eq("status", String(query.status));
  // tabs: generated = raised and not yet due, paid, unpaid = partly paid or overdue
  const groups: Record<string, string[]> = { generated: ["Issued"], paid: ["Paid"], unpaid: ["Partially paid", "Overdue"] };
  if (typeof query.group === "string" && groups[query.group]) q = q.in("status", groups[query.group]);
  const search = safeSearch(query.search);
  if (search) q = q.or(`number.ilike.%${search}%,school_name.ilike.%${search}%,description.ilike.%${search}%`);

  const res = await q;
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

export async function getInvoice(id: string, institutionId?: string) {
  let q = supabaseAdmin.from("platform_invoice_overview").select("*").eq("id", id);
  if (institutionId) q = q.eq("institution_id", institutionId);
  const invoice = check(await q.maybeSingle());
  if (!invoice) throw new HttpError(404, "Invoice not found.");

  const [lines, payments] = await Promise.all([
    supabaseAdmin.from("invoice_lines").select("id, description, quantity, unit_price_paise, amount_paise").eq("invoice_id", id).order("id"),
    supabaseAdmin
      .from("payments")
      .select("id, code, amount_paise, method, gateway, reference, paid_on, notes, refunds(id, amount_paise, reason, created_at)")
      .eq("invoice_id", id)
      .order("created_at"),
  ]);
  const footer = await getSetting<string>("billing.invoice_footer", "");
  return { invoice, lines: check(lines), payments: check(payments), footer };
}

export async function createInvoice(
  input: {
    institution_id: string;
    description: string;
    lines: InvoiceLineInput[];
    due_on?: string;
    period_start?: string | null;
    period_end?: string | null;
    gst_rate_percent?: number;
  },
  actorProfileId?: string
) {
  const [gst, terms] = await Promise.all([getSetting<number>("billing.gst_rate_percent", 18), getSetting<number>("billing.payment_terms_days", 15)]);
  const id = await rpc<string>("create_invoice", {
    p_institution: input.institution_id,
    p_description: input.description,
    p_lines: input.lines,
    p_due_on: input.due_on ?? day(terms),
    p_period_start: input.period_start ?? null,
    p_period_end: input.period_end ?? null,
    p_gst_rate: input.gst_rate_percent ?? gst,
    p_created_by: actorProfileId ?? null,
  });
  const created = await getInvoice(id);
  const inv = created.invoice as { number: string; school_code: string; total_paise: number; due_on: string };
  emitEvent("invoice.created", { id, number: inv.number, school_code: inv.school_code, total_paise: inv.total_paise, due_on: inv.due_on });
  notifySchoolSafely(
    "invoice_issued", (created.invoice as { institution_id: string }).institution_id,
    { invoice_number: inv.number, amount: rupees(inv.total_paise), date: longDate(inv.due_on), link: `${appUrl()}/school/billing` },
    { relatedType: "invoice", relatedId: id, dedupe: `invoice_issued:${id}`, channels: ["email"] }
  );
  return created;
}

/** Pre-filled renewal invoice: students x price per student for one billing period, with any special price, offer or coupon applied. */
export async function suggestInvoice(institutionId: string, couponCode?: string) {
  const q = await quoteRenewal(institutionId, { couponCode });
  return { description: q.description, period_start: q.period_start, period_end: q.period_end, lines: q.lines, note: q.note, pricing: q.applied };
}

export async function voidInvoice(id: string, reason: string) {
  await rpc("void_invoice", { p_invoice: id, p_reason: reason });
  return getInvoice(id);
}

// ─────────────────────────────────────────────
//  Payments and refunds
// ─────────────────────────────────────────────
export async function recordPayment(
  invoiceId: string,
  input: { amount_paise: number; method: (typeof METHODS)[number]; reference?: string | null; paid_on?: string; notes?: string | null },
  actorProfileId?: string
) {
  await assertMethodAllowed(input.method);
  const paymentId = await rpc<string>("record_payment", {
    p_invoice: invoiceId,
    p_amount: input.amount_paise,
    p_method: input.method,
    p_gateway: "manual",
    p_gateway_order_id: null,
    p_gateway_payment_id: null,
    p_reference: input.reference ?? null,
    p_paid_on: input.paid_on ?? day(),
    p_notes: input.notes ?? null,
    p_by: actorProfileId ?? null,
  });
  emitEvent("payment.received", { invoice_id: invoiceId, amount_paise: input.amount_paise, method: input.method, via: "recorded" });
  const after = await getInvoice(invoiceId);
  void sendReceipt(after.invoice as ReceiptInvoice, input.amount_paise, paymentId);
  return after;
}

export async function listPayments(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("payments")
    .select(
      "id, code, amount_paise, method, gateway, reference, paid_on, created_at, invoice_id, institution_id, " +
        "invoices:invoice_id(number), institutions:institution_id(name, code), refunds(amount_paise)",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (query.method) q = q.eq("method", String(query.method));
  if (query.gateway) q = q.eq("gateway", String(query.gateway));
  const search = safeSearch(query.search);
  if (search) q = q.or(`code.ilike.%${search}%,reference.ilike.%${search}%`);
  const res = await q;
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

export async function listRefunds() {
  return check(
    await supabaseAdmin
      .from("refunds")
      .select("id, amount_paise, reason, gateway_refund_id, created_at, payments:payment_id(code, method, invoices:invoice_id(number), institutions:institution_id(name))")
      .order("created_at", { ascending: false })
      .limit(200)
  );
}

export async function refundPayment(paymentId: string, input: { amount_paise?: number; reason: string }, actorProfileId?: string) {
  const payment = check(
    await supabaseAdmin
      .from("payments")
      .select("id, invoice_id, amount_paise, gateway, gateway_payment_id, refunds(amount_paise)")
      .eq("id", paymentId)
      .maybeSingle()
  ) as unknown as { id: string; invoice_id: string; amount_paise: number; gateway: string; gateway_payment_id: string | null; refunds: { amount_paise: number }[] } | null;
  if (!payment) throw new HttpError(404, "Payment not found.");

  const remaining = payment.amount_paise - payment.refunds.reduce((a, r) => a + r.amount_paise, 0);
  const amount = input.amount_paise ?? remaining;
  if (amount <= 0 || amount > remaining) throw new HttpError(400, `Only ${remaining} paise of this payment can still be refunded.`);

  // money returns through the gateway first, so a failed gateway call leaves no refund on record
  let gatewayRefundId: string | null = null;
  if (payment.gateway === "razorpay") {
    if (!payment.gateway_payment_id) throw new HttpError(400, "This payment has no gateway reference.");
    gatewayRefundId = (await razorpay.createRefund(payment.gateway_payment_id, amount, { reason: input.reason.slice(0, 200) })).id;
  }

  await rpc("refund_payment", {
    p_payment: paymentId,
    p_amount: amount,
    p_reason: input.reason,
    p_gateway_refund_id: gatewayRefundId,
    p_by: actorProfileId ?? null,
  });
  emitEvent("payment.refunded", { payment_id: paymentId, invoice_id: payment.invoice_id, amount_paise: amount });
  return getInvoice(payment.invoice_id);
}

// ─────────────────────────────────────────────
//  Gateway
// ─────────────────────────────────────────────
export function gatewayInfo() {
  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  return {
    razorpay: {
      configured: razorpay.razorpayConfigured(),
      keyHint: keyId ? `${keyId.slice(0, 8)}…${keyId.slice(-4)}` : null,
      mode: keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : null,
      webhookSecretSet: razorpay.webhookConfigured(),
      webhookPath: "/api/v1/webhooks/razorpay",
      webhookEvents: ["payment.captured", "payment.failed"],
    },
    manual: { methods: METHODS },
  };
}

// ─────────────────────────────────────────────
//  School side: pay online
// ─────────────────────────────────────────────
export async function createCheckoutOrder(institutionId: string, invoiceId: string) {
  await assertOnlineEnabled();
  const { invoice } = (await getInvoice(invoiceId, institutionId)) as { invoice: { number: string; status: string; balance_paise: number } };
  if (invoice.status === "Paid" || invoice.status === "Void") throw new HttpError(409, `This invoice is ${invoice.status.toLowerCase()}.`);
  if (invoice.balance_paise <= 0) throw new HttpError(409, "Nothing is due on this invoice.");

  const order = await razorpay.createOrder({
    amountPaise: invoice.balance_paise,
    receipt: invoice.number,
    notes: { invoice_id: invoiceId, invoice_number: invoice.number },
  });
  check(
    await supabaseAdmin
      .from("payment_orders")
      .insert({ order_id: order.id, invoice_id: invoiceId, institution_id: institutionId, amount_paise: order.amount })
      .select("order_id")
      .single()
  );
  return { key_id: process.env.RAZORPAY_KEY_ID, order_id: order.id, amount: order.amount, currency: order.currency, invoice_number: invoice.number };
}

const METHOD_MAP: Record<string, (typeof METHODS)[number]> = { card: "Card", upi: "UPI", netbanking: "Net banking" };

/** Settle a paid order once; safe to call from both the browser callback and the webhook. */
async function settleOrder(orderId: string, paymentId: string, gatewayMethod?: string) {
  const order = check(await supabaseAdmin.from("payment_orders").select("order_id, invoice_id, amount_paise, status").eq("order_id", orderId).maybeSingle()) as
    | { order_id: string; invoice_id: string; amount_paise: number; status: string }
    | null;
  if (!order) throw new HttpError(404, "Unknown payment order.");

  const settledPaymentId = await rpc<string>("record_payment", {
    p_invoice: order.invoice_id,
    p_amount: order.amount_paise,
    p_method: gatewayMethod ? (METHOD_MAP[gatewayMethod] ?? "Online") : "Online",
    p_gateway: "razorpay",
    p_gateway_order_id: orderId,
    p_gateway_payment_id: paymentId,
    p_reference: paymentId,
    p_paid_on: day(),
    p_notes: null,
    p_by: null,
  });
  await supabaseAdmin.from("payment_orders").update({ status: "paid" }).eq("order_id", orderId);
  emitEvent("payment.received", { invoice_id: order.invoice_id, amount_paise: order.amount_paise, method: gatewayMethod ?? "online", via: "online" });
  void getInvoice(order.invoice_id).then((d) => sendReceipt(d.invoice as ReceiptInvoice, order.amount_paise, settledPaymentId)).catch(() => undefined);
  return order.invoice_id;
}

export async function verifyCheckout(institutionId: string, input: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) {
  if (!razorpay.verifyCheckoutSignature(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature)) {
    throw new HttpError(400, "The payment could not be verified.");
  }
  const owned = check(
    await supabaseAdmin.from("payment_orders").select("order_id").eq("order_id", input.razorpay_order_id).eq("institution_id", institutionId).maybeSingle()
  );
  if (!owned) throw new HttpError(404, "Unknown payment order.");
  const invoiceId = await settleOrder(input.razorpay_order_id, input.razorpay_payment_id);
  return getInvoice(invoiceId, institutionId);
}

export async function handleRazorpayWebhook(rawBody: Buffer, signature: string, eventId: string | undefined) {
  if (!razorpay.verifyWebhookSignature(rawBody, signature)) throw new HttpError(400, "Invalid signature.");

  const event = JSON.parse(rawBody.toString("utf8")) as {
    event: string;
    payload?: { payment?: { entity?: { id: string; order_id?: string; method?: string; error_description?: string; error_reason?: string } } };
  };

  if (eventId) {
    const seen = await supabaseAdmin.from("gateway_events").insert({ id: eventId, type: event.event });
    if (seen.error) {
      if (seen.error.code === "23505") return { duplicate: true }; // already processed
      throw new HttpError(500, seen.error.message);
    }
  }

  const entity = event.payload?.payment?.entity;
  if (!entity?.order_id) return { ignored: true };

  if (event.event === "payment.captured") {
    await settleOrder(entity.order_id, entity.id, entity.method);
    return { settled: true };
  }
  if (event.event === "payment.failed") {
    await supabaseAdmin
      .from("payment_orders")
      .update({ status: "failed", gateway_payment_id: entity.id, method: entity.method ?? null, failure_reason: (entity.error_description ?? entity.error_reason ?? "The payment did not go through.").slice(0, 300), updated_at: new Date().toISOString() })
      .eq("order_id", entity.order_id)
      .eq("status", "created");
    return { failed: true };
  }
  return { ignored: true };
}

// ─────────────────────────────────────────────
//  Revenue analytics
// ─────────────────────────────────────────────
const fyOf = (iso: string) => {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(2)}`;
};

export async function getAnalytics() {
  const today = day();
  const [invoices, payments, refunds, open] = await Promise.all([
    supabaseAdmin.from("invoices").select("issue_date, total_paise").neq("status", "Void").limit(20000),
    supabaseAdmin.from("payments").select("paid_on, amount_paise").limit(20000),
    supabaseAdmin.from("refunds").select("created_at, amount_paise").limit(20000),
    supabaseAdmin
      .from("platform_invoice_overview")
      .select("id, number, school_name, description, due_on, total_paise, paid_paise, balance_paise, status")
      .in("status", ["Issued", "Partially paid", "Overdue"])
      .order("due_on")
      .limit(500),
  ]);

  const inv = check(invoices) as { issue_date: string; total_paise: number }[];
  const pay = check(payments) as { paid_on: string; amount_paise: number }[];
  const ref = check(refunds) as { created_at: string; amount_paise: number }[];
  const outstanding = check(open) as { id: string; number: string; school_name: string; description: string; due_on: string; balance_paise: number; status: string }[];

  // last 12 months
  const months: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  const monthly = months.map((month) => {
    const invoiced = inv.filter((r) => r.issue_date.startsWith(month)).reduce((a, r) => a + r.total_paise, 0);
    const collected = pay.filter((r) => r.paid_on.startsWith(month)).reduce((a, r) => a + r.amount_paise, 0);
    const refunded = ref.filter((r) => r.created_at.startsWith(month)).reduce((a, r) => a + r.amount_paise, 0);
    return { month, invoiced_paise: invoiced, collected_paise: collected, refunded_paise: refunded, net_paise: collected - refunded };
  });

  // by financial year
  const fys = new Map<string, { invoiced_paise: number; collected_paise: number; refunded_paise: number }>();
  const slot = (fy: string) => fys.get(fy) ?? fys.set(fy, { invoiced_paise: 0, collected_paise: 0, refunded_paise: 0 }).get(fy)!;
  inv.forEach((r) => (slot(fyOf(r.issue_date)).invoiced_paise += r.total_paise));
  pay.forEach((r) => (slot(fyOf(r.paid_on)).collected_paise += r.amount_paise));
  ref.forEach((r) => (slot(fyOf(r.created_at.slice(0, 10))).refunded_paise += r.amount_paise));
  const byFinancialYear = Array.from(fys.entries())
    .map(([fy, v]) => ({ fy, ...v, net_paise: v.collected_paise - v.refunded_paise }))
    .sort((a, b) => b.fy.localeCompare(a.fy));

  // ageing of what is still owed
  const daysLate = (due: string) => Math.floor((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${due}T00:00:00Z`).getTime()) / 86_400_000);
  const buckets = [
    { label: "Not yet due", from: -Infinity, to: 0 },
    { label: "1–30 days late", from: 1, to: 30 },
    { label: "31–60 days late", from: 31, to: 60 },
    { label: "Over 60 days late", from: 61, to: Infinity },
  ].map((b) => {
    const rows = outstanding.filter((o) => daysLate(o.due_on) >= b.from && daysLate(o.due_on) <= b.to);
    return { label: b.label, count: rows.length, total_paise: rows.reduce((a, r) => a + r.balance_paise, 0) };
  });

  const thisMonth = monthly[monthly.length - 1];
  const currentFy = byFinancialYear.find((f) => f.fy === fyOf(today));
  return {
    totals: {
      collected_this_month_paise: thisMonth.net_paise,
      collected_this_fy_paise: currentFy?.net_paise ?? 0,
      outstanding_paise: outstanding.reduce((a, r) => a + r.balance_paise, 0),
      overdue_paise: outstanding.filter((r) => r.status === "Overdue").reduce((a, r) => a + r.balance_paise, 0),
    },
    monthly,
    byFinancialYear,
    ageing: buckets,
    outstanding: outstanding.map((o) => ({ ...o, days_late: Math.max(0, daysLate(o.due_on)) })),
  };
}
