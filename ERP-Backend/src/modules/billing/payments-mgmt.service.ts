import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { parsePage, safeSearch } from "../../lib/query";
import * as razorpay from "../../lib/razorpay";
import { getSetting, getSettings, updateSettings } from "../admin/settings.service";
import { METHODS, refundPayment } from "./billing.service";

const today = () => new Date().toISOString().slice(0, 10);

// ═════════════ transactions (successful payments and online attempts) ═════════════
export interface Tx {
  key: string;
  status: "successful" | "failed" | "pending";
  code: string;
  amount_paise: number;
  refunded_paise: number;
  method: string | null;
  gateway: string;
  reference: string | null;
  school: string | null;
  invoice_number: string | null;
  kind: "renewal" | "subscription";
  reason: string | null;
  at: string;
  payment_id: string | null;
}

/** Everything that was tried or received: payments, plus online attempts that are still open or failed. */
export async function listTransactions(query: Record<string, unknown>) {
  const p = parsePage(query);
  const status = ["successful", "failed", "pending"].includes(String(query.status)) ? String(query.status) : "";
  const kind = query.kind === "renewal" || query.kind === "subscription" ? String(query.kind) : "";
  const method = typeof query.method === "string" && query.method ? query.method : "";
  const search = safeSearch(query.search);
  const limit = p.to + 1;

  const payQ = () => {
    let q = supabaseAdmin
      .from("payments")
      .select("id, code, amount_paise, method, gateway, reference, created_at, invoices:invoice_id!inner(number, renews_subscription_id), institutions:institution_id(name), refunds(amount_paise)", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (kind === "renewal") q = q.not("invoices.renews_subscription_id", "is", null);
    if (kind === "subscription") q = q.is("invoices.renews_subscription_id", null);
    if (method) q = q.eq("method", method);
    if (search) q = q.or(`code.ilike.%${search}%,reference.ilike.%${search}%`);
    return q;
  };
  const orderQ = (st: "created" | "failed") => {
    let q = supabaseAdmin
      .from("payment_orders")
      .select("order_id, amount_paise, method, failure_reason, created_at, gateway_payment_id, invoices:invoice_id!inner(number, renews_subscription_id), institutions:institution_id(name)", { count: "exact" })
      .eq("status", st)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (kind === "renewal") q = q.not("invoices.renews_subscription_id", "is", null);
    if (kind === "subscription") q = q.is("invoices.renews_subscription_id", null);
    if (method) q = q.eq("method", method);
    if (search) q = q.ilike("order_id", `%${search}%`);
    return q;
  };

  const empty = Promise.resolve({ data: [], count: 0, error: null });
  const [pay, pend, fail] = await Promise.all([
    !status || status === "successful" ? payQ() : (empty as never),
    !status || status === "pending" ? orderQ("created") : (empty as never),
    !status || status === "failed" ? orderQ("failed") : (empty as never),
  ]);

  const renewal = (inv: { renews_subscription_id: string | null } | null) => (inv?.renews_subscription_id ? "renewal" : "subscription") as Tx["kind"];
  const rows: Tx[] = [];
  for (const r of check(pay) as any[]) {
    rows.push({ key: r.id, status: "successful", code: r.code, amount_paise: r.amount_paise, refunded_paise: (r.refunds ?? []).reduce((a: number, x: { amount_paise: number }) => a + x.amount_paise, 0), method: r.method, gateway: r.gateway, reference: r.reference, school: r.institutions?.name ?? null, invoice_number: r.invoices?.number ?? null, kind: renewal(r.invoices), reason: null, at: r.created_at, payment_id: r.id });
  }
  for (const [list, st] of [[pend, "pending"], [fail, "failed"]] as const) {
    for (const r of check(list) as any[]) {
      rows.push({ key: r.order_id, status: st, code: r.order_id, amount_paise: r.amount_paise, refunded_paise: 0, method: r.method, gateway: "razorpay", reference: r.gateway_payment_id, school: r.institutions?.name ?? null, invoice_number: r.invoices?.number ?? null, kind: renewal(r.invoices), reason: st === "failed" ? r.failure_reason ?? "The payment did not go through." : "Started, not completed yet", at: r.created_at, payment_id: null });
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));

  const countOf = (r: { count: number | null }) => r.count ?? 0;
  const counts = { successful: countOf(pay), pending: countOf(pend), failed: countOf(fail) };
  return {
    items: rows.slice(p.from, p.to + 1), total: counts.successful + counts.pending + counts.failed, page: p.page, pageSize: p.pageSize,
    counts,
  };
}

// ═════════════ refund requests ═════════════
type Actor = { profileId?: string; name: string };

export async function createRefundRequest(paymentId: string, input: { amount_paise?: number; reason: string }, actor: Actor) {
  const pay = check(
    await supabaseAdmin.from("payments").select("id, invoice_id, institution_id, amount_paise, refunds(amount_paise)").eq("id", paymentId).maybeSingle()
  ) as unknown as { id: string; invoice_id: string; institution_id: string; amount_paise: number; refunds: { amount_paise: number }[] } | null;
  if (!pay) throw new HttpError(404, "Payment not found.");
  const remaining = pay.amount_paise - pay.refunds.reduce((a, r) => a + r.amount_paise, 0);
  const amount = input.amount_paise ?? remaining;
  if (amount <= 0 || amount > remaining) throw new HttpError(400, `Only ${remaining / 100} rupees of this payment can still be refunded.`);

  const res = await supabaseAdmin
    .from("refund_requests")
    .insert({ payment_id: pay.id, invoice_id: pay.invoice_id, institution_id: pay.institution_id, amount_paise: amount, reason: input.reason, requested_by: actor.profileId ?? null, requester_name: actor.name })
    .select()
    .single();
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, "This payment already has a refund request waiting for a decision.");
    throw new HttpError(500, res.error.message);
  }
  return res.data;
}

