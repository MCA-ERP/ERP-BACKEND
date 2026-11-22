import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getAnalytics } from "../billing/billing.service";
import { listAlerts as securityAlerts } from "./security-mgmt.service";
import { getSetting, updateSettings } from "./settings.service";

const DAY = 86_400_000;
const IST_MS = 330 * 60_000;

// ═════════════ date ranges ═════════════
export interface Range { from: string; to: string; days: number }

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const validDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** The range from the query (inclusive days), or the last 30 days. */
export function parseRange(query: Record<string, unknown>, now = Date.now()): Range {
  const today = ymd(new Date(now + IST_MS));
  let to = validDay(query.to) ? query.to : today;
  let from = validDay(query.from) ? query.from : ymd(new Date(Date.parse(to) - 29 * DAY));
  if (from > to) [from, to] = [to, from];
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  if (days > 800) throw new HttpError(400, "Choose a range of up to about two years.");
  return { from, to, days };
}

/** The range of the same length straight before this one. */
export function previousRange(r: Range): Range {
  const to = ymd(new Date(Date.parse(r.from) - DAY));
  return { from: ymd(new Date(Date.parse(to) - (r.days - 1) * DAY)), to, days: r.days };
}

/** Start and end of an IST calendar day range as UTC instants. */
const istStart = (day: string) => new Date(Date.parse(day) - IST_MS).toISOString();
const istEnd = (day: string) => new Date(Date.parse(day) + DAY - IST_MS).toISOString();

// ═════════════ sign-in statistics ═════════════
export interface SignInEvent { created_at: string; user_agent: string | null; user_profile_id: string | null; success: boolean; reason: string }

export function summariseSignIns(events: SignInEvent[], range: Range) {
  const ok = events.filter((e) => e.success && e.reason === "ok");
  const failed = events.filter((e) => !e.success);
  const hours = new Array<number>(24).fill(0);
  for (const e of ok) hours[new Date(Date.parse(e.created_at) + IST_MS).getUTCHours()]++;
  const peak = ok.length ? hours.indexOf(Math.max(...hours)) : null;
  const mobile = ok.filter((e) => /android|iphone|ipad|mobile/i.test(e.user_agent ?? "")).length;
  const perDay = new Map<string, Set<string>>();
  for (const e of ok) {
    if (!e.user_profile_id) continue;
    const d = ymd(new Date(Date.parse(e.created_at) + IST_MS));
    (perDay.get(d) ?? perDay.set(d, new Set()).get(d)!).add(e.user_profile_id);
  }
  const dailyActive = range.days ? [...perDay.values()].reduce((a, s) => a + s.size, 0) / range.days : 0;
  return {
    signed_in: ok.length,
    failed: failed.length,
    peak_hour: peak,
    mobile_share: ok.length ? Math.round((mobile / ok.length) * 100) : null,
    daily_active_users: Math.round(dailyActive * 10) / 10,
    hours,
  };
}

async function signInEvents(r: Range): Promise<SignInEvent[]> {
  return check(
    await supabaseAdmin
      .from("login_events")
      .select("created_at, user_agent, user_profile_id, success, reason")
      .gte("created_at", istStart(r.from))
      .lt("created_at", istEnd(r.to))
      .limit(100_000)
  ) as SignInEvent[];
}

/** Who signed in yesterday, counted by kind of person. */
async function activeYesterday(now = Date.now()) {
  const today = ymd(new Date(now + IST_MS));
  const yesterday = ymd(new Date(Date.parse(today) - DAY));
  const ev = check(
    await supabaseAdmin.from("login_events").select("user_profile_id").eq("success", true).eq("reason", "ok").gte("created_at", istStart(yesterday)).lt("created_at", istEnd(yesterday)).not("user_profile_id", "is", null).limit(100_000)
  ) as { user_profile_id: string }[];
  const ids = [...new Set(ev.map((e) => e.user_profile_id))];
  const out = { Admins: 0, Teachers: 0, Parents: 0, Students: 0 };
  for (let i = 0; i < ids.length; i += 500) {
    const rows = check(await supabaseAdmin.from("user_profiles").select("id, institution_id, roles:role_id(name)").in("id", ids.slice(i, i + 500))) as unknown as { roles: { name: string } | null }[];
    for (const r of rows) {
      const n = r.roles?.name ?? "";
      if (["Faculty", "ClassTeacher", "HOD"].includes(n)) out.Teachers++;
      else if (n === "Parent") out.Parents++;
      else if (n === "Student") out.Students++;
      else out.Admins++;
    }
  }
  return { day: yesterday, total: ids.length, by_kind: out };
}

