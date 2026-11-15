import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { parsePage, safeSearch } from "../../lib/query";
import { assertFitsPlan, usage } from "../../lib/plan-limits";
import { clearEntitlementCache } from "../../lib/entitlements";
import { createInvoice } from "../billing/billing.service";
import { quoteRenewal, couponProblem, type Cycle, type CouponRow } from "../billing/pricing";
import { getSetting, getSettings, updateSettings } from "./settings.service";
import { changeSchoolPlan, setSchoolStatus } from "./schools.service";
import { logEvent, statusAction, type Actor } from "./school-mgmt.service";

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10);

// ═════════════ plans ═════════════
const PLAN_SELECT = "id, code, name, description, price_per_student_paise, student_limit, staff_limit, campus_limit, storage_gb, trial_days, sort_order, is_active";

export async function listPlansFull() {
  const [plans, subs, mods] = await Promise.all([
    supabaseAdmin.from("plans").select(PLAN_SELECT).order("sort_order"),
    supabaseAdmin.from("subscriptions").select("plan_id").eq("is_current", true),
    supabaseAdmin.from("plan_modules").select("plan_id"),
  ]);
  const count = (rows: { plan_id: string }[]) => {
    const m = new Map<string, number>();
    rows.forEach((r) => m.set(r.plan_id, (m.get(r.plan_id) ?? 0) + 1));
    return m;
  };
  const schools = count(check(subs) as { plan_id: string }[]);
  const modules = count(check(mods) as { plan_id: string }[]);
  return (check(plans) as { id: string }[]).map((p) => ({ ...p, schools: schools.get(p.id) ?? 0, module_count: modules.get(p.id) ?? 0 }));
}

export const planFields = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  price_per_student_paise: z.number().int().min(0).max(10_000_000),
  student_limit: z.number().int().min(1).nullable(),
  staff_limit: z.number().int().min(1).nullable(),
  campus_limit: z.number().int().min(1).nullable(),
  storage_gb: z.number().int().min(1).nullable(),
  trial_days: z.number().int().min(0).max(90).nullable(),
  sort_order: z.number().int().min(0).max(1000),
});

export async function createPlan(input: z.infer<typeof planFields> & { code: string }, actor: Actor) {
  const res = await supabaseAdmin.from("plans").insert(input).select(PLAN_SELECT).single();
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, `A plan with code '${input.code}' already exists.`);
    throw new HttpError(500, res.error.message);
  }
  void actor;
  return res.data;
}

/** A price change applies to renewals issued from now on; invoices already issued keep their price. */
export async function updatePlan(id: string, patch: Partial<z.infer<typeof planFields>>) {
  const row = check(await supabaseAdmin.from("plans").update(patch).eq("id", id).select(PLAN_SELECT).maybeSingle());
  if (!row) throw new HttpError(404, "Plan not found.");
  clearEntitlementCache();
  return row;
}

export async function setPlanActive(id: string, active: boolean) {
  if (!active) {
    const used = await supabaseAdmin.from("subscriptions").select("*", { count: "exact", head: true }).eq("plan_id", id).eq("is_current", true);
    if ((used.count ?? 0) > 0) throw new HttpError(409, `${used.count} school(s) are still on this plan. Move them first.`);
  }
  const row = check(await supabaseAdmin.from("plans").update({ is_active: active }).eq("id", id).select(PLAN_SELECT).maybeSingle());
  if (!row) throw new HttpError(404, "Plan not found.");
  return row;
}

// ═════════════ subscriptions ═════════════
const GROUPS: Record<string, string[]> = { active: ["Active", "Overdue"], trial: ["Trial"], expired: ["Expired"] };