export async function listRefundRequests(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("refund_requests")
    .select("id, amount_paise, reason, status, requester_name, decider_name, decision_note, decided_at, last_error, created_at, payments:payment_id(code, method, gateway), invoices:invoice_id(number), institutions:institution_id(name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (["pending", "approved", "rejected"].includes(String(query.status))) q = q.eq("status", String(query.status));
  const res = await q;
  const open = await supabaseAdmin.from("refund_requests").select("*", { count: "exact", head: true }).eq("status", "pending");
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize, pending: open.count ?? 0 };
}

/** Approving pays the money back, through the gateway for online payments. */
export async function decideRefundRequest(id: string, approve: boolean, note: string | undefined, actor: Actor, actorRole?: string) {
  const r = check(await supabaseAdmin.from("refund_requests").select("*").eq("id", id).maybeSingle()) as
    | { id: string; payment_id: string; amount_paise: number; reason: string; status: string; requested_by: string | null } | null;
  if (!r) throw new HttpError(404, "Request not found.");
  if (r.status !== "pending") throw new HttpError(409, "This request has already been decided.");
  if (!approve && !note?.trim()) throw new HttpError(400, "Say why the request is turned down.");
  // two people for every refund, unless a Super Administrator is acting alone
  if (approve && r.requested_by && r.requested_by === actor.profileId && actorRole !== "SuperAdmin") {
    throw new HttpError(403, "Someone else must approve a refund you asked for.");
  }

  let refundId: string | null = null;
  if (approve) {
    try {
      await refundPayment(r.payment_id, { amount_paise: r.amount_paise, reason: r.reason }, actor.profileId);
    } catch (err) {
      await supabaseAdmin.from("refund_requests").update({ last_error: err instanceof Error ? err.message : "The refund failed." }).eq("id", id);
      throw err;
    }
    const latest = check(await supabaseAdmin.from("refunds").select("id").eq("payment_id", r.payment_id).order("created_at", { ascending: false }).limit(1)) as { id: string }[];
    refundId = latest[0]?.id ?? null;
  }
  check(
    await supabaseAdmin
      .from("refund_requests")
      .update({ status: approve ? "approved" : "rejected", decided_by: actor.profileId ?? null, decider_name: actor.name, decision_note: note?.trim() || null, decided_at: new Date().toISOString(), refund_id: refundId, last_error: null })
      .eq("id", id)
      .select("id")
      .single()
  );
  return { success: true };
}

