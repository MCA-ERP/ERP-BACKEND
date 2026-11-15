import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { safeSearch } from "../../lib/query";

type Can = (area: string) => boolean;
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// ═════════════ search ═════════════
export interface Hit { type: "school" | "invoice" | "ticket" | "user"; id: string; title: string; subtitle: string; href: string }

/** One box for schools, invoices, tickets and people. Only searches what the person may view. */
export async function search(raw: unknown, can: Can): Promise<{ hits: Hit[] }> {
  const q = safeSearch(raw);
  if (q.length < 2) return { hits: [] };
  const like = `%${q}%`;
  const hits: Hit[] = [];

  const jobs: Promise<void>[] = [];
  if (can("schools")) jobs.push((async () => {
    const rows = check(await supabaseAdmin.from("platform_school_overview").select("id, name, code, city, status").or(`name.ilike.${like},code.ilike.${like},city.ilike.${like}`).limit(5)) as { id: string; name: string; code: string; city: string | null; status: string }[];
    rows.forEach((r) => hits.push({ type: "school", id: r.id, title: r.name, subtitle: `${r.code}${r.city ? " · " + r.city : ""} · ${r.status}`, href: `/admin/schools/${r.id}` }));
  })());
  if (can("payments")) jobs.push((async () => {
    const rows = check(await supabaseAdmin.from("platform_invoice_overview").select("id, number, school_name, status, total_paise").or(`number.ilike.${like},school_name.ilike.${like}`).limit(5)) as { id: string; number: string; school_name: string; status: string; total_paise: number }[];
    rows.forEach((r) => hits.push({ type: "invoice", id: r.id, title: r.number, subtitle: `${r.school_name} · ${r.status} · ₹${(r.total_paise / 100).toLocaleString("en-IN")}`, href: "/admin/payments" }));
  })());
  if (can("support")) jobs.push((async () => {
    const rows = check(await supabaseAdmin.from("support_tickets").select("id, code, subject, status, institutions:institution_id(name)").or(`code.ilike.${like},subject.ilike.${like}`).limit(5)) as unknown as { id: string; code: string; subject: string; status: string; institutions: { name: string } | null }[];
    rows.forEach((r) => hits.push({ type: "ticket", id: r.id, title: r.subject, subtitle: `${r.code} · ${r.institutions?.name ?? "No school"} · ${r.status}`, href: "/admin/support" }));
  })());
  if (can("users")) jobs.push((async () => {
    const rows = check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, email, institutions:institution_id(name)").or(`email.ilike.${like},first_name.ilike.${like},last_name.ilike.${like}`).limit(5)) as unknown as { id: string; first_name: string; last_name: string; email: string; institutions: { name: string } | null }[];
    rows.forEach((r) => hits.push({ type: "user", id: r.id, title: `${r.first_name} ${r.last_name}`.trim(), subtitle: `${r.email} · ${r.institutions?.name ?? "Platform team"}`, href: "/admin/users" }));
  })());
  await Promise.all(jobs);
  return { hits };
}

// ═════════════ notifications (the bell) ═════════════
export interface Alert { key: string; severity: "critical" | "warning" | "info"; title: string; detail: string; count: number; href: string }

