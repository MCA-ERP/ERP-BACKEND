import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { getAnalytics } from "../billing/billing.service";

const DAY = 86_400_000;
const LIMIT = 50_000;

/** The last `n` calendar months as "YYYY-MM", oldest first, ending with this one. */
export function lastMonths(n: number, now = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1)).toISOString().slice(0, 7));
}
const endOf = (m: string) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo, 1)).toISOString(); };

/** Schools on the platform at the end of each month, and where the new ones are. */
export async function schoolGrowth(now = new Date()) {
  const rows = check(await supabaseAdmin.from("platform_school_overview").select("created_at, state").limit(LIMIT)) as { created_at: string; state: string | null }[];
  const months = lastMonths(12, now);
  const series = months.map((m) => ({ month: m, schools: rows.filter((r) => r.created_at < endOf(m)).length, partial: m === months[months.length - 1] }));
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString();
  const by = new Map<string, number>();
  rows.filter((r) => r.created_at >= since).forEach((r) => by.set(r.state || "Not set", (by.get(r.state || "Not set") ?? 0) + 1));
  return { series, by_state: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([state, count]) => ({ state, count })) };
}

/** How actively each school's people sign in. Attendance and online fee collection are not measured yet. */
export async function schoolActivity(now = new Date()) {
  const week = new Date(now.getTime() - 7 * DAY).toISOString();
  const month = new Date(now.getTime() - 30 * DAY).toISOString();
  const [schools, events] = await Promise.all([
    supabaseAdmin.from("platform_school_overview").select("id, code, name, city, status, students").order("name").limit(5000),
    supabaseAdmin.from("login_events").select("institution_id, user_profile_id, created_at").eq("success", true).eq("reason", "ok").gte("created_at", month).limit(LIMIT),
  ]);
  const ev = check(events) as { institution_id: string | null; user_profile_id: string | null; created_at: string }[];
  return (check(schools) as { id: string; code: string; name: string; city: string | null; status: string; students: number }[]).map((s) => {
    const mine = ev.filter((e) => e.institution_id === s.id);
    const active = new Set(mine.filter((e) => e.created_at >= week && e.user_profile_id).map((e) => e.user_profile_id)).size;
    const last = mine.reduce((m, e) => (e.created_at > m ? e.created_at : m), "");
    return { ...s, active_users_7d: active, last_sign_in: last || null, health: active > 0 ? "Healthy" : mine.length > 0 ? "Warning" : "Inactive" };
  });
}

const GROUP: Record<string, string> = { Parent: "Parents", Student: "Students", Faculty: "Teachers", ClassTeacher: "Teachers", InstitutionAdmin: "Admins" };

/** Accounts on the platform over time, and by kind of user. */
export async function userGrowth(now = new Date()) {
  const rows = check(await supabaseAdmin.from("user_profiles").select("created_at, roles:role_id(name)").limit(LIMIT)) as unknown as { created_at: string; roles: { name: string } | null }[];
  const months = lastMonths(12, now);
  const series = months.map((m) => ({ month: m, accounts: rows.filter((r) => r.created_at < endOf(m)).length, partial: m === months[months.length - 1] }));
  const by = new Map<string, number>(["Parents", "Students", "Teachers", "Admins"].map((k) => [k, 0]));
  rows.forEach((r) => { const g = GROUP[r.roles?.name ?? ""]; if (g) by.set(g, (by.get(g) ?? 0) + 1); });
  return { series, by_role: [...by.entries()].map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count) };
}

const APP: Record<string, string> = { Parent: "Parent app", Faculty: "Teacher app", ClassTeacher: "Teacher app", Student: "Student app" };

