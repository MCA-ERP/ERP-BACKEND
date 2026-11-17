import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { getAnalytics } from "../billing/billing.service";

const DAY = 86_400_000;
const LIMIT = 50_000;

// ── outstanding ──────────────────────────────────────────────
export async function financialOutstanding() {
  const a = await getAnalytics();
  return { open_invoices: a.outstanding.length, outstanding_paise: a.totals.outstanding_paise, overdue_paise: a.totals.overdue_paise, ageing: a.ageing };
}

// ── subscriptions ────────────────────────────────────────────
export async function subscriptionDistribution() {
  const rows = check(await supabaseAdmin.from("platform_school_overview").select("plan_name, status, students").limit(5000)) as { plan_name: string | null; status: string; students: number }[];
  const live = rows.filter((r) => ["Active", "Trial", "Overdue"].includes(r.status));
  const plans = [...new Set(live.map((r) => r.plan_name ?? "No plan"))];
  return {
    active: live.length,
    by_plan: plans.map((p) => {
      const mine = live.filter((r) => (r.plan_name ?? "No plan") === p);
      return { plan: p, schools: mine.length, students: mine.reduce((a, r) => a + r.students, 0) };
    }),
  };
}

type Ev = { institution_id: string; type: string; summary: string; created_at: string; institutions: { name: string } | null };
async function events(types: string[], since: string): Promise<Ev[]> {
  return check(
    await supabaseAdmin.from("school_events").select("institution_id, type, summary, created_at, institutions:institution_id(name)").in("type", types).gte("created_at", since).order("created_at", { ascending: false }).limit(2000)
  ) as unknown as Ev[];
}

export async function subscriptionRenewals(now = new Date()) {
  const ev = await events(["renewed", "lapsed", "expired", "plan_changed", "plan_request_approved"], new Date(now.getTime() - 365 * DAY).toISOString());
  const renewed = ev.filter((e) => e.type === "renewed").length;
  const lost = ev.filter((e) => e.type === "lapsed" || e.type === "expired").length;
  const label = (t: string) => (t === "renewed" ? "Renewed" : t === "lapsed" ? "Lapsed" : t === "expired" ? "Expired" : "Plan changed");
  return {
    renewal_rate_percent: renewed + lost ? Math.round((renewed / (renewed + lost)) * 100) : null,
    upgraded: ev.filter((e) => e.type === "plan_changed" || e.type === "plan_request_approved").length,
    items: ev.map((e) => ({ school_id: e.institution_id, school: e.institutions?.name ?? "—", at: e.created_at, result: label(e.type), summary: e.summary })),
  };
}

export async function subscriptionChurn(now = new Date()) {
  const since = new Date(now.getTime() - 365 * DAY).toISOString();
  const [subs, overview] = await Promise.all([
    supabaseAdmin.from("subscriptions").select("institution_id, cancelled_at, cancel_reason, plans:plan_id(name)").eq("is_current", true).not("cancelled_at", "is", null).gte("cancelled_at", since).limit(2000),
    supabaseAdmin.from("platform_school_overview").select("id, name, arr_paise, status").limit(5000),
  ]);
  const all = check(overview) as { id: string; name: string; arr_paise: number }[];
  const gone = (check(subs) as unknown as { institution_id: string; cancelled_at: string; cancel_reason: string | null; plans: { name: string } | null }[]).map((s) => {
    const o = all.find((x) => x.id === s.institution_id);
    return { school_id: s.institution_id, school: o?.name ?? "—", plan: s.plans?.name ?? "—", left: s.cancelled_at, reason: (s.cancel_reason ?? "").replace(/^Cancelled: ?/, "") || "—", arr_paise: o?.arr_paise ?? 0 };
  });
  const arrAll = all.reduce((a, s) => a + s.arr_paise, 0) || 1;
  const counts = new Map<string, number>();
  gone.forEach((g) => { if (g.reason !== "—") counts.set(g.reason, (counts.get(g.reason) ?? 0) + 1); });
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    churn_rate_percent: Math.round((gone.length / (all.length || 1)) * 100),
    revenue_churn_percent: Math.round((gone.reduce((a, g) => a + g.arr_paise, 0) / arrAll) * 100),
    top_reason: top?.[0] ?? null, top_count: top?.[1] ?? 0, items: gone,
  };
}