// ═════════════ gateway ═════════════
export const PAY_SETTING_KEYS = ["payments.online_enabled", "payments.manual_methods"] as const;

export async function getPaymentSettings() {
  const s = await getSettings();
  return { online_enabled: s["payments.online_enabled"] !== false, manual_methods: (s["payments.manual_methods"] as string[] | undefined) ?? [...METHODS], all_methods: METHODS };
}

export async function updatePaymentSettings(input: { online_enabled?: boolean; manual_methods?: string[] }, profileId?: string) {
  const values: Record<string, unknown> = {};
  if (input.online_enabled !== undefined) values["payments.online_enabled"] = input.online_enabled;
  if (input.manual_methods) {
    const bad = input.manual_methods.filter((m) => !(METHODS as readonly string[]).includes(m));
    if (bad.length) throw new HttpError(400, `Unknown method(s): ${bad.join(", ")}`);
    if (!input.manual_methods.length) throw new HttpError(400, "Keep at least one way to record a payment.");
    values["payments.manual_methods"] = input.manual_methods;
  }
  if (Object.keys(values).length) await updateSettings(values, profileId);
  return getPaymentSettings();
}

/** Asks Razorpay for one payment to prove the keys work. Reads only; nothing is created. */
export async function testGateway() {
  if (!razorpay.razorpayConfigured()) return { ok: false, message: "No keys are set. Add them to the backend .env first." };
  const started = Date.now();
  try {
    const res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
      headers: { Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64") },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
    if (res.ok) return { ok: true, message: `Connected (${res.status}) in ${Date.now() - started} ms.` };
    return { ok: false, message: res.status === 401 ? "Razorpay rejected the keys. Check the key id and secret." : body.error?.description ?? `Razorpay answered ${res.status}.` };
  } catch {
    return { ok: false, message: "Could not reach Razorpay from the server." };
  }
}

export async function recentGatewayEvents() {
  return check(await supabaseAdmin.from("gateway_events").select("id, type, received_at").order("received_at", { ascending: false }).limit(25));
}

// ═════════════ tax ═════════════
export const TAX_KEYS = ["billing.gst_rate_percent", "general.gst_number", "billing.supplier_state", "billing.sac_code"] as const;

export async function getTaxSettings() {
  const s = await getSettings();
  return { settings: Object.fromEntries(TAX_KEYS.map((k) => [k, s[k] ?? ""])) };
}
export async function updateTaxSettings(values: Record<string, unknown>, profileId?: string) {
  const bad = Object.keys(values).filter((k) => !(TAX_KEYS as readonly string[]).includes(k));
  if (bad.length) throw new HttpError(400, `Not a tax setting: ${bad.join(", ")}`);
  await updateSettings(values, profileId);
  return getTaxSettings();
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

interface TaxRow {
  number: string; issue_date: string; school: string; gstin: string | null; state: string | null; place: "Within state" | "Other state" | "Unknown";
  taxable_paise: number; rate: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number;
}

/** GST on the invoices issued in a month: same-state invoices split into CGST and SGST, others are IGST. */
export async function taxReport(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "Use a month like 2026-11.");
  const supplier = norm(await getSetting<string>("billing.supplier_state", ""));
  if (!supplier) throw new HttpError(400, "Set your state under GST settings first, so tax can be split into CGST, SGST and IGST.");

  const from = `${month}-01`;
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const inv = check(
    await supabaseAdmin
      .from("invoices")
      .select("number, issue_date, subtotal_paise, gst_rate_percent, tax_paise, total_paise, institutions:institution_id(name, state, gst_number)")
      .neq("status", "Void")
      .gte("issue_date", from)
      .lt("issue_date", next)
      .order("issue_date")
      .limit(5000)
  ) as unknown as { number: string; issue_date: string; subtotal_paise: number; gst_rate_percent: number; tax_paise: number; total_paise: number; institutions: { name: string; state: string | null; gst_number: string | null } | null }[];

  const rows: TaxRow[] = inv.map((i) => {
    const st = norm(i.institutions?.state);
    const place: TaxRow["place"] = !st ? "Unknown" : st === supplier ? "Within state" : "Other state";
    const intra = place === "Within state";
    const cgst = intra ? Math.floor(i.tax_paise / 2) : 0;
    return {
      number: i.number, issue_date: i.issue_date, school: i.institutions?.name ?? "", gstin: i.institutions?.gst_number ?? null, state: i.institutions?.state ?? null, place,
      taxable_paise: i.subtotal_paise, rate: Number(i.gst_rate_percent), cgst_paise: cgst, sgst_paise: intra ? i.tax_paise - cgst : 0, igst_paise: intra ? 0 : i.tax_paise, total_paise: i.total_paise,
    };
  });
  const sum = (f: (r: TaxRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  return {
    month, supplier_state: supplier, rows,
    summary: {
      invoices: rows.length, taxable_paise: sum((r) => r.taxable_paise), cgst_paise: sum((r) => r.cgst_paise), sgst_paise: sum((r) => r.sgst_paise), igst_paise: sum((r) => r.igst_paise),
      tax_paise: sum((r) => r.cgst_paise + r.sgst_paise + r.igst_paise), total_paise: sum((r) => r.total_paise),
      unknown_state: rows.filter((r) => r.place === "Unknown").length, missing_gstin: rows.filter((r) => !r.gstin).length,
    },
  };
}

/** GST per month for the last 12 months, to pick the month to file. */
export async function taxMonths() {
  const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
  const inv = check(await supabaseAdmin.from("invoices").select("issue_date, subtotal_paise, tax_paise").neq("status", "Void").gte("issue_date", since).limit(20000)) as { issue_date: string; subtotal_paise: number; tax_paise: number }[];
  const months: { month: string; invoices: number; taxable_paise: number; tax_paise: number }[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    const rows = inv.filter((r) => r.issue_date.startsWith(m));
    months.push({ month: m, invoices: rows.length, taxable_paise: rows.reduce((a, r) => a + r.subtotal_paise, 0), tax_paise: rows.reduce((a, r) => a + r.tax_paise, 0) });
  }
  return { months };
}

// ═════════════ daily revenue ═════════════
export async function dailyRevenue(month: string | undefined) {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : today().slice(0, 7);
  const from = `${m}-01`;
  const next = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const [pay, ref, inv] = await Promise.all([
    supabaseAdmin.from("payments").select("paid_on, amount_paise").gte("paid_on", from).lt("paid_on", next).limit(20000),
    supabaseAdmin.from("refunds").select("created_at, amount_paise").gte("created_at", from).lt("created_at", next).limit(20000),
    supabaseAdmin.from("invoices").select("issue_date, total_paise").neq("status", "Void").gte("issue_date", from).lt("issue_date", next).limit(20000),
  ]);
  const p = check(pay) as { paid_on: string; amount_paise: number }[];
  const r = check(ref) as { created_at: string; amount_paise: number }[];
  const i = check(inv) as { issue_date: string; total_paise: number }[];
  const days = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  const out = Array.from({ length: days }, (_, k) => {
    const d = `${m}-${String(k + 1).padStart(2, "0")}`;
    const collected = p.filter((x) => x.paid_on === d).reduce((a, x) => a + x.amount_paise, 0);
    const refunded = r.filter((x) => x.created_at.startsWith(d)).reduce((a, x) => a + x.amount_paise, 0);
    const invoiced = i.filter((x) => x.issue_date === d).reduce((a, x) => a + x.total_paise, 0);
    return { date: d, invoiced_paise: invoiced, collected_paise: collected, refunded_paise: refunded, net_paise: collected - refunded, payments: p.filter((x) => x.paid_on === d).length };
  });
  return { month: m, days: out, totals: { invoiced_paise: out.reduce((a, d) => a + d.invoiced_paise, 0), collected_paise: out.reduce((a, d) => a + d.collected_paise, 0), refunded_paise: out.reduce((a, d) => a + d.refunded_paise, 0), net_paise: out.reduce((a, d) => a + d.net_paise, 0) } };
}