// ═════════════ KPIs ═════════════
export interface Kpi {
  key: string;
  label: string;
  description: string;
  unit: "int" | "money" | "percent" | "hours" | "number";
  current: number | null;
  previous: number | null;
  target: number | null;
  better: "higher" | "lower";
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};

/** Figures that can be worked out for any period from dated records. */
async function periodFigures(r: Range) {
  const [from, to] = [r.from, r.to];
  const [schoolsNew, payments, refunds, invoices, renewals, tickets, signIns, trialSchools] = await Promise.all([
    supabaseAdmin.from("institutions").select("*", { count: "exact", head: true }).is("deleted_at", null).gte("created_at", istStart(from)).lt("created_at", istEnd(to)),
    supabaseAdmin.from("payments").select("amount_paise").gte("paid_on", from).lte("paid_on", to).limit(50_000),
    supabaseAdmin.from("refunds").select("amount_paise").gte("created_at", istStart(from)).lt("created_at", istEnd(to)).limit(50_000),
    supabaseAdmin.from("platform_invoice_overview").select("total_paise, paid_paise, status").gte("issue_date", from).lte("issue_date", to).neq("status", "Void").limit(50_000),
    supabaseAdmin.from("invoices").select("id, total_paise, status").not("renews_subscription_id", "is", null).gte("due_on", from).lte("due_on", to).neq("status", "Void").limit(50_000),
    supabaseAdmin.from("support_tickets").select("created_at, first_response_at").gte("created_at", istStart(from)).lt("created_at", istEnd(to)).not("first_response_at", "is", null).limit(50_000),
    signInEvents(r),
    supabaseAdmin.from("platform_school_overview").select("status").gte("trial_ends_on", from).lte("trial_ends_on", to).limit(5000),
  ]);
  const collected = ((check(payments) as { amount_paise: number }[]).reduce((a, p) => a + p.amount_paise, 0)) - ((check(refunds) as { amount_paise: number }[]).reduce((a, p) => a + p.amount_paise, 0));
  const inv = check(invoices) as { total_paise: number; paid_paise: number }[];
  const ren = check(renewals) as { status: string }[];
  const trials = check(trialSchools) as { status: string }[];
  const resp = (check(tickets) as { created_at: string; first_response_at: string }[]).map((t) => (Date.parse(t.first_response_at) - Date.parse(t.created_at)) / 3_600_000).filter((h) => h >= 0);
  const si = summariseSignIns(signIns, r);
  return {
    new_schools: schoolsNew.count ?? 0,
    collected,
    collection_rate: pct(inv.reduce((a, i) => a + Math.min(i.paid_paise, i.total_paise), 0), inv.reduce((a, i) => a + i.total_paise, 0)),
    renewal_rate: pct(ren.filter((i) => i.status === "Paid").length, ren.length),
    trial_conversion: pct(trials.filter((s) => s.status === "Active").length, trials.length),
    daily_active_users: si.daily_active_users || null,
    first_response_hours: median(resp),
    sign_ins: si,
  };
}

