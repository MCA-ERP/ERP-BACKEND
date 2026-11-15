import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { percentile } from "../../lib/telemetry";
import { listModules } from "../admin/modules.service";
import { loadSchoolAccess } from "../../lib/entitlements";

/**
 * The reports in the Super Admin design: school, user, financial, subscription, module, security and system.
 * Each returns rows, summary tiles and (where it helps) a chart; the CSV export uses the rows.
 */

type Kind = "text" | "int" | "money" | "date";
interface Column { key: string; label: string; kind: Kind }
type Cell = string | number | null;
export interface Chart { kind: "bar" | "line" | "stacked"; unit: "int" | "money" | "percent" | "ms"; labels: string[]; series: { label: string; values: number[] }[] }
interface Range { from: string; to: string }
export interface PlatformReport {
  key: string; name: string; description: string; area: string; usesRange: boolean; group: string;
  run: (range: Range) => Promise<{ columns: Column[]; rows: Record<string, Cell>[]; summary: { label: string; value: string | number; kind?: Kind }[]; chart?: Chart }>;
}

const LIMIT = 10_000;
const col = (key: string, label: string, kind: Kind = "text"): Column => ({ key, label, kind });
const startOf = (d: string) => `${d}T00:00:00.000Z`;
const endOf = (d: string) => `${d}T23:59:59.999Z`;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const LIVE = ["Trial", "Active", "Overdue"];