export async function listSubscriptions(query: Record<string, unknown>) {
  const p = parsePage(query);
  const group = String(query.group ?? "active");
  const search = safeSearch(query.search);

  const cancelledIds = (check(await supabaseAdmin.from("subscriptions").select("institution_id").eq("is_current", true).not("cancelled_at", "is", null)) as { institution_id: string }[]).map((r) => r.institution_id);

  let q = supabaseAdmin
    .from("platform_school_overview")
    .select("id, code, name, status, plan_code, plan_name, price_per_student_paise, renews_on, trial_ends_on, students, arr_paise", { count: "exact" })
    .order("name")
    .range(p.from, p.to);
  if (group === "cancelled") {
    if (!cancelledIds.length) return { items: [], total: 0, page: p.page, pageSize: p.pageSize, cancelled: 0 };
    q = q.in("id", cancelledIds);
  } else {
    q = q.in("status", GROUPS[group] ?? GROUPS.active);
    if (cancelledIds.length) q = q.not("id", "in", `(${cancelledIds.join(",")})`);
  }
  if (typeof query.plan === "string" && /^[a-z0-9_-]{1,30}$/.test(query.plan)) q = q.eq("plan_code", query.plan);
  if (search) q = q.or(`name.ilike.%${search}%,code.ilike.%${search}%`);
  const res = await q;
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize, cancelled: cancelledIds.length };
}

export async function getSchoolSubscription(id: string) {
  const [overview, sub, inst, u, pending, special, invoices] = await Promise.all([
    supabaseAdmin.from("platform_school_overview").select("*").eq("id", id).maybeSingle(),
    supabaseAdmin.from("subscriptions").select("id, started_on, renews_on, trial_ends_on, billing_cycle, cancelled_at, cancel_reason, plans:plan_id(id, code, name, description, price_per_student_paise, student_limit, staff_limit, campus_limit, storage_gb)").eq("institution_id", id).eq("is_current", true).maybeSingle(),
    supabaseAdmin.from("institutions").select("status_reason").eq("id", id).maybeSingle(),
    usage(id),
    supabaseAdmin.from("subscription_requests").select("id, kind, note, created_at, to_plan:to_plan_id(name)").eq("institution_id", id).eq("status", "pending").maybeSingle(),
    supabaseAdmin.from("school_pricing").select("*").eq("institution_id", id).order("created_at", { ascending: false }),
    supabaseAdmin.from("platform_invoice_overview").select("id, number, description, due_on, total_paise, paid_paise, status").eq("institution_id", id).order("issue_date", { ascending: false }).limit(5),
  ]);
  const school = check(overview);
  if (!school) throw new HttpError(404, "School not found.");
  let quote = null;
  try {
    quote = await quoteRenewal(id);
  } catch {
    /* a school without a plan has nothing to quote */
  }
  return {
    school, subscription: check(sub), status_reason: (check(inst) as { status_reason: string | null } | null)?.status_reason ?? null,
    usage: u, pending_request: check(pending), special_pricing: check(special), recent_invoices: check(invoices), quote,
  };
}

export async function setCycle(id: string, cycle: Cycle, actor: Actor) {
  const row = check(await supabaseAdmin.from("subscriptions").update({ billing_cycle: cycle }).eq("institution_id", id).eq("is_current", true).select("id").maybeSingle());
  if (!row) throw new HttpError(404, "This school has no current subscription.");
  await logEvent(id, "cycle_changed", `Billing cycle set to ${cycle}`, actor);
  return getSchoolSubscription(id);
}

export async function cancelSubscription(id: string, reason: string, actor: Actor) {
  if (!reason.trim()) throw new HttpError(400, "Say why the school is leaving.");
  const sub = check(await supabaseAdmin.from("subscriptions").select("id, cancelled_at").eq("institution_id", id).eq("is_current", true).maybeSingle()) as { id: string; cancelled_at: string | null } | null;
  if (!sub) throw new HttpError(404, "This school has no current subscription.");
  if (sub.cancelled_at) throw new HttpError(409, "This subscription is already cancelled.");
  check(await supabaseAdmin.from("subscriptions").update({ cancelled_at: new Date().toISOString(), cancel_reason: reason.trim() }).eq("id", sub.id).select("id").single());
  await statusAction(id, "deactivate", `Cancelled: ${reason.trim()}`, actor).catch(async () => {
    // already inactive, suspended or pending: the cancellation is still recorded
    clearEntitlementCache(id);
  });
  await logEvent(id, "cancelled", `Subscription cancelled. Reason: ${reason.trim()}`, actor);
  return getSchoolSubscription(id);
}