export async function getKpis(range: Range): Promise<{ range: Range; previous: Range; kpis: Kpi[] }> {
  const prev = previousRange(range);
  const [cur, old, targets, schools] = await Promise.all([
    periodFigures(range),
    periodFigures(prev),
    getSetting<Record<string, number>>("dashboard.kpi_targets", {}),
    supabaseAdmin.from("platform_school_overview").select("status, students, arr_paise").limit(5000),
  ]);
  const all = check(schools) as { status: string; students: number; arr_paise: number }[];
  const active = all.filter((s) => s.status === "Active");
  const t = (k: string) => (typeof targets[k] === "number" ? targets[k] : null);
  const kpis: Kpi[] = [
    { key: "active_schools", label: "Active schools", description: "Schools on a paid, active plan", unit: "int", current: active.length, previous: null, target: t("active_schools"), better: "higher" },
    { key: "students", label: "Students on platform", description: "Students in all live schools", unit: "int", current: all.filter((s) => s.status === "Active" || s.status === "Trial").reduce((a, s) => a + s.students, 0), previous: null, target: t("students"), better: "higher" },
    { key: "arr", label: "Annual recurring revenue", description: "Annual value of active subscriptions, before GST", unit: "money", current: active.reduce((a, s) => a + s.arr_paise, 0), previous: null, target: t("arr"), better: "higher" },
    { key: "new_schools", label: "New schools", description: "Schools registered in the period", unit: "int", current: cur.new_schools, previous: old.new_schools, target: t("new_schools"), better: "higher" },
    { key: "collected", label: "Collected", description: "Money received in the period, after refunds", unit: "money", current: cur.collected, previous: old.collected, target: t("collected"), better: "higher" },
    { key: "collection_rate", label: "Collection rate", description: "Share of invoices issued in the period that has been paid", unit: "percent", current: cur.collection_rate, previous: old.collection_rate, target: t("collection_rate"), better: "higher" },
    { key: "renewal_rate", label: "Renewal rate", description: "Renewal invoices due in the period that were paid", unit: "percent", current: cur.renewal_rate, previous: old.renewal_rate, target: t("renewal_rate"), better: "higher" },
    { key: "trial_conversion", label: "Trial to paid conversion", description: "Trials that ended in the period and are now paying", unit: "percent", current: cur.trial_conversion, previous: old.trial_conversion, target: t("trial_conversion"), better: "higher" },
    { key: "daily_active_users", label: "Daily active users", description: "Unique people who signed in on an average day", unit: "number", current: cur.daily_active_users, previous: old.daily_active_users, target: t("daily_active_users"), better: "higher" },
    { key: "first_response_hours", label: "Median first response", description: "Support tickets, hours to the first reply", unit: "hours", current: cur.first_response_hours, previous: old.first_response_hours, target: t("first_response_hours"), better: "lower" },
  ];
  return { range, previous: prev, kpis };
}

export const KPI_KEYS = ["active_schools", "students", "arr", "new_schools", "collected", "collection_rate", "renewal_rate", "trial_conversion", "daily_active_users", "first_response_hours"] as const;

/** Sets or clears targets. A null clears one. */
export async function setKpiTargets(input: Record<string, number | null>, actorProfileId?: string) {
  const current = await getSetting<Record<string, number>>("dashboard.kpi_targets", {});
  const next = { ...current };
  for (const [k, v] of Object.entries(input)) {
    if (!(KPI_KEYS as readonly string[]).includes(k)) throw new HttpError(400, `'${k}' is not a KPI.`);
    if (v === null) delete next[k];
    else if (!Number.isFinite(v) || v < 0) throw new HttpError(400, "A target must be zero or more.");
    else next[k] = v;
  }
  await updateSettings({ "dashboard.kpi_targets": next }, actorProfileId);
  return next;
}

// ═════════════ overview ═════════════
export async function getOverview(range: Range) {
  const analytics = await getAnalytics();
  const prev = previousRange(range);
  const [cur, old, yesterday, changes] = await Promise.all([
    periodFigures(range),
    periodFigures(prev),
    activeYesterday(),
    supabaseAdmin.from("school_events").select("summary, created_at").eq("type", "plan_changed").gte("created_at", istStart(range.from)).lt("created_at", istEnd(range.to)).limit(500),
  ]);
  return {
    range,
    collected_paise: cur.collected,
    collected_previous_paise: old.collected,
    new_schools: cur.new_schools,
    sign_ins: cur.sign_ins,
    monthly: analytics.monthly,
    totals: analytics.totals,
    plan_changes: (check(changes) as { summary: string }[]).map((c) => c.summary),
    active_yesterday: yesterday,
  };
}

