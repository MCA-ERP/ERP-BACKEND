import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getSetting } from "../admin/settings.service";

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10);

export type Cycle = "annual" | "quarterly";

export interface Applied {
  type: "special" | "offer" | "coupon" | "none";
  name: string;
  detail: string;
}

export interface Quote {
  school: string;
  plan_code: string;
  plan_name: string;
  cycle: Cycle;
  students: number;
  list_price_paise: number;      // plan price per student per year
  unit_price_paise: number;      // what is charged per student for the period, after any discount
  applied: Applied;
  description: string;
  period_start: string;
  period_end: string;
  lines: { description: string; quantity: number; unit_price_paise: number }[];
  coupon_id: string | null;
  /** Everything on the invoice, before GST: the plan line plus any add-on modules. */
  total_paise: number;
  addons: { name: string; unit_price_paise: number; bundle?: boolean }[];
  note?: string;
}

export interface CouponRow {
  id: string; code: string; kind: "percent" | "per_student"; value: number; plan_codes: string[];
  valid_from: string | null; valid_until: string | null; max_redemptions: number | null; redeemed_count: number; is_active: boolean;
}
export interface OfferRow {
  id: string; name: string; percent_off: number; plan_codes: string[]; min_students: number | null;
  valid_from: string | null; valid_until: string | null; is_active: boolean;
}