/** What needs attention now, built from live data. Nothing is stored: when the cause is fixed the alert goes away. */
export async function notifications(can: Can): Promise<{ alerts: Alert[]; total: number }> {
  const head = (table: string) => supabaseAdmin.from(table).select("*", { count: "exact", head: true });
  const jobs: Promise<Alert | null>[] = [];
  const add = (fn: () => Promise<Alert | null>) => jobs.push(fn().catch(() => null));

  if (can("schools")) {
    add(async () => {
      const n = (await head("institutions").eq("status", "Pending").is("deleted_at", null)).count ?? 0;
      return n ? { key: "pending_schools", severity: "warning", title: "Schools waiting for approval", detail: `${n} school${n === 1 ? "" : "s"} registered and not yet approved.`, count: n, href: "/admin/schools/approval" } : null;
    });
    add(async () => {
      const n = (await head("school_applications").in("status", ["new", "in_review"])).count ?? 0;
      return n ? { key: "applications", severity: "info", title: "New school applications", detail: `${n} application${n === 1 ? "" : "s"} to review.`, count: n, href: "/admin/schools/applications" } : null;
    });
  }
  if (can("support")) {
    add(async () => {
      const rows = check(await supabaseAdmin.from("support_tickets").select("priority, status, created_at, first_response_at").in("status", ["Open", "In progress"]).limit(5000)) as { priority: string; status: string; created_at: string; first_response_at: string | null }[];
      const pol = new Map((check(await supabaseAdmin.from("sla_policies").select("*")) as { priority: string; first_response_hours: number; resolution_hours: number }[]).map((p) => [p.priority, p]));
      const now = Date.now();
      const late = rows.filter((t) => {
        const p = pol.get(t.priority);
        if (!p) return false;
        const created = new Date(t.created_at).getTime();
        return (!t.first_response_at && now > created + p.first_response_hours * 3_600_000) || now > created + p.resolution_hours * 3_600_000;
      }).length;
      return late ? { key: "tickets_overdue", severity: "critical", title: "Support tickets past their target", detail: `${late} ticket${late === 1 ? " is" : "s are"} overdue for a reply or a fix.`, count: late, href: "/admin/support" } : null;
    });
    add(async () => {
      const n = (await head("support_tickets").is("assigned_to", null).eq("status", "Open")).count ?? 0;
      return n ? { key: "tickets_unassigned", severity: "warning", title: "Unassigned tickets", detail: `${n} open ticket${n === 1 ? "" : "s"} nobody owns yet.`, count: n, href: "/admin/support" } : null;
    });
  }
  if (can("payments")) {
    add(async () => {
      const rows = check(await supabaseAdmin.from("platform_invoice_overview").select("balance_paise").eq("status", "Overdue")) as { balance_paise: number }[];
      const total = rows.reduce((a, r) => a + r.balance_paise, 0);
      return rows.length ? { key: "invoices_overdue", severity: "critical", title: "Overdue invoices", detail: `${rows.length} invoice${rows.length === 1 ? "" : "s"}, ₹${Math.round(total / 100).toLocaleString("en-IN")} outstanding.`, count: rows.length, href: "/admin/payments" } : null;
    });
    add(async () => {
      const n = (await head("refund_requests").eq("status", "pending")).count ?? 0;
      return n ? { key: "refund_requests", severity: "warning", title: "Refund requests waiting", detail: `${n} request${n === 1 ? "" : "s"} need a decision.`, count: n, href: "/admin/payments" } : null;
    });
    add(async () => {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const n = (await head("payment_orders").eq("status", "failed").gte("created_at", since)).count ?? 0;
      return n ? { key: "payments_failed", severity: "warning", title: "Failed online payments", detail: `${n} attempt${n === 1 ? "" : "s"} failed in the last 7 days.`, count: n, href: "/admin/payments" } : null;
    });
  }
  if (can("subscriptions")) {
    add(async () => {
      const n = (await head("platform_school_overview").eq("status", "Active").gte("renews_on", day()).lte("renews_on", day(7))).count ?? 0;
      return n ? { key: "renewals_soon", severity: "info", title: "Renewals this week", detail: `${n} school${n === 1 ? "" : "s"} renew in the next 7 days.`, count: n, href: "/admin/subscriptions?tab=renewals" } : null;
    });
    add(async () => {
      const n = (await head("platform_school_overview").eq("status", "Trial").gte("trial_ends_on", day()).lte("trial_ends_on", day(3))).count ?? 0;
      return n ? { key: "trials_ending", severity: "warning", title: "Trials ending soon", detail: `${n} trial${n === 1 ? "" : "s"} end within 3 days.`, count: n, href: "/admin/subscriptions?tab=trials" } : null;
    });
  }
  if (can("users")) {
    add(async () => {
      const n = (await head("user_profiles").gt("locked_until", new Date().toISOString())).count ?? 0;
      return n ? { key: "locked_accounts", severity: "warning", title: "Locked accounts", detail: `${n} account${n === 1 ? " is" : "s are"} locked after wrong passwords.`, count: n, href: "/admin/users" } : null;
    });
  }

  const order = { critical: 0, warning: 1, info: 2 } as const;
  const alerts = (await Promise.all(jobs)).filter((a): a is Alert => !!a).sort((a, b) => order[a.severity] - order[b.severity]);
  return { alerts, total: alerts.length };
}