export async function getActivity(range: Range) {
  const [events, yesterday] = await Promise.all([signInEvents(range), activeYesterday()]);
  return { range, ...summariseSignIns(events, range), active_yesterday: yesterday };
}

// ═════════════ alerts ═════════════
export type AlertCategory = "subscription" | "payment" | "security";
export type AlertSeverity = "critical" | "warning" | "info";
export type AlertStatus = "new" | "acknowledged" | "resolved";

export interface DashboardAlert {
  id: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  detail: string;
  school: { id: string; name: string; code: string } | null;
  when: string;
  href: string;
  status: AlertStatus;
}

type Draft = Omit<DashboardAlert, "status">;

const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const dayCount = (iso: string, today: string) => Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(today)) / DAY);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

interface SchoolRow { id: string; code: string; name: string; status: string; plan_code: string | null; plan_name: string | null; price_per_student_paise: number | null; renews_on: string | null; trial_ends_on: string | null; students: number; arr_paise: number }

/** Everything about the subscriptions that needs a look, one alert per school. Pure, so it is easy to test. */
export function subscriptionAlerts(schools: SchoolRow[], limits: Map<string, number | null>, today: string): Draft[] {
  const out: Draft[] = [];
  const at = (s: SchoolRow) => ({ id: s.id, name: s.name, code: s.code });
  for (const s of schools) {
    if (s.status === "Trial" && s.trial_ends_on) {
      const d = dayCount(s.trial_ends_on, today);
      if (d >= 0 && d <= 15) out.push({ id: `trial:${s.id}:${s.trial_ends_on}`, category: "subscription", severity: d <= 3 ? "critical" : "warning", title: d === 0 ? "Trial ends today" : `Trial ends in ${plural(d, "day")}`, detail: `No payment yet. Trial ends ${s.trial_ends_on}.`, school: at(s), when: today, href: `/super-admin/subscriptions/${s.id}` });
    }
    if (s.status === "Active" && s.renews_on) {
      const d = dayCount(s.renews_on, today);
      if (d >= 0 && d <= 30) out.push({ id: `renewal:${s.id}:${s.renews_on}`, category: "subscription", severity: d <= 14 ? "warning" : "info", title: `Renewal due in ${plural(d, "day")}`, detail: `${s.plan_name ?? "Plan"}: ${inr(s.arr_paise)}, renews ${s.renews_on}.`, school: at(s), when: today, href: `/super-admin/subscriptions/${s.id}` });
    }
    if (s.status === "Expired") {
      out.push({ id: `expired:${s.id}:${s.renews_on ?? ""}`, category: "subscription", severity: "critical", title: "Subscription expired", detail: `Did not renew${s.renews_on ? ` on ${s.renews_on}` : ""}. The school portal is read-only.`, school: at(s), when: s.renews_on ?? today, href: `/super-admin/subscriptions/${s.id}` });
    }
    const limit = limits.get(s.plan_code ?? "");
    if (limit && (s.status === "Active" || s.status === "Trial")) {
      const used = Math.round((s.students / limit) * 100);
      if (used >= 80) out.push({ id: `limit:${s.id}:${used >= 100 ? 100 : used >= 95 ? 95 : 80}`, category: "subscription", severity: used >= 100 ? "critical" : used >= 95 ? "warning" : "info", title: `Student limit ${used}% used`, detail: `${s.students.toLocaleString("en-IN")} of ${limit.toLocaleString("en-IN")} students on ${s.plan_name ?? "the plan"}. Suggest moving to a bigger plan.`, school: at(s), when: today, href: `/super-admin/subscriptions/${s.id}` });
    }
    if (s.status === "Suspended") {
      out.push({ id: `suspended:${s.id}`, category: "subscription", severity: "warning", title: "School suspended", detail: "The school cannot sign in until it is reactivated.", school: at(s), when: today, href: `/super-admin/schools/${s.id}` });
    }
  }
  return out;
}