const inDates = (r: { valid_from: string | null; valid_until: string | null }, d = today()) => (!r.valid_from || r.valid_from <= d) && (!r.valid_until || r.valid_until >= d);
const rupees = (paise: number) => "₹" + (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

/** Why a coupon cannot be used right now, or null if it can. */
export function couponProblem(c: CouponRow, planCode: string): string | null {
  if (!c.is_active) return "This coupon is switched off.";
  if (!inDates(c)) return "This coupon is not valid today.";
  if (c.plan_codes.length && !c.plan_codes.includes(planCode)) return "This coupon does not apply to the school's plan.";
  if (c.max_redemptions !== null && c.redeemed_count >= c.max_redemptions) return "This coupon has been used up.";
  return null;
}

/**
 * What a school is charged for a renewal. One discount applies, whichever is lowest:
 * a negotiated price for the school (final, no further discount), otherwise the better of an automatic offer or the coupon entered.
 */
export async function quoteRenewal(institutionId: string, opts: { couponCode?: string; cycle?: Cycle } = {}): Promise<Quote> {
  const school = check(
    await supabaseAdmin.from("platform_school_overview").select("name, plan_code, plan_name, price_per_student_paise, students, renews_on").eq("id", institutionId).maybeSingle()
  ) as { name: string; plan_code: string | null; plan_name: string | null; price_per_student_paise: number | null; students: number; renews_on: string | null } | null;
  if (!school) throw new HttpError(404, "School not found.");
  if (!school.plan_code || !school.plan_name || school.price_per_student_paise === null) throw new HttpError(400, "This school has no plan yet.");

  const sub = check(await supabaseAdmin.from("subscriptions").select("billing_cycle").eq("institution_id", institutionId).eq("is_current", true).maybeSingle()) as { billing_cycle: Cycle } | null;
  const defaultCycle = await getSetting<Cycle>("billing.default_cycle", "annual");
  const cycle: Cycle = opts.cycle ?? sub?.billing_cycle ?? defaultCycle;
  const students = Math.max(1, school.students);
  const list = school.price_per_student_paise;

  let applied: Applied = { type: "none", name: "", detail: "" };
  let yearly = list;
  let couponId: string | null = null;

  const specials = check(
    await supabaseAdmin.from("school_pricing").select("price_per_student_paise, valid_from, valid_until, reason").eq("institution_id", institutionId).eq("is_active", true).order("created_at", { ascending: false })
  ) as { price_per_student_paise: number; valid_from: string; valid_until: string | null; reason: string }[];
  const special = specials.find((s) => inDates(s));

  if (special) {
    yearly = special.price_per_student_paise;
    applied = { type: "special", name: "Special pricing", detail: `${rupees(yearly)} per student (${special.reason})` };
  } else {
    const candidates: { price: number; applied: Applied; couponId: string | null }[] = [];
    const offers = check(await supabaseAdmin.from("offers").select("*").eq("is_active", true)) as OfferRow[];
    for (const o of offers) {
      if (!inDates(o) || (o.plan_codes.length && !o.plan_codes.includes(school.plan_code)) || (o.min_students && students < o.min_students)) continue;
      candidates.push({ price: Math.floor((list * (100 - o.percent_off)) / 100), applied: { type: "offer", name: o.name, detail: `${o.percent_off}% off` }, couponId: null });
    }
    if (opts.couponCode?.trim()) {
      const c = check(await supabaseAdmin.from("coupons").select("*").eq("code", opts.couponCode.trim().toUpperCase()).maybeSingle()) as CouponRow | null;
      if (!c) throw new HttpError(400, "That coupon code does not exist.");
      const problem = couponProblem(c, school.plan_code);
      if (problem) throw new HttpError(400, problem);
      const price = c.kind === "percent" ? Math.floor((list * (100 - c.value)) / 100) : Math.max(0, list - c.value);
      candidates.push({ price, applied: { type: "coupon", name: c.code, detail: c.kind === "percent" ? `${c.value}% off` : `${rupees(c.value)} off each student` }, couponId: c.id });
    }
    const best = candidates.sort((a, b) => a.price - b.price)[0];
    if (best && best.price < list) {
      yearly = best.price;
      applied = best.applied;
      couponId = best.couponId;
    }
  }

  const start = school.renews_on && school.renews_on > today() ? school.renews_on : today();
  const months = cycle === "quarterly" ? 3 : 12;
  const endDate = new Date(new Date(start + "T00:00:00Z"));
  endDate.setUTCMonth(endDate.getUTCMonth() + months);
  const end = addDays(endDate.toISOString().slice(0, 10), -1);
  const unit = cycle === "quarterly" ? Math.round(yearly / 4) : yearly;
  const label = `${school.plan_name} plan, ${start} to ${end}${applied.type !== "none" ? ` (${applied.name}: ${applied.detail})` : ""}`;

  // modules the school has beyond its plan, priced per student (bundles replace single prices when cheaper)
  const addons = await addonCharges(institutionId, school.plan_code);
  const perPeriod = (yearlyPaise: number) => (cycle === "quarterly" ? Math.round(yearlyPaise / 4) : yearlyPaise);
  const addonLines = addons.map((a) => ({ description: `Add-on: ${a.name}, ${start} to ${end}`, quantity: students, unit_price_paise: perPeriod(a.price) }));
  const lines = [{ description: label, quantity: students, unit_price_paise: unit }, ...addonLines];

  return {
    school: school.name, plan_code: school.plan_code, plan_name: school.plan_name, cycle, students,
    list_price_paise: list, unit_price_paise: unit, applied,
    description: `${school.plan_name} plan subscription (${cycle})`,
    period_start: start, period_end: end,
    lines,
    coupon_id: couponId,
    total_paise: lines.reduce((a, l) => a + l.quantity * l.unit_price_paise, 0),
    addons: addons.map((a) => ({ name: a.name, unit_price_paise: perPeriod(a.price), bundle: a.bundle })),
    note: school.students === 0 ? "This school has no enrolled students yet, so the quantity is 1. Adjust it before issuing." : undefined,
  };
}

/** Add-on modules the school has switched on that its plan does not include, with bundle pricing applied. */
async function addonCharges(institutionId: string, planCode: string): Promise<{ name: string; price: number; bundle?: boolean }[]> {
  const [over, planMods, mods, bundles] = await Promise.all([
    supabaseAdmin.from("institution_modules").select("module_code").eq("institution_id", institutionId).eq("enabled", true),
    supabaseAdmin.from("plan_modules").select("module_code, plans!inner(code)").eq("plans.code", planCode),
    supabaseAdmin.from("modules").select("code, name, is_core, is_enabled, addon_price_paise"),
    supabaseAdmin.from("module_bundles").select("name, module_codes, price_per_student_paise").eq("is_active", true),
  ]);
  const inPlan = new Set((check(planMods) as unknown as { module_code: string }[]).map((p) => p.module_code));
  const byCode = new Map((check(mods) as { code: string; name: string; is_core: boolean; is_enabled: boolean; addon_price_paise: number }[]).map((m) => [m.code, m]));
  const addonCodes = new Set(
    (check(over) as { module_code: string }[]).map((o) => o.module_code).filter((c) => {
      const m = byCode.get(c);
      return m && m.is_enabled && !m.is_core && !inPlan.has(c) && m.addon_price_paise > 0;
    })
  );

  const out: { name: string; price: number; bundle?: boolean }[] = [];
  // cheapest first: a bundle is used only if it costs less than its modules bought one by one
  const candidates = (check(bundles) as { name: string; module_codes: string[]; price_per_student_paise: number }[])
    .filter((b) => b.module_codes.every((c) => addonCodes.has(c)))
    .filter((b) => b.price_per_student_paise < b.module_codes.reduce((a, c) => a + (byCode.get(c)?.addon_price_paise ?? 0), 0))
    .sort((a, b) => a.price_per_student_paise - b.price_per_student_paise);
  for (const b of candidates) {
    if (!b.module_codes.every((c) => addonCodes.has(c))) continue;
    out.push({ name: b.name + " bundle", price: b.price_per_student_paise, bundle: true });
    b.module_codes.forEach((c) => addonCodes.delete(c));
  }
  for (const c of addonCodes) out.push({ name: byCode.get(c)!.name, price: byCode.get(c)!.addon_price_paise });
  return out;
}