export async function reinstateSubscription(id: string, actor: Actor) {
  const sub = check(await supabaseAdmin.from("subscriptions").select("id, cancelled_at").eq("institution_id", id).eq("is_current", true).maybeSingle()) as { id: string; cancelled_at: string | null } | null;
  if (!sub?.cancelled_at) throw new HttpError(409, "This subscription is not cancelled.");
  check(await supabaseAdmin.from("subscriptions").update({ cancelled_at: null, cancel_reason: null }).eq("id", sub.id).select("id").single());
  await statusAction(id, "reactivate", undefined, actor).catch(() => undefined);
  await logEvent(id, "reinstated", "Cancelled subscription reinstated", actor);
  return getSchoolSubscription(id);
}

// ═════════════ renewals ═════════════
export async function upcomingRenewals(days = 90) {
  const limit = addDays(today(), Math.min(365, Math.max(1, days)));
  const rows = check(
    await supabaseAdmin
      .from("platform_school_overview")
      .select("id, code, name, status, plan_code, plan_name, renews_on, students, arr_paise, price_per_student_paise")
      .in("status", ["Active", "Overdue"])
      .not("renews_on", "is", null)
      .lte("renews_on", limit)
      .order("renews_on")
  ) as { id: string; renews_on: string }[];
  const open = check(
    await supabaseAdmin.from("invoices").select("institution_id, number, status").not("renews_subscription_id", "is", null).eq("status", "Issued")
  ) as { institution_id: string; number: string }[];
  const openBy = new Map(open.map((o) => [o.institution_id, o.number]));
  return rows.map((r) => ({ ...r, open_invoice: openBy.get((r as unknown as { id: string }).id) ?? null }));
}