/** Daily and monthly active people, from sign-ins. Per-feature use and time in the app are not recorded. */
export async function userEngagement(now = new Date()) {
  const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yStart = new Date(startToday.getTime() - DAY);
  const mStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const mEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [ev, sessions] = await Promise.all([
    supabaseAdmin.from("login_events").select("user_profile_id, created_at, user_profiles:user_profile_id(roles:role_id(name))").eq("success", true).eq("reason", "ok").gte("created_at", mStart.toISOString()).limit(LIMIT),
    supabaseAdmin.from("user_sessions").select("created_at, last_seen_at").gte("created_at", new Date(now.getTime() - 30 * DAY).toISOString()).limit(LIMIT),
  ]);
  const rows = (check(ev) as unknown as { user_profile_id: string | null; created_at: string; user_profiles: { roles: { name: string } | null } | null }[]).filter((r) => r.user_profile_id);
  const yesterday = rows.filter((r) => r.created_at >= yStart.toISOString() && r.created_at < startToday.toISOString());
  const dau = new Set(yesterday.map((r) => r.user_profile_id)).size;
  const mau = new Set(rows.filter((r) => r.created_at < mEnd.toISOString()).map((r) => r.user_profile_id)).size;
  const byApp = new Map<string, Set<string | null>>();
  yesterday.forEach((r) => { const k = APP[r.user_profiles?.roles?.name ?? ""] ?? "Admin web"; byApp.set(k, (byApp.get(k) ?? new Set()).add(r.user_profile_id)); });
  const spans = (check(sessions) as { created_at: string; last_seen_at: string }[]).map((s) => new Date(s.last_seen_at).getTime() - new Date(s.created_at).getTime()).filter((n) => n > 0);
  return {
    dau, mau, month: mStart.toLocaleString("en-US", { month: "long", timeZone: "UTC" }), stickiness_percent: mau ? Math.round((dau / mau) * 100) : null,
    avg_session_seconds: spans.length ? Math.round([...spans].sort((a, b) => a - b)[Math.floor(spans.length / 2)] / 1000) : null,
    by_app: ["Parent app", "Teacher app", "Student app", "Admin web"].map((app) => ({ app, users: byApp.get(app)?.size ?? 0 })),
  };
}

/** Money collected each month, and this financial year split by plan. */
export async function financialRevenue(now = new Date()) {
  const a = await getAnalytics();
  const fyStart = new Date(Date.UTC(now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1, 3, 1)).toISOString().slice(0, 10);
  const [pay, schools] = await Promise.all([
    supabaseAdmin.from("payments").select("institution_id, amount_paise").gte("paid_on", fyStart).limit(LIMIT),
    supabaseAdmin.from("platform_school_overview").select("id, plan_name").limit(5000),
  ]);
  const plan = new Map((check(schools) as { id: string; plan_name: string | null }[]).map((s) => [s.id, s.plan_name ?? "No plan"]));
  const by = new Map<string, number>();
  (check(pay) as { institution_id: string; amount_paise: number }[]).forEach((p) => by.set(plan.get(p.institution_id) ?? "No plan", (by.get(plan.get(p.institution_id) ?? "No plan") ?? 0) + Number(p.amount_paise)));
  return {
    monthly: a.monthly.slice(-12).map((m) => ({ month: m.month, collected_paise: m.collected_paise })),
    fy_label: `${fyStart.slice(0, 4)}-${String(Number(fyStart.slice(0, 4)) + 1).slice(2)}`,
    fy_total_paise: [...by.values()].reduce((x, y) => x + y, 0),
    by_plan: [...by.entries()].map(([plan_name, paise]) => ({ plan_name, paise })),
  };
}

/** How much of what was invoiced each month has been collected, and how much of it came in by the due date. */
export async function financialCollection(now = new Date()) {
  const months = lastMonths(12, now);
  const since = months[0] + "-01";
  const [inv, pay] = await Promise.all([
    supabaseAdmin.from("platform_invoice_overview").select("issue_date, total_paise, paid_paise, status").gte("issue_date", since).neq("status", "Void").limit(LIMIT),
    supabaseAdmin.from("payments").select("amount_paise, paid_on, invoices:invoice_id(due_on)").gte("paid_on", since).limit(LIMIT),
  ]);
  const invoices = check(inv) as { issue_date: string; total_paise: number; paid_paise: number }[];
  const series = months.map((m) => {
    const mine = invoices.filter((i) => i.issue_date.slice(0, 7) === m);
    const total = mine.reduce((a, i) => a + Number(i.total_paise), 0);
    const paid = mine.reduce((a, i) => a + Number(i.paid_paise), 0);
    return { month: m, rate_percent: total ? Math.round((paid / total) * 100) : 0, partial: m === months[months.length - 1] };
  });
  const all = invoices.reduce((a, i) => a + Number(i.total_paise), 0);
  const got = invoices.reduce((a, i) => a + Number(i.paid_paise), 0);
  const payments = (check(pay) as unknown as { amount_paise: number; paid_on: string; invoices: { due_on: string } | null }[]);
  const sum = payments.reduce((a, p) => a + Number(p.amount_paise), 0);
  const onTime = payments.filter((p) => p.invoices && p.paid_on <= p.invoices.due_on).reduce((a, p) => a + Number(p.amount_paise), 0);
  return {
    series,
    collection_rate_percent: all ? Math.round((got / all) * 100) : null,
    on_time_percent: sum ? Math.round((onTime / sum) * 100) : null,
    late_percent: sum ? 100 - Math.round((onTime / sum) * 100) : null,
  };
}