// ── modules ──────────────────────────────────────────────────
export async function moduleUsage() {
  const [mods, live, pm, plans, ov] = await Promise.all([
    supabaseAdmin.from("modules").select("code, name, category, sort_order, is_core").order("sort_order"),
    supabaseAdmin.from("platform_school_overview").select("id, plan_code").in("status", ["Active", "Trial", "Overdue"]).limit(5000),
    supabaseAdmin.from("plan_modules").select("plan_id, module_code"),
    supabaseAdmin.from("plans").select("id, code"),
    supabaseAdmin.from("institution_modules").select("institution_id, module_code, enabled"),
  ]);
  const schools = check(live) as { id: string; plan_code: string | null }[];
  const pcode = new Map((check(plans) as { id: string; code: string }[]).map((p) => [p.id, p.code]));
  const inPlan = new Set((check(pm) as { plan_id: string; module_code: string }[]).map((x) => `${pcode.get(x.plan_id)}|${x.module_code}`));
  const over = new Map((check(ov) as { institution_id: string; module_code: string; enabled: boolean }[]).map((o) => [`${o.institution_id}|${o.module_code}`, o.enabled]));
  const n = schools.length || 1;
  return (check(mods) as { code: string; name: string; category: string; is_core: boolean }[]).map((m) => {
    const using = schools.filter((s) => { const o = over.get(`${s.id}|${m.code}`); return o !== undefined ? o : m.is_core || inPlan.has(`${s.plan_code}|${m.code}`); }).length;
    return { code: m.code, name: m.name, category: m.category, percent: Math.round((using / n) * 100), schools: using };
  });
}

// ── security ─────────────────────────────────────────────────
export async function securityLogin(now = new Date()) {
  const month = new Date(now.getTime() - 30 * DAY).toISOString();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6));
  const [ev, ips] = await Promise.all([
    supabaseAdmin.from("login_events").select("success, reason, created_at").gte("created_at", month).limit(LIMIT),
    supabaseAdmin.from("ip_blocklist").select("*", { count: "exact", head: true }),
  ]);
  const rows = check(ev) as { success: boolean; reason: string; created_at: string }[];
  const ok = rows.filter((r) => r.success && r.reason === "ok").length;
  const bad = rows.filter((r) => !r.success);
  const days = Array.from({ length: 7 }, (_, i) => {
    const k = new Date(start.getTime() + i * DAY).toISOString().slice(0, 10);
    return { date: k, failed: bad.filter((r) => r.created_at.slice(0, 10) === k).length, partial: i === 6 };
  });
  return {
    sign_ins_30d: ok, success_percent: rows.length ? Math.round((ok / rows.length) * 1000) / 10 : null, failed_30d: bad.length,
    failed_percent: rows.length ? Math.round((bad.length / rows.length) * 10000) / 100 : null, blocked_ips: ips.count ?? 0, failed_by_day: days,
  };
}

export async function securityAccess(now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const rows = check(
    await supabaseAdmin.from("access_denied_events").select("at, email, method, path, needed, user_profiles:profile_id(first_name, last_name, roles:role_id(display_name))").gte("at", since).order("at", { ascending: false }).limit(500)
  ) as unknown as { at: string; email: string | null; method: string; path: string; needed: string | null; user_profiles: { first_name: string; last_name: string; roles: { display_name: string } | null } | null }[];
  return rows.map((r) => ({ at: r.at, user: r.user_profiles ? `${r.user_profiles.first_name} ${r.user_profiles.last_name}` : r.email ?? "Unknown", role: r.user_profiles?.roles?.display_name ?? "—", opened: `${r.method} ${r.path}`, needed: r.needed }));
}

export async function securityAudit(now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const rows = check(await supabaseAdmin.from("audit_logs").select("actor_email").gte("created_at", since).limit(LIMIT)) as { actor_email: string | null }[];
  const by = new Map<string, number>();
  rows.forEach((r) => by.set(r.actor_email ?? "System", (by.get(r.actor_email ?? "System") ?? 0) + 1));
  return { by_user: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([user, count]) => ({ user, count })) };
}