export async function renewalHistory(query: Record<string, unknown>) {
  const p = parsePage(query);
  const res = await supabaseAdmin
    .from("school_events")
    .select("id, type, summary, created_at, institution_id, institutions:institution_id(name, code)", { count: "exact" })
    .in("type", ["renewed", "plan_changed", "lapsed", "expired", "trial_expired", "cancelled", "reinstated", "plan_request_approved"])
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

/** Preview, or issue, the renewal invoice for a school. */
export async function renewalPreview(id: string, couponCode?: string, cycle?: Cycle) {
  return quoteRenewal(id, { couponCode, cycle });
}

export async function issueRenewal(id: string, opts: { couponCode?: string; cycle?: Cycle }, actor: Actor) {
  const sub = check(await supabaseAdmin.from("subscriptions").select("id, cancelled_at").eq("institution_id", id).eq("is_current", true).maybeSingle()) as { id: string; cancelled_at: string | null } | null;
  if (!sub) throw new HttpError(400, "This school has no current subscription.");
  if (sub.cancelled_at) throw new HttpError(409, "This subscription is cancelled. Reinstate it first.");
  const open = await supabaseAdmin.from("invoices").select("number").eq("renews_subscription_id", sub.id).eq("status", "Issued").limit(1);
  if (open.data?.length) throw new HttpError(409, `Renewal invoice ${open.data[0].number} is still unpaid.`);

  const quote = await quoteRenewal(id, opts);

  // claim the coupon first so two people cannot both use its last redemption
  if (quote.coupon_id) await redeemCoupon(quote.coupon_id);
  let invoiceId: string;
  try {
    const created = await createInvoice({ institution_id: id, description: quote.description, lines: quote.lines, period_start: quote.period_start, period_end: quote.period_end }, actor.profileId);
    invoiceId = (created.invoice as { id: string }).id;
  } catch (err) {
    if (quote.coupon_id) await releaseCoupon(quote.coupon_id);
    throw err;
  }
  check(await supabaseAdmin.from("invoices").update({ renews_subscription_id: sub.id }).eq("id", invoiceId).select("id").single());
  if (quote.coupon_id) await supabaseAdmin.from("coupon_redemptions").insert({ coupon_id: quote.coupon_id, institution_id: id, invoice_id: invoiceId });
  await logEvent(id, "renewal_invoiced", `Renewal invoice issued for ${quote.period_start} to ${quote.period_end}${quote.applied.type !== "none" ? ` (${quote.applied.name})` : ""}`, actor);
  return { invoice_id: invoiceId, quote };
}

async function redeemCoupon(couponId: string) {
  const c = check(await supabaseAdmin.from("coupons").select("redeemed_count, max_redemptions").eq("id", couponId).maybeSingle()) as { redeemed_count: number; max_redemptions: number | null } | null;
  if (!c) throw new HttpError(400, "That coupon no longer exists.");
  let q = supabaseAdmin.from("coupons").update({ redeemed_count: c.redeemed_count + 1 }).eq("id", couponId).eq("redeemed_count", c.redeemed_count);
  if (c.max_redemptions !== null) q = q.lt("redeemed_count", c.max_redemptions);
  const won = check(await q.select("id")) as { id: string }[];
  if (!won.length) throw new HttpError(409, "That coupon was just used up. Try again.");
}
async function releaseCoupon(couponId: string) {
  const c = check(await supabaseAdmin.from("coupons").select("redeemed_count").eq("id", couponId).maybeSingle()) as { redeemed_count: number } | null;
  if (c && c.redeemed_count > 0) await supabaseAdmin.from("coupons").update({ redeemed_count: c.redeemed_count - 1 }).eq("id", couponId);
}

// ═════════════ plan changes & requests ═════════════
export async function changePlanChecked(id: string, planCode: string, actor: Actor) {
  const plan = check(await supabaseAdmin.from("plans").select("id, name, is_active, student_limit, staff_limit, campus_limit").eq("code", planCode).maybeSingle()) as
    | { id: string; name: string; is_active: boolean; student_limit: number | null; staff_limit: number | null; campus_limit: number | null } | null;
  if (!plan) throw new HttpError(400, `Unknown plan '${planCode}'.`);
  if (!plan.is_active) throw new HttpError(400, `The ${plan.name} plan is no longer offered.`);
  await assertFitsPlan(id, plan);
  const result = await changeSchoolPlan(id, planCode, actor.profileId);
  await logEvent(id, "plan_changed", `Plan changed to ${plan.name}`, actor);
  return result;
}

export async function createRequest(institutionId: string, requestedBy: string | undefined, toPlanCode: string, note: string | undefined) {
  const cur = check(await supabaseAdmin.from("subscriptions").select("plan_id, plans:plan_id(price_per_student_paise)").eq("institution_id", institutionId).eq("is_current", true).maybeSingle()) as unknown as
    | { plan_id: string; plans: { price_per_student_paise: number } } | null;
  if (!cur) throw new HttpError(400, "Your school has no plan yet.");
  const to = check(await supabaseAdmin.from("plans").select("id, name, price_per_student_paise, is_active").eq("code", toPlanCode).maybeSingle()) as { id: string; name: string; price_per_student_paise: number; is_active: boolean } | null;
  if (!to || !to.is_active) throw new HttpError(400, "That plan is not available.");
  if (to.id === cur.plan_id) throw new HttpError(400, "Your school is already on that plan.");
  const kind = to.price_per_student_paise > cur.plans.price_per_student_paise ? "upgrade" : "downgrade";
  const res = await supabaseAdmin.from("subscription_requests").insert({ institution_id: institutionId, from_plan_id: cur.plan_id, to_plan_id: to.id, kind, note: note ?? null, requested_by: requestedBy ?? null }).select("id, kind").single();
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, "You already have a plan change waiting for a decision.");
    throw new HttpError(500, res.error.message);
  }
  await logEvent(institutionId, "plan_requested", `Asked for a ${kind} to ${to.name}`);
  return res.data;
}