function monthsIn({ from, to }: Range): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out.slice(-36);
}
function daysIn({ from, to }: Range): string[] {
  const out: string[] = [];
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= new Date(`${to}T00:00:00Z`).getTime() && out.length < 400; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

const GROUP_OF_ROLE = (name: string) =>
  name === "Student" ? "Students" : name === "Parent" ? "Parents" : ["SuperAdmin", "PlatformManager", "Finance", "SupportAgent", "ContentEditor"].includes(name) ? "Platform team" : "School staff";

export const PLATFORM_REPORTS: PlatformReport[] = [
  // ═════════════ School reports ═════════════
  {
    key: "school-growth", group: "schools", name: "School growth", area: "School reports", usesRange: true,
    description: "Schools joining the platform, month by month.",
    async run(range) {
      const rows0 = check(await supabaseAdmin.from("institutions").select("created_at, status").is("deleted_at", null).limit(LIMIT)) as { created_at: string; status: string }[];
      const months = monthsIn(range);
      const rows = months.map((m) => {
        const inMonth = rows0.filter((r) => r.created_at.startsWith(m));
        return {
          month: m, new_schools: inMonth.length,
          total_schools: rows0.filter((r) => r.created_at.slice(0, 7) <= m).length,
          still_live: inMonth.filter((r) => LIVE.includes(r.status)).length,
        };
      });
      return {
        columns: [col("month", "Month"), col("new_schools", "New schools", "int"), col("total_schools", "Total schools", "int"), col("still_live", "Of the new ones, live now", "int")],
        rows,
        summary: [
          { label: "New in period", value: rows.reduce((a, r) => a + r.new_schools, 0), kind: "int" },
          { label: "Total schools", value: rows0.length, kind: "int" },
          { label: "Live now", value: rows0.filter((r) => LIVE.includes(r.status)).length, kind: "int" },
        ],
        chart: { kind: "bar", unit: "int", labels: months.map(monthLabel), series: [{ label: "New schools", values: rows.map((r) => r.new_schools) }] },
      };
    },
  },
  {
    key: "school-activity", group: "schools", name: "School activity", area: "School reports", usesRange: true,
    description: "How actively each school uses the platform: sign-ins, people who signed in, tickets and students. Sign-ins are counted from when sign-in recording began.",
    async run({ from, to }) {
      const [schools, ev, tickets] = await Promise.all([
        supabaseAdmin.from("platform_school_overview").select("id, code, name, status, students").order("name").limit(LIMIT),
        supabaseAdmin.from("login_events").select("institution_id, user_profile_id, created_at").eq("success", true).eq("reason", "ok").gte("created_at", startOf(from)).lte("created_at", endOf(to)).not("institution_id", "is", null).limit(50_000),
        supabaseAdmin.from("support_tickets").select("institution_id").gte("created_at", startOf(from)).lte("created_at", endOf(to)).limit(LIMIT),
      ]);
      const e = check(ev) as { institution_id: string; user_profile_id: string | null; created_at: string }[];
      const t = check(tickets) as { institution_id: string | null }[];
      const rows = (check(schools) as { id: string; code: string; name: string; status: string; students: number }[]).map((s) => {
        const mine = e.filter((x) => x.institution_id === s.id);
        return {
          code: s.code, school: s.name, status: s.status, students: s.students, sign_ins: mine.length,
          active_people: new Set(mine.map((x) => x.user_profile_id)).size, tickets: t.filter((x) => x.institution_id === s.id).length,
          last_sign_in: mine.length ? mine.map((x) => x.created_at).sort().pop()!.slice(0, 10) : null,
        };
      }).sort((a, b) => b.sign_ins - a.sign_ins);
      const top = rows.slice(0, 10);
      return {
        columns: [col("code", "Code"), col("school", "School"), col("status", "Status"), col("students", "Students", "int"), col("sign_ins", "Sign-ins", "int"), col("active_people", "People who signed in", "int"), col("tickets", "Tickets", "int"), col("last_sign_in", "Last sign-in", "date")],
        rows,
        summary: [
          { label: "Schools with sign-ins", value: rows.filter((r) => r.sign_ins > 0).length, kind: "int" },
          { label: "Schools with none", value: rows.filter((r) => r.sign_ins === 0 && LIVE.includes(r.status)).length, kind: "int" },
          { label: "Total sign-ins", value: rows.reduce((a, r) => a + r.sign_ins, 0), kind: "int" },
        ],
        chart: { kind: "bar", unit: "int", labels: top.map((r) => r.school), series: [{ label: "Sign-ins", values: top.map((r) => r.sign_ins) }] },
      };
    },
  },

  // ═════════════ User reports ═════════════
  {
    key: "user-growth", group: "users", name: "User growth", area: "User reports", usesRange: true,
    description: "New accounts each month: platform team, school staff, students and parents.",
    async run(range) {
      const u = check(await supabaseAdmin.from("user_profiles").select("created_at, roles:role_id(name)").limit(50_000)) as unknown as { created_at: string; roles: { name: string } | null }[];
      const groups = ["Platform team", "School staff", "Students", "Parents"];
      const months = monthsIn(range);
      const rows = months.map((m) => {
        const row: Record<string, Cell> = { month: m };
        for (const g of groups) row[g] = u.filter((x) => x.created_at.startsWith(m) && GROUP_OF_ROLE(x.roles?.name ?? "") === g).length;
        row.new_total = groups.reduce((a, g) => a + (row[g] as number), 0);
        row.total_accounts = u.filter((x) => x.created_at.slice(0, 7) <= m).length;
        return row;
      });
      return {
        columns: [col("month", "Month"), ...groups.map((g) => col(g, g, "int")), col("new_total", "New accounts", "int"), col("total_accounts", "Total accounts", "int")],
        rows,
        summary: [{ label: "New in period", value: rows.reduce((a, r) => a + (r.new_total as number), 0), kind: "int" }, { label: "Total accounts", value: u.length, kind: "int" }],
        chart: { kind: "stacked", unit: "int", labels: months.map(monthLabel), series: groups.map((g) => ({ label: g, values: rows.map((r) => r[g] as number) })) },
      };
    },
  },
  {
    key: "user-engagement", group: "users", name: "User engagement", area: "User reports", usesRange: true,
    description: "How often people sign in: sign-ins and distinct people per day. Counted from when sign-in recording began.",
    async run(range) {
      const ev = check(await supabaseAdmin.from("login_events").select("user_profile_id, created_at, roles:user_profile_id(roles:role_id(name))").eq("success", true).eq("reason", "ok").gte("created_at", startOf(range.from)).lte("created_at", endOf(range.to)).limit(50_000)) as unknown as { user_profile_id: string | null; created_at: string; roles: { roles: { name: string } | null } | null }[];
      const days = daysIn(range);
      const rows = days.map((d) => {
        const mine = ev.filter((e) => e.created_at.startsWith(d));
        return { date: d, sign_ins: mine.length, active_people: new Set(mine.map((e) => e.user_profile_id)).size };
      });
      const people = new Set(ev.map((e) => e.user_profile_id)).size;
      const withData = rows.filter((r) => r.sign_ins > 0);
      const byGroup = new Map<string, number>();
      ev.forEach((e) => { const g = GROUP_OF_ROLE(e.roles?.roles?.name ?? ""); byGroup.set(g, (byGroup.get(g) ?? 0) + 1); });
      return {
        columns: [col("date", "Date", "date"), col("sign_ins", "Sign-ins", "int"), col("active_people", "People", "int")],
        rows,
        summary: [
          { label: "Sign-ins", value: ev.length, kind: "int" },
          { label: "Different people", value: people, kind: "int" },
          { label: "Average people per active day", value: withData.length ? Math.round(withData.reduce((a, r) => a + r.active_people, 0) / withData.length) : 0, kind: "int" },
          { label: "Most active group", value: [...byGroup.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—" },
        ],
        chart: { kind: "line", unit: "int", labels: days.map(dayLabel), series: [{ label: "People", values: rows.map((r) => r.active_people) }, { label: "Sign-ins", values: rows.map((r) => r.sign_ins) }] },
      };
    },
  },

  // ═════════════ Financial reports ═════════════
  {
    key: "revenue-trend", group: "financial", name: "Revenue", area: "Financial reports", usesRange: true,
    description: "Money collected by month and by plan (the school's current plan), refunds netted off.",
    async run(range) {
      const [pay, ref, subs] = await Promise.all([
        supabaseAdmin.from("payments").select("amount_paise, paid_on, institution_id").gte("paid_on", range.from).lte("paid_on", range.to).limit(50_000),
        supabaseAdmin.from("refunds").select("amount_paise, created_at, payments:payment_id(institution_id)").gte("created_at", startOf(range.from)).lte("created_at", endOf(range.to)).limit(LIMIT),
        supabaseAdmin.from("subscriptions").select("institution_id, plans:plan_id(name)").eq("is_current", true).limit(LIMIT),
      ]);
      const planOf = new Map((check(subs) as unknown as { institution_id: string; plans: { name: string } | null }[]).map((s) => [s.institution_id, s.plans?.name ?? "No plan"]));
      const p = check(pay) as { amount_paise: number; paid_on: string; institution_id: string }[];
      const r = check(ref) as unknown as { amount_paise: number; created_at: string; payments: { institution_id: string } | null }[];
      const plans = [...new Set([...planOf.values()])].sort();
      const months = monthsIn(range);
      const rows = months.map((m) => {
        const row: Record<string, Cell> = { month: m };
        for (const pl of plans) {
          const got = p.filter((x) => x.paid_on.startsWith(m) && planOf.get(x.institution_id) === pl).reduce((a, x) => a + x.amount_paise, 0);
          const back = r.filter((x) => x.created_at.startsWith(m) && x.payments && planOf.get(x.payments.institution_id) === pl).reduce((a, x) => a + x.amount_paise, 0);
          row[pl] = got - back;
        }
        row.net = plans.reduce((a, pl) => a + (row[pl] as number), 0);
        return row;
      });
      return {
        columns: [col("month", "Month"), ...plans.map((pl) => col(pl, pl, "money")), col("net", "Net collected", "money")],
        rows,
        summary: [
          { label: "Collected", value: p.reduce((a, x) => a + x.amount_paise, 0), kind: "money" },
          { label: "Refunded", value: r.reduce((a, x) => a + x.amount_paise, 0), kind: "money" },
          { label: "Net", value: rows.reduce((a, x) => a + (x.net as number), 0), kind: "money" },
        ],
        chart: { kind: "stacked", unit: "money", labels: months.map(monthLabel), series: plans.map((pl) => ({ label: pl, values: rows.map((x) => Math.max(0, x[pl] as number)) })) },
      };
    },
  },
  {
    key: "collection", group: "financial", name: "Collection", area: "Financial reports", usesRange: true,
    description: "How much of what was invoiced each month has been collected.",
    async run(range) {
      const inv = check(await supabaseAdmin.from("platform_invoice_overview").select("issue_date, total_paise, paid_paise, status").neq("status", "Void").gte("issue_date", range.from).lte("issue_date", range.to).limit(LIMIT)) as { issue_date: string; total_paise: number; paid_paise: number; status: string }[];
      const months = monthsIn(range);
      const rows = months.map((m) => {
        const mine = inv.filter((i) => i.issue_date.startsWith(m));
        const invoiced = mine.reduce((a, i) => a + i.total_paise, 0);
        const collected = mine.reduce((a, i) => a + i.paid_paise, 0);
        return { month: m, invoices: mine.length, invoiced_paise: invoiced, collected_paise: collected, uncollected_paise: invoiced - collected, collection_percent: pct(collected, invoiced) };
      });
      const tot = rows.reduce((a, r) => ({ i: a.i + r.invoiced_paise, c: a.c + r.collected_paise }), { i: 0, c: 0 });
      return {
        columns: [col("month", "Month (invoices issued)"), col("invoices", "Invoices", "int"), col("invoiced_paise", "Invoiced", "money"), col("collected_paise", "Collected", "money"), col("uncollected_paise", "Not collected", "money"), col("collection_percent", "Collected %", "int")],
        rows,
        summary: [{ label: "Invoiced", value: tot.i, kind: "money" }, { label: "Collected", value: tot.c, kind: "money" }, { label: "Collection rate", value: `${pct(tot.c, tot.i)}%` }],
        chart: { kind: "bar", unit: "percent", labels: months.map(monthLabel), series: [{ label: "Collected %", values: rows.map((r) => r.collection_percent) }] },
      };
    },
  },
  {
    key: "outstanding", group: "financial", name: "Outstanding", area: "Financial reports", usesRange: false,
    description: "Money billed but not yet received, oldest first. A snapshot of today.",
    async run() {
      const inv = check(await supabaseAdmin.from("platform_invoice_overview").select("number, school_name, description, issue_date, due_on, total_paise, paid_paise, balance_paise, status").in("status", ["Issued", "Partially paid", "Overdue"]).order("due_on").limit(LIMIT)) as { number: string; school_name: string; description: string; issue_date: string; due_on: string; total_paise: number; paid_paise: number; balance_paise: number; status: string }[];
      const today = Date.now();
      const rows = inv.map((i) => ({ invoice: i.number, school: i.school_name, description: i.description, due_on: i.due_on, days_late: Math.max(0, Math.floor((today - new Date(`${i.due_on}T00:00:00Z`).getTime()) / 86_400_000)), total_paise: i.total_paise, paid_paise: i.paid_paise, balance_paise: i.balance_paise, status: i.status }));
      const buckets = [["Not yet due", (d: number) => d === 0], ["1–30 days late", (d: number) => d >= 1 && d <= 30], ["31–60 days late", (d: number) => d >= 31 && d <= 60], ["Over 60 days late", (d: number) => d > 60]] as const;
      return {
        columns: [col("invoice", "Invoice"), col("school", "School"), col("description", "For"), col("due_on", "Due", "date"), col("days_late", "Days late", "int"), col("total_paise", "Total", "money"), col("paid_paise", "Paid", "money"), col("balance_paise", "Balance", "money"), col("status", "Status")],
        rows,
        summary: [
          { label: "Invoices open", value: rows.length, kind: "int" },
          { label: "Outstanding", value: rows.reduce((a, r) => a + r.balance_paise, 0), kind: "money" },
          { label: "Overdue", value: rows.filter((r) => r.status === "Overdue").reduce((a, r) => a + r.balance_paise, 0), kind: "money" },
        ],
        chart: { kind: "bar", unit: "money", labels: buckets.map((b) => b[0]), series: [{ label: "Balance", values: buckets.map(([, f]) => rows.filter((r) => f(r.days_late)).reduce((a, r) => a + r.balance_paise, 0)) }] },
      };
    },
  },

  // ═════════════ Subscription reports ═════════════
  {
    key: "plan-distribution", group: "subscriptions", name: "Plan distribution", area: "Subscription reports", usesRange: false,
    description: "How schools spread across plans, with students and yearly value. A snapshot of today.",
    async run() {
      const s = check(await supabaseAdmin.from("platform_school_overview").select("plan_name, status, students, arr_paise").limit(LIMIT)) as { plan_name: string | null; status: string; students: number; arr_paise: number }[];
      const names = [...new Set(s.map((x) => x.plan_name ?? "No plan"))];
      const liveTotal = s.filter((x) => LIVE.includes(x.status)).length;
      const arrTotal = s.filter((x) => x.status === "Active").reduce((a, x) => a + x.arr_paise, 0);
      const rows = names.map((n) => {
        const mine = s.filter((x) => (x.plan_name ?? "No plan") === n);
        const live = mine.filter((x) => LIVE.includes(x.status));
        const arr = mine.filter((x) => x.status === "Active").reduce((a, x) => a + x.arr_paise, 0);
        return { plan: n, schools: mine.length, live_schools: live.length, share_of_live: pct(live.length, liveTotal), students: live.reduce((a, x) => a + x.students, 0), arr_paise: arr, share_of_value: pct(arr, arrTotal) };
      }).sort((a, b) => b.live_schools - a.live_schools);
      return {
        columns: [col("plan", "Plan"), col("schools", "Schools", "int"), col("live_schools", "Live schools", "int"), col("share_of_live", "% of live schools", "int"), col("students", "Students", "int"), col("arr_paise", "Yearly value", "money"), col("share_of_value", "% of value", "int")],
        rows,
        summary: [{ label: "Live schools", value: liveTotal, kind: "int" }, { label: "Yearly value", value: arrTotal, kind: "money" }, { label: "Plans in use", value: names.length, kind: "int" }],
        chart: { kind: "bar", unit: "int", labels: rows.map((r) => r.plan), series: [{ label: "Live schools", values: rows.map((r) => r.live_schools) }] },
      };
    },
  },
  {
    key: "renewals", group: "subscriptions", name: "Renewals", area: "Subscription reports", usesRange: true,
    description: "Renewal results by month: renewed, lapsed and expired.",
    async run(range) {
      const ev = check(await supabaseAdmin.from("school_events").select("type, created_at").in("type", ["renewed", "lapsed", "expired"]).gte("created_at", startOf(range.from)).lte("created_at", endOf(range.to)).limit(LIMIT)) as { type: string; created_at: string }[];
      const upcoming = ((await supabaseAdmin.from("platform_school_overview").select("*", { count: "exact", head: true }).in("status", ["Active", "Overdue"]).gte("renews_on", new Date().toISOString().slice(0, 10)).lte("renews_on", new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10))).count) ?? 0;
      const months = monthsIn(range);
      const rows = months.map((m) => {
        const c = (t: string) => ev.filter((e) => e.type === t && e.created_at.startsWith(m)).length;
        const renewed = c("renewed"), lapsed = c("lapsed"), expired = c("expired");
        return { month: m, renewed, lapsed, expired, renewal_rate: pct(renewed, renewed + lapsed + expired) };
      });
      const t = rows.reduce((a, r) => ({ r: a.r + r.renewed, l: a.l + r.lapsed, e: a.e + r.expired }), { r: 0, l: 0, e: 0 });
      return {
        columns: [col("month", "Month"), col("renewed", "Renewed", "int"), col("lapsed", "Lapsed", "int"), col("expired", "Expired", "int"), col("renewal_rate", "Renewal rate %", "int")],
        rows,
        summary: [{ label: "Renewed", value: t.r, kind: "int" }, { label: "Lapsed or expired", value: t.l + t.e, kind: "int" }, { label: "Renewal rate", value: `${pct(t.r, t.r + t.l + t.e)}%` }, { label: "Due in the next 90 days", value: upcoming, kind: "int" }],
        chart: { kind: "stacked", unit: "int", labels: months.map(monthLabel), series: [{ label: "Renewed", values: rows.map((r) => r.renewed) }, { label: "Lapsed", values: rows.map((r) => r.lapsed) }, { label: "Expired", values: rows.map((r) => r.expired) }] },
      };
    },
  },
  {
    key: "churn", group: "subscriptions", name: "Churn", area: "Subscription reports", usesRange: true,
    description: "Schools that left, and why: cancelled subscriptions and ones that expired without renewing.",
    async run(range) {
      const [cancelled, ev] = await Promise.all([
        supabaseAdmin.from("subscriptions").select("institution_id, cancelled_at, cancel_reason, started_on, plans:plan_id(name), institutions:institution_id(name, code)").eq("is_current", true).not("cancelled_at", "is", null).gte("cancelled_at", startOf(range.from)).lte("cancelled_at", endOf(range.to)).limit(LIMIT),
        supabaseAdmin.from("school_events").select("institution_id, type, summary, created_at, institutions:institution_id(name, code)").in("type", ["expired", "trial_expired"]).gte("created_at", startOf(range.from)).lte("created_at", endOf(range.to)).limit(LIMIT),
      ]);
      const left = new Map<string, { school: string; code: string; plan: string | null; left_on: string; reason: string; started: string | null }>();
      for (const e of check(ev) as unknown as { institution_id: string; type: string; summary: string; created_at: string; institutions: { name: string; code: string } | null }[]) {
        left.set(e.institution_id, { school: e.institutions?.name ?? "", code: e.institutions?.code ?? "", plan: null, left_on: e.created_at.slice(0, 10), reason: e.type === "trial_expired" ? "Trial ended without paying" : "Did not renew", started: null });
      }
      for (const c of check(cancelled) as unknown as { institution_id: string; cancelled_at: string; cancel_reason: string | null; started_on: string; plans: { name: string } | null; institutions: { name: string; code: string } | null }[]) {
        left.set(c.institution_id, { school: c.institutions?.name ?? "", code: c.institutions?.code ?? "", plan: c.plans?.name ?? null, left_on: c.cancelled_at.slice(0, 10), reason: c.cancel_reason ?? "Cancelled", started: c.started_on });
      }
      const rows = [...left.values()].sort((a, b) => b.left_on.localeCompare(a.left_on)).map((l) => ({
        school: l.school, code: l.code, plan: l.plan, left_on: l.left_on, reason: l.reason,
        months_with_us: l.started ? Math.max(0, Math.round((new Date(l.left_on).getTime() - new Date(l.started).getTime()) / (30.4 * 86_400_000))) : null,
      }));
      const live = ((await supabaseAdmin.from("platform_school_overview").select("*", { count: "exact", head: true }).in("status", LIVE)).count) ?? 0;
      const reasons = new Map<string, number>();
      rows.forEach((r) => reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1));
      return {
        columns: [col("school", "School"), col("code", "Code"), col("plan", "Plan"), col("left_on", "Left on", "date"), col("reason", "Why"), col("months_with_us", "Months with us", "int")],
        rows,
        summary: [{ label: "Schools that left", value: rows.length, kind: "int" }, { label: "Live schools now", value: live, kind: "int" }, { label: "Churn (of live + left)", value: `${pct(rows.length, live + rows.length)}%` }],
        chart: { kind: "bar", unit: "int", labels: [...reasons.keys()], series: [{ label: "Schools", values: [...reasons.values()] }] },
      };
    },
  },

  // ═════════════ Module reports ═════════════
  {
    key: "module-usage", group: "modules", name: "Module usage", area: "Module reports", usesRange: false,
    description: "Share of live schools that have each module, and whether the module is built. A snapshot of today.",
    async run() {
      const c = await listModules();
      const rows = c.modules.map((m) => ({ module: m.name, category: m.category ?? "", built: m.build_status === "live" ? "Built" : m.build_status === "beta" ? "Beta" : "Not built yet", schools_with_access: m.schools_with_access ?? 0, percent_of_live: pct(m.schools_with_access ?? 0, c.liveSchools), included_from: m.min_plan ?? "—", version: m.version ?? null })).sort((a, b) => b.schools_with_access - a.schools_with_access);
      return {
        columns: [col("module", "Module"), col("category", "Category"), col("built", "Build"), col("schools_with_access", "Schools with it", "int"), col("percent_of_live", "% of live schools", "int"), col("included_from", "Included from"), col("version", "Version")],
        rows,
        summary: [{ label: "Live schools", value: c.liveSchools, kind: "int" }, { label: "Modules built", value: c.modules.filter((m) => m.build_status === "live").length, kind: "int" }, { label: "Modules in catalogue", value: c.modules.length, kind: "int" }],
        chart: { kind: "bar", unit: "percent", labels: rows.slice(0, 12).map((r) => r.module), series: [{ label: "% of live schools", values: rows.slice(0, 12).map((r) => r.percent_of_live) }] },
      };
    },
  },
  {
    key: "module-adoption", group: "modules", name: "Module adoption", area: "Module reports", usesRange: false,
    description: "How many modules schools have by how long they have been with you. A snapshot of today.",
    async run() {
      const schools = check(await supabaseAdmin.from("platform_school_overview").select("id, name, created_at").in("status", LIVE).limit(300)) as { id: string; name: string; created_at: string }[];
      const per: { name: string; age: number; modules: number }[] = [];
      for (const s of schools) {
        const a = await loadSchoolAccess(s.id);
        per.push({ name: s.name, age: Math.floor((Date.now() - new Date(s.created_at).getTime()) / 86_400_000), modules: a.modules.filter((m) => m.effective && !m.is_core).length });
      }
      const buckets = [["Up to 30 days", 0, 30], ["31–90 days", 31, 90], ["91–180 days", 91, 180], ["Over 180 days", 181, 99999]] as const;
      const rows = buckets.map(([label, lo, hi]) => {
        const mine = per.filter((p) => p.age >= lo && p.age <= hi);
        return { with_us: label, schools: mine.length, avg_modules: mine.length ? Math.round((mine.reduce((a, p) => a + p.modules, 0) / mine.length) * 10) / 10 : 0, most_modules: mine.length ? Math.max(...mine.map((p) => p.modules)) : 0, fewest_modules: mine.length ? Math.min(...mine.map((p) => p.modules)) : 0 };
      });
      return {
        columns: [col("with_us", "Time with us"), col("schools", "Live schools", "int"), col("avg_modules", "Average modules", "int"), col("most_modules", "Most", "int"), col("fewest_modules", "Fewest", "int")],
        rows,
        summary: [{ label: "Live schools", value: per.length, kind: "int" }, { label: "Average modules per school", value: per.length ? Math.round((per.reduce((a, p) => a + p.modules, 0) / per.length) * 10) / 10 : 0 }],
        chart: { kind: "bar", unit: "int", labels: rows.map((r) => r.with_us), series: [{ label: "Average modules", values: rows.map((r) => r.avg_modules) }] },
      };
    },
  },
  {
    key: "module-errors", group: "modules", name: "Module errors", area: "Module reports", usesRange: true,
    description: "Server errors by area of the product. Counted from when error recording began.",
    async run(range) {
      const [m, e] = await Promise.all([
        supabaseAdmin.from("request_metrics").select("route_group, module_code, requests, errors").gte("hour", startOf(range.from)).lte("hour", endOf(range.to)).limit(LIMIT),
        supabaseAdmin.from("error_events").select("route_group, at, message").gte("at", startOf(range.from)).lte("at", endOf(range.to)).order("at", { ascending: false }).limit(LIMIT),
      ]);
      const groups = new Map<string, { requests: number; errors: number }>();
      for (const r of check(m) as { route_group: string; requests: number; errors: number }[]) {
        const g = groups.get(r.route_group) ?? { requests: 0, errors: 0 };
        groups.set(r.route_group, { requests: g.requests + r.requests, errors: g.errors + r.errors });
      }
      const last = new Map<string, { at: string; message: string | null }>();
      for (const r of check(e) as { route_group: string; at: string; message: string | null }[]) if (!last.has(r.route_group)) last.set(r.route_group, r);
      const rows = [...groups.entries()].map(([area, g]) => ({ area, requests: g.requests, errors: g.errors, error_rate: pct(g.errors, g.requests), last_error: last.get(area)?.at.slice(0, 10) ?? null, last_message: last.get(area)?.message ?? null })).sort((a, b) => b.errors - a.errors || b.requests - a.requests);
      return {
        columns: [col("area", "Area"), col("requests", "Requests", "int"), col("errors", "Errors", "int"), col("error_rate", "Error rate %", "int"), col("last_error", "Last error", "date"), col("last_message", "Last message")],
        rows,
        summary: [{ label: "Requests", value: rows.reduce((a, r) => a + r.requests, 0), kind: "int" }, { label: "Errors", value: rows.reduce((a, r) => a + r.errors, 0), kind: "int" }, { label: "Areas with errors", value: rows.filter((r) => r.errors > 0).length, kind: "int" }],
        chart: { kind: "bar", unit: "int", labels: rows.filter((r) => r.errors > 0).slice(0, 10).map((r) => r.area), series: [{ label: "Errors", values: rows.filter((r) => r.errors > 0).slice(0, 10).map((r) => r.errors) }] },
      };
    },
  },

  // ═════════════ Security reports ═════════════
  {
    key: "login-report", group: "security", name: "Login", area: "Security reports", usesRange: true,
    description: "Successful and failed sign-ins by day, including accounts that were locked and wrong codes.",
    async run(range) {
      const ev = check(await supabaseAdmin.from("login_events").select("success, reason, created_at").in("reason", ["ok", "bad_password", "locked", "unknown_email", "suspended", "school_inactive", "code_failed"]).gte("created_at", startOf(range.from)).lte("created_at", endOf(range.to)).limit(50_000)) as { success: boolean; reason: string; created_at: string }[];
      const days = daysIn(range);
      const rows = days.map((d) => {
        const m = ev.filter((e) => e.created_at.startsWith(d));
        const c = (rs: string[]) => m.filter((e) => rs.includes(e.reason)).length;
        return { date: d, signed_in: c(["ok"]), wrong_password: c(["bad_password", "unknown_email"]), wrong_code: c(["code_failed"]), locked: c(["locked"]), blocked: c(["suspended", "school_inactive"]) };
      });
      const t = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + (r[k] as number), 0);
      return {
        columns: [col("date", "Date", "date"), col("signed_in", "Signed in", "int"), col("wrong_password", "Wrong password", "int"), col("wrong_code", "Wrong code", "int"), col("locked", "Locked out", "int"), col("blocked", "Turned away", "int")],
        rows,
        summary: [{ label: "Signed in", value: t("signed_in"), kind: "int" }, { label: "Failed", value: t("wrong_password") + t("wrong_code") + t("blocked"), kind: "int" }, { label: "Locked out", value: t("locked"), kind: "int" }, { label: "Failure rate", value: `${pct(t("wrong_password") + t("wrong_code") + t("blocked") + t("locked"), ev.length)}%` }],
        chart: { kind: "stacked", unit: "int", labels: days.map(dayLabel), series: [{ label: "Signed in", values: rows.map((r) => r.signed_in) }, { label: "Wrong password or code", values: rows.map((r) => r.wrong_password + r.wrong_code) }, { label: "Locked or turned away", values: rows.map((r) => r.locked + r.blocked) }] },
      };
    },
  },
  {
    key: "access-report", group: "security", name: "Access", area: "Security reports", usesRange: true,
    description: "Attempts to open pages or data without permission (requests refused with 403). Counted from when recording began.",
    async run(range) {
      const ev = check(await supabaseAdmin.from("access_denied_events").select("email, method, path, needed, at").gte("at", startOf(range.from)).lte("at", endOf(range.to)).order("at", { ascending: false }).limit(LIMIT)) as { email: string | null; method: string; path: string; needed: string | null; at: string }[];
      const key = (e: { email: string | null; method: string; path: string }) => `${e.email ?? "not signed in"}|${e.method}|${e.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id")}`;
      const g = new Map<string, { email: string; method: string; path: string; needed: string | null; attempts: number; last: string }>();
      for (const e of ev) {
        const k = key(e);
        const cur = g.get(k);
        if (cur) cur.attempts++;
        else g.set(k, { email: e.email ?? "not signed in", method: e.method, path: k.split("|")[2], needed: e.needed, attempts: 1, last: e.at });
      }
      const rows = [...g.values()].sort((a, b) => b.attempts - a.attempts).map((r) => ({ person: r.email, request: `${r.method} ${r.path}`, permission_needed: r.needed, attempts: r.attempts, last_attempt: r.last.slice(0, 10) }));
      const byPerson = new Map<string, number>();
      ev.forEach((e) => byPerson.set(e.email ?? "not signed in", (byPerson.get(e.email ?? "not signed in") ?? 0) + 1));
      const top = [...byPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      return {
        columns: [col("person", "Who"), col("request", "Tried to open"), col("permission_needed", "Permission needed"), col("attempts", "Attempts", "int"), col("last_attempt", "Last attempt", "date")],
        rows,
        summary: [{ label: "Refused requests", value: ev.length, kind: "int" }, { label: "Different people", value: byPerson.size, kind: "int" }, { label: "Different pages", value: rows.length, kind: "int" }],
        chart: { kind: "bar", unit: "int", labels: top.map((t) => t[0]), series: [{ label: "Refused", values: top.map((t) => t[1]) }] },
      };
    },
  },
  {
    key: "audit-summary", group: "security", name: "Audit", area: "Security reports", usesRange: true,
    description: "Who changed what, summarised: changes by person and kind (create, update, delete).",
    async run(range) {
      const logs = check(await supabaseAdmin.from("audit_logs").select("actor_email, action, created_at").gte("created_at", startOf(range.from)).lte("created_at", endOf(range.to)).limit(50_000)) as { actor_email: string | null; action: string; created_at: string }[];
      const kind = (a: string) => (a.startsWith("POST") ? "create" : a.startsWith("DELETE") ? "delete" : "update");
      const people = new Map<string, { create: number; update: number; delete: number; last: string }>();
      for (const l of logs) {
        const p = people.get(l.actor_email ?? "unknown") ?? { create: 0, update: 0, delete: 0, last: "" };
        p[kind(l.action)]++;
        if (l.created_at > p.last) p.last = l.created_at;
        people.set(l.actor_email ?? "unknown", p);
      }
      const rows = [...people.entries()].map(([who, p]) => ({ person: who, changes: p.create + p.update + p.delete, created: p.create, updated: p.update, deleted: p.delete, last_change: p.last.slice(0, 10) })).sort((a, b) => b.changes - a.changes);
      return {
        columns: [col("person", "Who"), col("changes", "Changes", "int"), col("created", "Created", "int"), col("updated", "Updated", "int"), col("deleted", "Deleted", "int"), col("last_change", "Last change", "date")],
        rows,
        summary: [{ label: "Changes", value: logs.length, kind: "int" }, { label: "People", value: rows.length, kind: "int" }, { label: "Deletions", value: logs.filter((l) => kind(l.action) === "delete").length, kind: "int" }],
        chart: { kind: "bar", unit: "int", labels: rows.slice(0, 10).map((r) => r.person), series: [{ label: "Changes", values: rows.slice(0, 10).map((r) => r.changes) }] },
      };
    },
  },

  // ═════════════ System reports ═════════════
  {
    key: "performance", group: "system", name: "Performance", area: "System reports", usesRange: true,
    description: "How fast the platform answers and how often it fails, by day. Counted from when recording began.",
    async run(range) {
      const m = check(await supabaseAdmin.from("request_metrics").select("hour, requests, errors, sum_ms, max_ms, buckets").gte("hour", startOf(range.from)).lte("hour", endOf(range.to)).limit(50_000)) as { hour: string; requests: number; errors: number; sum_ms: number; max_ms: number; buckets: number[] }[];
      const days = daysIn(range);
      const rows = days.map((d) => {
        const mine = m.filter((x) => x.hour.startsWith(d));
        const b = [0, 0, 0, 0, 0, 0, 0].map((_, i) => mine.reduce((a, x) => a + (x.buckets[i] ?? 0), 0));
        const requests = mine.reduce((a, x) => a + x.requests, 0);
        const errors = mine.reduce((a, x) => a + x.errors, 0);
        return { date: d, requests, errors, error_rate: pct(errors, requests), average_ms: requests ? Math.round(mine.reduce((a, x) => a + x.sum_ms, 0) / requests) : 0, p50_ms: percentile(b, 0.5), p95_ms: percentile(b, 0.95), slowest_ms: mine.reduce((a, x) => Math.max(a, x.max_ms), 0) };
      });
      const reqs = rows.reduce((a, r) => a + r.requests, 0);
      const errs = rows.reduce((a, r) => a + r.errors, 0);
      const withData = rows.filter((r) => r.requests > 0);
      return {
        columns: [col("date", "Date", "date"), col("requests", "Requests", "int"), col("errors", "Server errors", "int"), col("error_rate", "Error rate %", "int"), col("average_ms", "Average (ms)", "int"), col("p50_ms", "Typical, p50 (ms)", "int"), col("p95_ms", "Slow, p95 (ms)", "int"), col("slowest_ms", "Slowest (ms)", "int")],
        rows,
        summary: [
          { label: "Requests", value: reqs, kind: "int" },
          { label: "Success rate", value: reqs ? `${(100 - pct(errs, reqs)).toFixed(1)}%` : "—" },
          { label: "Average answer time", value: withData.length ? `${Math.round(withData.reduce((a, r) => a + r.average_ms * r.requests, 0) / Math.max(1, reqs))} ms` : "—" },
          { label: "Running since last restart", value: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m` },
        ],
        chart: { kind: "line", unit: "ms", labels: days.map(dayLabel), series: [{ label: "p95 (ms)", values: rows.map((r) => r.p95_ms) }, { label: "Average (ms)", values: rows.map((r) => r.average_ms) }] },
      };
    },
  },
  {
    key: "storage", group: "system", name: "Storage", area: "System reports", usesRange: false,
    description: "How much of the database each school uses, as record counts, plus the size of the whole database. Files are not stored yet.",
    async run() {
      const [schools, stats, ...counts] = await Promise.all([
        supabaseAdmin.from("platform_school_overview").select("id, code, name, status").order("name").limit(LIMIT),
        supabaseAdmin.rpc("platform_db_stats"),
        ...(["students", "guardians", "user_profiles", "support_tickets", "invoices"] as const).map((t) => supabaseAdmin.from(t).select("institution_id").limit(50_000)),
      ]);
      const tally = (r: unknown) => { const m = new Map<string, number>(); for (const x of check(r as never) as { institution_id: string | null }[]) if (x.institution_id) m.set(x.institution_id, (m.get(x.institution_id) ?? 0) + 1); return m; };
      const [st, gu, us, tk, iv] = counts.map(tally);
      const rows = (check(schools) as { id: string; code: string; name: string; status: string }[]).map((s) => {
        const r = { code: s.code, school: s.name, status: s.status, students: st.get(s.id) ?? 0, guardians: gu.get(s.id) ?? 0, accounts: us.get(s.id) ?? 0, tickets: tk.get(s.id) ?? 0, invoices: iv.get(s.id) ?? 0, total_records: 0 };
        r.total_records = r.students + r.guardians + r.accounts + r.tickets + r.invoices;
        return r;
      }).sort((a, b) => b.total_records - a.total_records);
      const db = (stats.data ?? { database_bytes: 0, tables: [] }) as { database_bytes: number; tables: { name: string; bytes: number; rows: number }[] };
      const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;
      return {
        columns: [col("code", "Code"), col("school", "School"), col("status", "Status"), col("students", "Students", "int"), col("guardians", "Guardians", "int"), col("accounts", "Accounts", "int"), col("tickets", "Tickets", "int"), col("invoices", "Invoices", "int"), col("total_records", "Total records", "int")],
        rows,
        summary: [{ label: "Database size", value: mb(db.database_bytes) }, { label: "Largest table", value: db.tables[0] ? `${db.tables[0].name} (${mb(db.tables[0].bytes)})` : "—" }, { label: "Schools", value: rows.length, kind: "int" }, { label: "Records across schools", value: rows.reduce((a, r) => a + r.total_records, 0), kind: "int" }],
        chart: { kind: "bar", unit: "int", labels: db.tables.slice(0, 10).map((t) => t.name), series: [{ label: "Size (KB)", values: db.tables.slice(0, 10).map((t) => Math.round(t.bytes / 1024)) }] },
      };
    },
  },
  {
    key: "system-errors", group: "system", name: "Errors", area: "System reports", usesRange: true,
    description: "Server errors, newest first. Counted from when error recording began.",
    async run(range) {
      const e = check(await supabaseAdmin.from("error_events").select("at, route_group, method, path, status, message").gte("at", startOf(range.from)).lte("at", endOf(range.to)).order("at", { ascending: false }).limit(LIMIT)) as { at: string; route_group: string; method: string; path: string; status: number; message: string | null }[];
      const days = daysIn(range);
      const rows = e.map((x) => ({ when: x.at.replace("T", " ").slice(0, 16), area: x.route_group, request: `${x.method} ${x.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id")}`, status: x.status, message: x.message }));
      return {
        columns: [col("when", "When"), col("area", "Area"), col("request", "Request"), col("status", "Status", "int"), col("message", "Message")],
        rows,
        summary: [{ label: "Errors", value: rows.length, kind: "int" }, { label: "Areas affected", value: new Set(rows.map((r) => r.area)).size, kind: "int" }],
        chart: { kind: "bar", unit: "int", labels: days.map(dayLabel), series: [{ label: "Errors", values: days.map((d) => e.filter((x) => x.at.startsWith(d)).length) }] },
      };
    },
  },
];