export async function listDashboardAlerts(): Promise<{ alerts: DashboardAlert[]; counts: Record<string, number> }> {
  const today = ymd(new Date(Date.now() + IST_MS));
  const week = ymd(new Date(Date.parse(today) + 7 * DAY));
  const month = new Date(Date.now() - 30 * DAY).toISOString();

  const [schoolsRes, plansRes, overdueRes, dueRes, failedRes, refundRes, webhookRes, secRes, statesRes] = await Promise.all([
    supabaseAdmin.from("platform_school_overview").select("id, code, name, status, plan_code, plan_name, price_per_student_paise, renews_on, trial_ends_on, students, arr_paise").limit(5000),
    supabaseAdmin.from("plans").select("code, student_limit"),
    supabaseAdmin.from("platform_invoice_overview").select("id, number, institution_id, school_name, school_code, due_on, balance_paise, status").eq("status", "Overdue").limit(300),
    supabaseAdmin.from("platform_invoice_overview").select("id, number, institution_id, school_name, school_code, due_on, balance_paise, status").in("status", ["Issued", "Partially paid"]).gte("due_on", today).lte("due_on", week).limit(300),
    supabaseAdmin.from("payment_orders").select("order_id, amount_paise, created_at, institutions:institution_id(id, name, code), invoices:invoice_id(number)").eq("status", "failed").gte("created_at", month).limit(200),
    supabaseAdmin.from("refund_requests").select("id, amount_paise, reason, created_at, status, decided_at, payments:payment_id(institutions:institution_id(id, name, code))").in("status", ["pending", "approved"]).gte("created_at", month).limit(200),
    supabaseAdmin.from("webhook_deliveries").select("webhook_id, status_code, error, attempted_at, webhooks:webhook_id(url)").eq("success", false).gte("attempted_at", new Date(Date.now() - DAY).toISOString()).order("attempted_at", { ascending: false }).limit(200),
    securityAlerts().catch(() => []),
    supabaseAdmin.from("dashboard_alert_states").select("alert_id, status, updated_at").gte("updated_at", month),
  ]);

  const schools = check(schoolsRes) as SchoolRow[];
  const limits = new Map((check(plansRes) as { code: string; student_limit: number | null }[]).map((p) => [p.code, p.student_limit]));
  const drafts: Draft[] = subscriptionAlerts(schools, limits, today);
  const school = (id: string, name: string, code: string) => ({ id, name, code });

  for (const i of check(overdueRes) as { id: string; number: string; institution_id: string; school_name: string; school_code: string; due_on: string; balance_paise: number }[]) {
    const late = -dayCount(i.due_on, today);
    drafts.push({ id: `overdue:${i.id}`, category: "payment", severity: late > 14 ? "critical" : "warning", title: `Invoice overdue by ${plural(late, "day")}`, detail: `${inr(i.balance_paise)} for ${i.number}.`, school: school(i.institution_id, i.school_name, i.school_code), when: i.due_on, href: "/super-admin/payments" });
  }
  for (const i of check(dueRes) as { id: string; number: string; institution_id: string; school_name: string; school_code: string; due_on: string; balance_paise: number }[]) {
    const d = dayCount(i.due_on, today);
    drafts.push({ id: `due:${i.id}`, category: "payment", severity: "info", title: d === 0 ? "Invoice due today" : `Invoice due in ${plural(d, "day")}`, detail: `${inr(i.balance_paise)} for ${i.number}.`, school: school(i.institution_id, i.school_name, i.school_code), when: today, href: "/super-admin/payments" });
  }
  for (const o of check(failedRes) as unknown as { order_id: string; amount_paise: number; created_at: string; institutions: { id: string; name: string; code: string } | null; invoices: { number: string } | null }[]) {
    drafts.push({ id: `failed:${o.order_id}`, category: "payment", severity: Date.now() - Date.parse(o.created_at) < 3 * DAY ? "critical" : "warning", title: "Payment failed", detail: `${inr(o.amount_paise)} online payment${o.invoices ? ` for ${o.invoices.number}` : ""} did not go through.`, school: o.institutions ? school(o.institutions.id, o.institutions.name, o.institutions.code) : null, when: o.created_at, href: "/super-admin/payments" });
  }
  for (const r of check(refundRes) as unknown as { id: string; amount_paise: number; reason: string; created_at: string; status: string; decided_at: string | null; payments: { institutions: { id: string; name: string; code: string } | null } | null }[]) {
    const inst = r.payments?.institutions;
    drafts.push({ id: `refund:${r.id}:${r.status}`, category: "payment", severity: r.status === "pending" ? "warning" : "info", title: r.status === "pending" ? "Refund request waiting" : "Refund processed", detail: `${inr(r.amount_paise)}: ${r.reason.slice(0, 120)}`, school: inst ? school(inst.id, inst.name, inst.code) : null, when: r.decided_at ?? r.created_at, href: "/super-admin/payments" });
  }

  // one alert per webhook that failed in the last day
  const seen = new Set<string>();
  for (const w of check(webhookRes) as unknown as { webhook_id: string; status_code: number | null; error: string | null; attempted_at: string; webhooks: { url: string } | null }[]) {
    if (seen.has(w.webhook_id)) continue;
    seen.add(w.webhook_id);
    drafts.push({ id: `webhook:${w.webhook_id}:${w.attempted_at.slice(0, 10)}`, category: "security", severity: "warning", title: "Webhook failing", detail: `${w.webhooks?.url ?? "An endpoint"} ${w.status_code ? `returned ${w.status_code}` : (w.error ?? "did not answer")}.`, school: null, when: w.attempted_at, href: "/super-admin/integrations" });
  }
  for (const a of secRes) {
    drafts.push({ id: `sec:${a.id}`, category: "security", severity: a.severity === "High" ? "critical" : a.severity === "Medium" ? "warning" : "info", title: a.title, detail: a.detail, school: null, when: a.when, href: "/super-admin/security" });
  }

  const states = new Map((check(statesRes) as { alert_id: string; status: AlertStatus }[]).map((s) => [s.alert_id, s.status]));
  const rank = { critical: 0, warning: 1, info: 2 };
  const alerts: DashboardAlert[] = drafts
    .map((d): DashboardAlert => ({ ...d, status: states.get(d.id) ?? (d.id.startsWith("refund:") && d.id.endsWith(":approved") ? "resolved" : "new") }))
    .sort((a, b) => (a.status === "resolved" ? 1 : 0) - (b.status === "resolved" ? 1 : 0) || rank[a.severity] - rank[b.severity] || b.when.localeCompare(a.when));

  const open = alerts.filter((a) => a.status !== "resolved");
  const counts: Record<string, number> = {
    open: open.length,
    new: alerts.filter((a) => a.status === "new").length,
    critical: open.filter((a) => a.severity === "critical").length,
    warning: open.filter((a) => a.severity === "warning").length,
    resolved: alerts.length - open.length,
  };
  for (const c of ["subscription", "payment", "security"]) counts[c] = open.filter((a) => a.category === c).length;
  return { alerts, counts };
}

export async function setAlertState(ids: string[], status: "acknowledged" | "resolved" | "new", actorProfileId?: string) {
  if (!ids.length) return { updated: 0 };
  if (status === "new") {
    check(await supabaseAdmin.from("dashboard_alert_states").delete().in("alert_id", ids).select("alert_id"));
    return { updated: ids.length };
  }
  const now = new Date().toISOString();
  check(await supabaseAdmin.from("dashboard_alert_states").upsert(ids.map((alert_id) => ({ alert_id, status, updated_by: actorProfileId ?? null, updated_at: now })), { onConflict: "alert_id" }).select("alert_id"));
  return { updated: ids.length };
}

/** Marks every alert nobody has looked at yet as acknowledged. */
export async function acknowledgeAllNew(category: string | undefined, actorProfileId?: string) {
  const { alerts } = await listDashboardAlerts();
  const ids = alerts.filter((a) => a.status === "new" && (!category || a.category === category)).map((a) => a.id);
  return setAlertState(ids, "acknowledged", actorProfileId);
}