export async function schoolRequests(institutionId: string) {
  return check(
    await supabaseAdmin
      .from("subscription_requests")
      .select("id, kind, status, note, decision_note, created_at, decided_at, to_plan:to_plan_id(name), from_plan:from_plan_id(name)")
      .eq("institution_id", institutionId)
      .order("created_at", { ascending: false })
      .limit(10)
  );
}

export async function listRequests(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("subscription_requests")
    .select("id, kind, status, note, decision_note, created_at, decided_at, institution_id, institutions:institution_id(name, code), to_plan:to_plan_id(code, name), from_plan:from_plan_id(name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (query.kind === "upgrade" || query.kind === "downgrade") q = q.eq("kind", String(query.kind));
  if (["pending", "approved", "rejected"].includes(String(query.status))) q = q.eq("status", String(query.status));
  const res = await q;
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

export async function decideRequest(id: string, approve: boolean, note: string | undefined, actor: Actor) {
  const r = check(await supabaseAdmin.from("subscription_requests").select("*, to_plan:to_plan_id(code, name)").eq("id", id).maybeSingle()) as unknown as
    | { institution_id: string; status: string; to_plan: { code: string; name: string } } | null;
  if (!r) throw new HttpError(404, "Request not found.");
  if (r.status !== "pending") throw new HttpError(409, "This request has already been decided.");
  if (!approve && !note?.trim()) throw new HttpError(400, "Say why the request is declined.");
  if (approve) await changePlanChecked(r.institution_id, r.to_plan.code, actor);
  check(await supabaseAdmin.from("subscription_requests").update({ status: approve ? "approved" : "rejected", decision_note: note?.trim() || null, decided_by: actor.profileId ?? null, decided_at: new Date().toISOString() }).eq("id", id).select("id").single());
  await logEvent(r.institution_id, approve ? "plan_request_approved" : "plan_request_rejected", approve ? `Plan change to ${r.to_plan.name} approved` : `Plan change to ${r.to_plan.name} declined: ${note}`, actor);
  return { success: true };
}

// ═════════════ trials ═════════════
export async function trialOverview() {
  const [trials, expired] = await Promise.all([
    supabaseAdmin.from("platform_school_overview").select("id, code, name, plan_name, trial_ends_on, students").eq("status", "Trial").order("trial_ends_on", { ascending: true, nullsFirst: false }),
    supabaseAdmin.from("school_events").select("id, summary, created_at, institution_id, institutions:institution_id(name, code)").eq("type", "trial_expired").gte("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(50),
  ]);
  const [defaultDays, grace] = await Promise.all([getSetting<number>("general.trial_days", 14), getSetting<number>("billing.grace_days", 15)]);
  return { trials: check(trials), expired: check(expired), settings: { trial_days: defaultDays, grace_days: grace } };
}

export async function extendTrial(id: string, days: number, actor: Actor) {
  const s = check(await supabaseAdmin.from("institutions").select("status").eq("id", id).is("deleted_at", null).maybeSingle()) as { status: string } | null;
  if (!s) throw new HttpError(404, "School not found.");
  if (s.status !== "Trial") throw new HttpError(409, "Only a school on trial can have its trial extended.");
  const sub = check(await supabaseAdmin.from("subscriptions").select("id, trial_ends_on").eq("institution_id", id).eq("is_current", true).maybeSingle()) as { id: string; trial_ends_on: string | null } | null;
  if (!sub) throw new HttpError(404, "This school has no current subscription.");
  const base = sub.trial_ends_on && sub.trial_ends_on > today() ? sub.trial_ends_on : today();
  const next = addDays(base, days);
  check(await supabaseAdmin.from("subscriptions").update({ trial_ends_on: next }).eq("id", sub.id).select("id").single());
  await logEvent(id, "trial_extended", `Trial extended by ${days} day(s) to ${next}`, actor, { trial_ends_on: sub.trial_ends_on }, { trial_ends_on: next });
  return { trial_ends_on: next };
}

// ═════════════ discounts ═════════════
const codes = z.array(z.string().trim().min(1).max(30)).max(20);
const dates = { valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() };
const orderedDates = (v: { valid_from?: string | null; valid_until?: string | null }) => !v.valid_from || !v.valid_until || v.valid_until >= v.valid_from;
const DATE_MSG = { message: "The end date is before the start date." };

export const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, "Use 3-40 letters, digits, - or _."),
  description: z.string().trim().max(255).nullable().optional().transform((v) => v || null),
  kind: z.enum(["percent", "per_student"]),
  value: z.number().int().min(1),
  plan_codes: codes.default([]),
  max_redemptions: z.number().int().min(1).nullable().optional(),
  is_active: z.boolean().optional(),
  ...dates,
}).refine((v) => v.kind !== "percent" || v.value <= 100, { message: "A percentage cannot be more than 100.", path: ["value"] }).refine(orderedDates, DATE_MSG);

