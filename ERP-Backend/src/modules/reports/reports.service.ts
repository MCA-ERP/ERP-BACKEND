import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { toCsv } from "../../lib/csv";
import { HttpError } from "../../lib/http-error";
import { listModules } from "../admin/modules.service";
import { PLATFORM_REPORTS, type Chart } from "./reports.platform";

export type Kind = "text" | "int" | "money" | "date";
export interface Column {
  key: string;
  label: string;
  kind: Kind;
}
type Cell = string | number | null;
export interface ReportResult {
  columns: Column[];
  rows: Record<string, Cell>[];
  summary: { label: string; value: string | number; kind?: Kind }[];
  truncated: boolean;
  chart?: Chart;
}

interface ReportDef {
  key: string;
  name: string;
  description: string;
  area: string;
  usesRange: boolean;
  run: (range: Range) => Promise<Omit<ReportResult, "truncated">>;
}
interface Range {
  from: string;
  to: string;
}

const ROW_LIMIT = 10_000;
const col = (key: string, label: string, kind: Kind = "text"): Column => ({ key, label, kind });
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
/** End of a day, so a "to" date includes everything that happened on it. */
const endOf = (d: string) => `${d}T23:59:59.999Z`;
const startOf = (d: string) => `${d}T00:00:00.000Z`;
const hours = (a: string, b: string) => Math.round(((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000) * 10) / 10;
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

export function parseRange(query: Record<string, unknown>): Range {
  const from = isDate(query.from) ? query.from : daysAgo(30);
  const to = isDate(query.to) ? query.to : today();
  if (from > to) throw new HttpError(400, "The start date must not be after the end date.");
  if ((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 > 800) throw new HttpError(400, "Choose a range of at most about two years.");
  return { from, to };
}

// ─────────────────────────────────────────────
//  Report definitions
// ─────────────────────────────────────────────
const REPORTS: ReportDef[] = [
  {
    key: "schools",
    name: "School report",
    description: "Every school with its plan, students, status and annual value. A snapshot of today.",
    area: "Operations",
    usesRange: false,
    async run() {
      const [overview, gst] = await Promise.all([
        supabaseAdmin.from("platform_school_overview").select("*").order("name").limit(ROW_LIMIT),
        supabaseAdmin.from("institutions").select("id, gst_number").limit(ROW_LIMIT),
      ]);
      const gstById = new Map((check(gst) as { id: string; gst_number: string | null }[]).map((g) => [g.id, g.gst_number]));
      const rows = (check(overview) as any[]).map((s) => ({
        code: s.code, name: s.name, board: s.board, city: s.city, state: s.state, status: s.status,
        plan: s.plan_name, students: s.students, arr_paise: s.arr_paise, renews_on: s.renews_on,
        gstin: gstById.get(s.id) ?? null, registered: String(s.created_at).slice(0, 10),
      }));
      return {
        columns: [col("code", "Code"), col("name", "School"), col("board", "Board"), col("city", "City"), col("state", "State"), col("status", "Status"),
          col("plan", "Plan"), col("students", "Students", "int"), col("arr_paise", "Annual value", "money"), col("renews_on", "Renews on", "date"),
          col("gstin", "GSTIN"), col("registered", "Registered", "date")],
        rows,
        summary: [
          { label: "Schools", value: rows.length, kind: "int" },
          { label: "Students", value: rows.reduce((a, r) => a + r.students, 0), kind: "int" },
          { label: "Annual value (active)", value: rows.filter((r) => r.status === "Active").reduce((a, r) => a + r.arr_paise, 0), kind: "money" },
        ],
      };
    },
  },
  {
    key: "revenue",
    name: "Revenue report",
    description: "Payments received in the period, with refunds netted off.",
    area: "Finance",
    usesRange: true,
    async run({ from, to }) {
      const [pay, ref] = await Promise.all([
        supabaseAdmin
          .from("payments")
          .select("code, amount_paise, method, gateway, reference, paid_on, invoices:invoice_id(number), institutions:institution_id(name, code), refunds(amount_paise)")
          .gte("paid_on", from).lte("paid_on", to).order("paid_on").limit(ROW_LIMIT),
        supabaseAdmin.from("refunds").select("amount_paise").gte("created_at", startOf(from)).lte("created_at", endOf(to)).limit(ROW_LIMIT),
      ]);
      const rows = (check(pay) as any[]).map((p) => ({
        paid_on: p.paid_on, payment: p.code, invoice: p.invoices?.number ?? null, school: p.institutions?.name ?? null,
        method: p.method, via: p.gateway === "razorpay" ? "Online" : "Recorded", reference: p.reference,
        amount_paise: p.amount_paise, refunded_paise: (p.refunds ?? []).reduce((a: number, r: { amount_paise: number }) => a + r.amount_paise, 0),
      }));
      const collected = rows.reduce((a, r) => a + r.amount_paise, 0);
      const refunded = (check(ref) as { amount_paise: number }[]).reduce((a, r) => a + r.amount_paise, 0);
      return {
        columns: [col("paid_on", "Paid on", "date"), col("payment", "Payment"), col("invoice", "Invoice"), col("school", "School"), col("method", "Method"),
          col("via", "Via"), col("reference", "Reference"), col("amount_paise", "Amount", "money"), col("refunded_paise", "Refunded", "money")],
        rows,
        summary: [
          { label: "Payments", value: rows.length, kind: "int" },
          { label: "Collected", value: collected, kind: "money" },
          { label: "Refunded in period", value: refunded, kind: "money" },
          { label: "Net", value: collected - refunded, kind: "money" },
        ],
      };
    },
  },
  {
    key: "subscriptions",
    name: "Subscription report",
    description: "Subscriptions that started, ended or are due to renew in the period.",
    area: "Finance",
    usesRange: true,
    async run({ from, to }) {
      const res = await supabaseAdmin
        .from("subscriptions")
        .select("started_on, renews_on, ended_on, is_current, plans:plan_id(name), institutions:institution_id(name, code, status)")
        .or(`and(started_on.gte.${from},started_on.lte.${to}),and(renews_on.gte.${from},renews_on.lte.${to}),and(ended_on.gte.${from},ended_on.lte.${to})`)
        .limit(ROW_LIMIT);
      const rows: Record<string, Cell>[] = [];
      for (const s of check(res) as any[]) {
        const base = { school: s.institutions?.name ?? null, code: s.institutions?.code ?? null, plan: s.plans?.name ?? null, school_status: s.institutions?.status ?? null };
        if (s.started_on >= from && s.started_on <= to) rows.push({ date: s.started_on, event: "Started", ...base });
        if (s.ended_on && s.ended_on >= from && s.ended_on <= to) rows.push({ date: s.ended_on, event: "Ended (plan changed)", ...base });
        if (s.is_current && s.renews_on && s.renews_on >= from && s.renews_on <= to) rows.push({ date: s.renews_on, event: "Renews", ...base });
      }
      rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return {
        columns: [col("date", "Date", "date"), col("event", "Event"), col("school", "School"), col("code", "Code"), col("plan", "Plan"), col("school_status", "School status")],
        rows,
        summary: [
          { label: "Started", value: rows.filter((r) => r.event === "Started").length, kind: "int" },
          { label: "Plan changes", value: rows.filter((r) => String(r.event).startsWith("Ended")).length, kind: "int" },
          { label: "Renewals due", value: rows.filter((r) => r.event === "Renews").length, kind: "int" },
        ],
      };
    },
  },
  {
    key: "gst",
    name: "GST report (GSTR-1 data)",
    description: "Invoice-wise taxable value and GST for the period. Add each school's GSTIN under Schools → Edit.",
    area: "Finance",
    usesRange: true,
    async run({ from, to }) {
      const res = await supabaseAdmin
        .from("invoices")
        .select("number, issue_date, subtotal_paise, gst_rate_percent, tax_paise, total_paise, institutions:institution_id(name, state, gst_number)")
        .neq("status", "Void").gte("issue_date", from).lte("issue_date", to).order("number").limit(ROW_LIMIT);
      const rows = (check(res) as any[]).map((i) => ({
        invoice: i.number, date: i.issue_date, school: i.institutions?.name ?? null, gstin: i.institutions?.gst_number ?? null,
        place_of_supply: i.institutions?.state ?? null, taxable_paise: i.subtotal_paise, rate: Number(i.gst_rate_percent),
        gst_paise: i.tax_paise, total_paise: i.total_paise,
      }));
      return {
        columns: [col("invoice", "Invoice"), col("date", "Date", "date"), col("school", "School"), col("gstin", "GSTIN"), col("place_of_supply", "Place of supply"),
          col("taxable_paise", "Taxable value", "money"), col("rate", "GST rate %", "int"), col("gst_paise", "GST", "money"), col("total_paise", "Invoice total", "money")],
        rows,
        summary: [
          { label: "Invoices", value: rows.length, kind: "int" },
          { label: "Taxable value", value: rows.reduce((a, r) => a + r.taxable_paise, 0), kind: "money" },
          { label: "GST", value: rows.reduce((a, r) => a + r.gst_paise, 0), kind: "money" },
          { label: "Without GSTIN", value: rows.filter((r) => !r.gstin).length, kind: "int" },
        ],
      };
    },
  },
  {
    key: "support",
    name: "Support report",
    description: "Tickets raised in the period with response and resolution times.",
    area: "Support",
    usesRange: true,
    async run({ from, to }) {
      const res = await supabaseAdmin
        .from("support_tickets")
        .select("id, code, subject, category, priority, status, created_at, resolved_at, raised_by, institutions:institution_id(name), ticket_messages(author_id, is_internal, created_at)")
        .gte("created_at", startOf(from)).lte("created_at", endOf(to)).order("created_at").limit(ROW_LIMIT);
      const firstResponses: number[] = [];
      const resolutions: number[] = [];
      const rows = (check(res) as any[]).map((t) => {
        // first reply from someone other than the person who raised the ticket (internal notes do not count)
        const reply = (t.ticket_messages ?? [])
          .filter((m: any) => !m.is_internal && m.author_id !== t.raised_by && m.created_at > t.created_at)
          .sort((a: any, b: any) => a.created_at.localeCompare(b.created_at))[0];
        const first = reply ? hours(t.created_at, reply.created_at) : null;
        const resolved = t.resolved_at ? hours(t.created_at, t.resolved_at) : null;
        if (first !== null) firstResponses.push(first);
        if (resolved !== null) resolutions.push(resolved);
        return { ticket: t.code, subject: t.subject, school: t.institutions?.name ?? null, category: t.category, priority: t.priority, status: t.status,
          created: String(t.created_at).slice(0, 10), first_response_hours: first, resolution_hours: resolved };
      });
      return {
        columns: [col("ticket", "Ticket"), col("subject", "Subject"), col("school", "School"), col("category", "Category"), col("priority", "Priority"),
          col("status", "Status"), col("created", "Raised", "date"), col("first_response_hours", "First reply (hours)"), col("resolution_hours", "Resolved in (hours)")],
        rows,
        summary: [
          { label: "Tickets", value: rows.length, kind: "int" },
          { label: "Resolved", value: rows.filter((r) => ["Resolved", "Closed"].includes(String(r.status))).length, kind: "int" },
          { label: "Avg first reply (hours)", value: avg(firstResponses) },
          { label: "Avg resolution (hours)", value: avg(resolutions) },
        ],
      };
    },
  },
  {
    key: "communication",
    name: "Communication report",
    description: "Announcements sent in the period and how many schools received each. Only in-app delivery exists today.",
    area: "Operations",
    usesRange: true,
    async run({ from, to }) {
      const res = await supabaseAdmin
        .from("announcements")
        .select("title, audience, channels, sent_at, announcement_deliveries(count)")
        .eq("status", "sent").gte("sent_at", startOf(from)).lte("sent_at", endOf(to)).order("sent_at").limit(ROW_LIMIT);
      const rows = (check(res) as any[]).map((a) => ({
        sent: String(a.sent_at).slice(0, 10), title: a.title, audience: a.audience?.type === "all" ? "All live schools" : a.audience?.type === "plans" ? "By plan" : "Selected schools",
        channels: (a.channels ?? []).join(", "), schools_reached: a.announcement_deliveries?.[0]?.count ?? 0,
      }));
      return {
        columns: [col("sent", "Sent", "date"), col("title", "Announcement"), col("audience", "Audience"), col("channels", "Channels"), col("schools_reached", "Schools reached", "int")],
        rows,
        summary: [{ label: "Announcements", value: rows.length, kind: "int" }, { label: "Deliveries", value: rows.reduce((a, r) => a + r.schools_reached, 0), kind: "int" }],
      };
    },
  },
];

/** The report groups of the Super Admin design, in menu order. Reports that fit none go under "Support & communication". */
export const REPORT_GROUPS = [
  { key: "schools", label: "School reports" },
  { key: "users", label: "User reports" },
  { key: "financial", label: "Financial reports" },
  { key: "subscriptions", label: "Subscription reports" },
  { key: "modules", label: "Module reports" },
  { key: "security", label: "Security reports" },
  { key: "system", label: "System reports" },
  { key: "operations", label: "Support & communication" },
] as const;
const GROUP_OF_EXISTING: Record<string, string> = { schools: "schools", revenue: "financial", gst: "financial", subscriptions: "subscriptions", support: "operations", communication: "operations" };

const ALL: (ReportDef & { group: string })[] = [
  ...REPORTS.map((r) => ({ ...r, group: GROUP_OF_EXISTING[r.key] ?? "operations" })),
  ...(PLATFORM_REPORTS as unknown as (ReportDef & { group: string })[]),
];

export function listReports() {
  return { groups: REPORT_GROUPS, reports: ALL.map(({ key, name, description, area, usesRange, group }) => ({ key, name, description, area, usesRange, group })) };
}

export async function runReport(key: string, query: Record<string, unknown>): Promise<ReportResult & { range: Range; name: string }> {
  const def = ALL.find((r) => r.key === key);
  if (!def) throw new HttpError(404, "Unknown report.");
  const range = parseRange(query);
  const result = await def.run(range);
  const truncated = result.rows.length >= ROW_LIMIT;
  return { name: def.name, range, ...result, truncated, group: def.group } as never;
}

/** Money is exported in rupees with two decimals, dates as-is. */
export async function exportReportCsv(key: string, query: Record<string, unknown>): Promise<{ filename: string; body: string }> {
  const r = await runReport(key, query);
  const rows = r.rows.map((row) =>
    r.columns.map((c) => {
      const v = row[c.key];
      return c.kind === "money" && typeof v === "number" ? (v / 100).toFixed(2) : v;
    })
  );
  const csv = toCsv(r.columns.map((c) => (c.kind === "money" ? `${c.label} (INR)` : c.label)), rows);
  return { filename: `${key}-${r.range.from}-to-${r.range.to}.csv`, body: csv };
}

// ─────────────────────────────────────────────
//  Overview
// ─────────────────────────────────────────────
export async function getOverview() {
  const [overview, students, catalogue] = await Promise.all([
    supabaseAdmin.from("platform_school_overview").select("state, status, students, arr_paise").limit(ROW_LIMIT),
    supabaseAdmin.from("students").select("created_at").is("deleted_at", null).limit(50_000),
    listModules(),
  ]);
  const schools = check(overview) as { state: string | null; status: string; students: number; arr_paise: number }[];
  const created = (check(students) as { created_at: string }[]).map((s) => s.created_at);

  const months: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) months.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  const studentsGrowth = months.map((m) => ({ month: m, students: created.filter((c) => c.slice(0, 7) <= m).length }));

  const live = schools.filter((s) => ["Active", "Trial", "Overdue"].includes(s.status));
  const byState = new Map<string, { schools: number; students: number }>();
  schools.forEach((s) => {
    const k = s.state || "Unspecified";
    const cur = byState.get(k) ?? { schools: 0, students: 0 };
    byState.set(k, { schools: cur.schools + 1, students: cur.students + s.students });
  });
  const totalAccess = catalogue.modules.reduce((a, m) => a + (m.schools_with_access ?? 0), 0);

  return {
    totals: {
      schools: schools.length,
      liveSchools: live.length,
      students: schools.reduce((a, s) => a + s.students, 0),
      arr_paise: schools.filter((s) => s.status === "Active").reduce((a, s) => a + s.arr_paise, 0),
      avgModulesPerSchool: live.length ? Math.round((totalAccess / live.length) * 10) / 10 : 0,
      totalModules: catalogue.modules.length,
    },
    studentsGrowth,
    moduleAccess: catalogue.modules
      .map((m) => ({ name: m.name, schools: m.schools_with_access ?? 0, percent: live.length ? Math.round(((m.schools_with_access ?? 0) / live.length) * 100) : 0 }))
      .sort((a, b) => b.percent - a.percent),
    schoolsByState: Array.from(byState.entries()).map(([state, v]) => ({ state, ...v })).sort((a, b) => b.schools - a.schools),
  };
}