export const offerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  percent_off: z.number().int().min(1).max(100),
  plan_codes: codes.default([]),
  min_students: z.number().int().min(1).nullable().optional(),
  is_active: z.boolean().optional(),
  ...dates,
}).refine(orderedDates, DATE_MSG);

export const specialSchema = z.object({
  institution_id: z.string().uuid(),
  price_per_student_paise: z.number().int().min(0).max(10_000_000),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  reason: z.string().trim().min(3, "Say why this school gets a special price.").max(255),
}).refine(orderedDates, DATE_MSG);

export async function listCoupons() {
  return check(await supabaseAdmin.from("coupons").select("*").order("created_at", { ascending: false }));
}
export async function saveCoupon(id: string | null, input: Partial<z.infer<typeof couponSchema>>) {
  const q = id ? supabaseAdmin.from("coupons").update(input).eq("id", id) : supabaseAdmin.from("coupons").insert(input);
  const res = await q.select().maybeSingle();
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, "That coupon code already exists.");
    throw new HttpError(500, res.error.message);
  }
  if (!res.data) throw new HttpError(404, "Coupon not found.");
  return res.data;
}
export async function deleteCoupon(id: string) {
  const used = await supabaseAdmin.from("coupons").select("redeemed_count").eq("id", id).maybeSingle();
  if ((used.data as { redeemed_count: number } | null)?.redeemed_count) throw new HttpError(409, "This coupon has been used, so it cannot be deleted. Switch it off instead.");
  check(await supabaseAdmin.from("coupons").delete().eq("id", id).select("id"));
  return { success: true };
}
export async function checkCoupon(code: string, planCode: string) {
  const c = check(await supabaseAdmin.from("coupons").select("*").eq("code", code.trim().toUpperCase()).maybeSingle()) as CouponRow | null;
  if (!c) throw new HttpError(404, "That coupon code does not exist.");
  const problem = couponProblem(c, planCode);
  if (problem) throw new HttpError(400, problem);
  return c;
}

export async function listOffers() {
  return check(await supabaseAdmin.from("offers").select("*").order("created_at", { ascending: false }));
}
export async function saveOffer(id: string | null, input: Partial<z.infer<typeof offerSchema>>) {
  const q = id ? supabaseAdmin.from("offers").update(input).eq("id", id) : supabaseAdmin.from("offers").insert(input);
  const row = check(await q.select().maybeSingle());
  if (!row) throw new HttpError(404, "Offer not found.");
  return row;
}
export async function deleteOffer(id: string) {
  check(await supabaseAdmin.from("offers").delete().eq("id", id).select("id"));
  return { success: true };
}

export async function listSpecialPricing() {
  return check(
    await supabaseAdmin.from("school_pricing").select("*, institutions:institution_id(name, code)").order("created_at", { ascending: false }).limit(200)
  );
}
export async function addSpecialPricing(input: z.infer<typeof specialSchema>, actor: Actor) {
  const school = check(await supabaseAdmin.from("institutions").select("id").eq("id", input.institution_id).is("deleted_at", null).maybeSingle());
  if (!school) throw new HttpError(404, "School not found.");
  // a school has one negotiated price at a time
  await supabaseAdmin.from("school_pricing").update({ is_active: false }).eq("institution_id", input.institution_id).eq("is_active", true);
  const row = check(await supabaseAdmin.from("school_pricing").insert({ ...input, created_by: actor.profileId ?? null }).select().single());
  await logEvent(input.institution_id, "special_pricing", `Special price set: ${input.price_per_student_paise / 100} per student (${input.reason})`, actor);
  return row;
}
export async function endSpecialPricing(id: string, actor: Actor) {
  const row = check(await supabaseAdmin.from("school_pricing").update({ is_active: false }).eq("id", id).select("institution_id").maybeSingle()) as { institution_id: string } | null;
  if (!row) throw new HttpError(404, "Not found.");
  await logEvent(row.institution_id, "special_pricing_ended", "Special pricing ended", actor);
  return { success: true };
}

// ═════════════ billing settings ═════════════
export const BILLING_KEYS = ["general.trial_days", "billing.grace_days", "billing.default_cycle", "billing.payment_terms_days", "billing.gst_rate_percent", "general.gst_number", "billing.invoice_footer"] as const;

export async function getBillingSettings() {
  const all = await getSettings();
  return { settings: Object.fromEntries(BILLING_KEYS.map((k) => [k, all[k] ?? null])) };
}
export async function updateBillingSettings(values: Record<string, unknown>, profileId?: string) {
  const bad = Object.keys(values).filter((k) => !(BILLING_KEYS as readonly string[]).includes(k));
  if (bad.length) throw new HttpError(400, `Not a billing setting: ${bad.join(", ")}`);
  await updateSettings(values, profileId);
  return getBillingSettings();
}

// ═════════════ lifecycle ═════════════
export interface LifecycleResult { trialsExpired: number; lapsed: number; expired: number }

/**
 * Moves schools along by date: a finished trial expires, a missed renewal becomes Overdue,
 * and Overdue past the grace period becomes Expired. Safe to run as often as you like.
 */
export async function runLifecycle(): Promise<LifecycleResult> {
  const result: LifecycleResult = { trialsExpired: 0, lapsed: 0, expired: 0 };
  const grace = await getSetting<number>("billing.grace_days", 15);
  const now = today();
  const system: Actor = { name: "System" };

  const trials = check(await supabaseAdmin.from("platform_school_overview").select("id, trial_ends_on").eq("status", "Trial").lt("trial_ends_on", now)) as { id: string; trial_ends_on: string }[];
  for (const s of trials) {
    await setSchoolStatus(s.id, "Expired");
    await logEvent(s.id, "trial_expired", `Trial ended on ${s.trial_ends_on}`, system, { status: "Trial" }, { status: "Expired" });
    result.trialsExpired++;
  }

  const lapsed = check(await supabaseAdmin.from("platform_school_overview").select("id, renews_on").eq("status", "Active").lt("renews_on", now)) as { id: string; renews_on: string }[];
  for (const s of lapsed) {
    await setSchoolStatus(s.id, "Overdue");
    await logEvent(s.id, "lapsed", `Renewal date ${s.renews_on} passed without payment`, system, { status: "Active" }, { status: "Overdue" });
    result.lapsed++;
  }

  const cutoff = addDays(now, -grace);
  const dead = check(await supabaseAdmin.from("platform_school_overview").select("id, renews_on").eq("status", "Overdue").lt("renews_on", cutoff)) as { id: string; renews_on: string }[];
  for (const s of dead) {
    await setSchoolStatus(s.id, "Expired");
    await logEvent(s.id, "expired", `Still unpaid ${grace} days after ${s.renews_on}`, system, { status: "Overdue" }, { status: "Expired" });
    result.expired++;
  }
  return result;
}
