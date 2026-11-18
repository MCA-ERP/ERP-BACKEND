import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";

type Cell = string | number | null;
export type AssistAction =
  | { kind: "export"; label: string; name: string; head: string[]; rows: Cell[][]; auto?: boolean }
  | { kind: "link"; label: string; href: string; go?: boolean };
export interface AssistResult { reply: string; actions: AssistAction[] }

const rupees = (paise: number | null | undefined) => `₹${Math.round((paise ?? 0) / 100).toLocaleString("en-IN")}`;
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const STATUS_WORDS: [RegExp, string][] = [[/\bactive\b/, "Active"], [/\btrial/, "Trial"], [/\bpending|waiting|approval/, "Pending"], [/\bsuspended/, "Suspended"], [/\bexpired/, "Expired"], [/\binactive/, "Inactive"], [/\boverdue/, "Overdue"]];

interface SchoolRow { code: string; name: string; type: string | null; board: string | null; city: string | null; state: string | null; status: string; plan_name: string | null; students: number; contact_name: string | null; contact_email: string | null; contact_phone: string | null; renews_on: string | null; trial_ends_on: string | null; created_at: string }

async function schools(status?: string): Promise<SchoolRow[]> {
  let q = supabaseAdmin.from("platform_school_overview").select("code, name, type, board, city, state, status, plan_name, students, contact_name, contact_email, contact_phone, renews_on, trial_ends_on, created_at").order("name").limit(5000);
  if (status) q = q.eq("status", status);
  return check(await q) as unknown as SchoolRow[];
}
const schoolTable = (list: SchoolRow[]): { head: string[]; rows: Cell[][] } => ({
  head: ["Code", "School", "Type", "Board", "City", "State", "Status", "Plan", "Students", "Contact", "Email", "Phone", "Renews on", "Registered"],
  rows: list.map((s) => [s.code, s.name, s.type, s.board, s.city, s.state, s.status, s.plan_name, s.students, s.contact_name, s.contact_email, s.contact_phone, day(s.renews_on), day(s.created_at)]),
});

interface InvoiceRow { number: string; school_name: string; school_code: string; issue_date: string | null; due_on: string | null; total_paise: number; paid_paise: number; balance_paise: number; status: string }
async function invoices(overdueOnly: boolean): Promise<InvoiceRow[]> {
  let q = supabaseAdmin.from("platform_invoice_overview").select("number, school_name, school_code, issue_date, due_on, total_paise, paid_paise, balance_paise, status").order("due_on", { ascending: true }).limit(5000);
  if (overdueOnly) q = q.eq("status", "Overdue");
  return check(await q) as unknown as InvoiceRow[];
}

interface TicketRow { code: string; subject: string; category: string; priority: string; status: string; raised_by_name: string | null; created_at: string; institutions: { name: string } | null }
async function tickets(openOnly: boolean): Promise<TicketRow[]> {
  let q = supabaseAdmin.from("support_tickets").select("code, subject, category, priority, status, raised_by_name, created_at, institutions:institution_id(name)").order("created_at", { ascending: false }).limit(5000);
  if (openOnly) q = q.in("status", ["Open", "In progress", "Waiting on school"]);
  return check(await q) as unknown as TicketRow[];
}

const list = (items: string[], max = 8) => items.slice(0, max).map((s) => `• ${s}`).join("\n") + (items.length > max ? `\n…and ${items.length - max} more.` : "");

/**
 * Questions the portal can answer exactly from its own data: lists, counts and exports. These never go to the AI model,
 * so they are right, instant and work even when the AI key is not set. Returns null when the question is something else.
 */
export async function answerFromData(question: string): Promise<AssistResult | null> {
  const res = await route(question);
  if (res && res.actions.some((a) => a.kind === "export" && a.auto && !a.rows.length)) return { reply: "There is nothing to export for that right now.", actions: [] };
  return res;
}

async function route(question: string): Promise<AssistResult | null> {
  const q = question.toLowerCase();
  // anything with a qualifier ("per state", "on which plan", "last month") is for the AI agent, which can look it up properly
  if (question.length > 80 || /\b(plan|state|city|cities|per|by|each|renew|renewal|board|login|logins|when|where|than|since|last|month|week|today|yesterday|revenue|students?|teachers?|parents?|users?|ip|from|between|top|most|least|compare|average|percent|why|how much|how long)\b/.test(q)) return null;
  const wantsFile = /\b(export|download|csv|excel|xlsx|spreadsheet|pdf|print|save)\b/.test(q);
  const status = STATUS_WORDS.find(([re]) => re.test(q))?.[1];

  // ── schools ──
  if (/\bschools?\b/.test(q)) {
    if (wantsFile) {
      const rows = await schools(status);
      const t = schoolTable(rows);
      const what = status ? `${status.toLowerCase()} schools` : "schools";
      return { reply: `Here is the list of ${plural(rows.length, "school")}${status ? ` (${status})` : ""}. The export window is open: pick Excel, PDF or CSV.`, actions: [{ kind: "export", label: `Export ${what}`, name: status ? `${status.toLowerCase()}-schools` : "schools", ...t, auto: true }] };
    }
    if (/need(s)? attention|attention|problem|at risk|risk/.test(q)) {
      const all = await schools();
      const soon = Date.now() + 7 * 86_400_000;
      const flagged = all.filter((s) => ["Pending", "Suspended", "Expired", "Overdue"].includes(s.status) || (s.status === "Trial" && s.trial_ends_on && new Date(s.trial_ends_on).getTime() < soon));
      if (!flagged.length) return { reply: "No school needs attention right now. None are pending, suspended, expired or overdue, and no trial ends this week.", actions: [] };
      const t = schoolTable(flagged);
      return { reply: `${plural(flagged.length, "school")} need${flagged.length === 1 ? "s" : ""} attention:\n${list(flagged.map((s) => `${s.name} (${s.status}${s.status === "Trial" && s.trial_ends_on ? `, trial ends ${day(s.trial_ends_on)}` : ""})`))}`, actions: [{ kind: "export", label: "Export this list", name: "schools-needing-attention", ...t }, { kind: "link", label: "Open School Directory", href: "/super-admin/schools/directory" }] };
    }
    if (/how many|count|number of|total/.test(q)) {
      const all = await schools();
      const n = status ? all.filter((s) => s.status === status).length : all.length;
      return { reply: status ? `${plural(n, "school")} ${n === 1 ? "is" : "are"} ${status.toLowerCase()} right now, out of ${all.length} registered.` : `${plural(all.length, "school")} ${all.length === 1 ? "is" : "are"} registered.`, actions: [] };
    }
    if (status || /\b(list|show|which|what|who)\b/.test(q)) {
      const rows = await schools(status);
      if (!rows.length) return { reply: `No ${status ? status.toLowerCase() + " " : ""}schools.`, actions: [] };
      const t = schoolTable(rows);
      return { reply: `${plural(rows.length, status ? `${status.toLowerCase()} school` : "school")}:\n${list(rows.map((s) => `${s.name}${s.city ? `, ${s.city}` : ""}${status ? "" : ` (${s.status})`}`))}`, actions: [{ kind: "export", label: "Export this list", name: status ? `${status.toLowerCase()}-schools` : "schools", ...t }, { kind: "link", label: "Open School Directory", href: "/super-admin/schools/directory" }] };
    }
  }

  // ── invoices ──
  if (/\binvoices?\b|\bdues?\b|\boutstanding\b/.test(q)) {
    const overdue = /overdue|outstanding|unpaid|late|\bdue\b/.test(q);
    const rows = await invoices(overdue);
    const head = ["Invoice", "School code", "School", "Issued", "Due", "Total (₹)", "Paid (₹)", "Balance (₹)", "Status"];
    const table = rows.map((r): Cell[] => [r.number, r.school_code, r.school_name, day(r.issue_date), day(r.due_on), Math.round(r.total_paise / 100), Math.round(r.paid_paise / 100), Math.round(r.balance_paise / 100), r.status]);
    const exportAction: AssistAction = { kind: "export", label: overdue ? "Export overdue invoices" : "Export invoices", name: overdue ? "overdue-invoices" : "invoices", head, rows: table, auto: wantsFile };
    if (wantsFile) return { reply: `Here are ${plural(rows.length, overdue ? "overdue invoice" : "invoice")}. The export window is open: pick Excel, PDF or CSV.`, actions: [exportAction] };
    if (overdue) {
      if (!rows.length) return { reply: "No invoices are overdue.", actions: [] };
      const owed = rows.reduce((s, r) => s + r.balance_paise, 0);
      return { reply: `${plural(rows.length, "invoice")} overdue, ${rupees(owed)} in total:\n${list(rows.map((r) => `${r.number} · ${r.school_name} · ${rupees(r.balance_paise)} (due ${day(r.due_on)})`))}`, actions: [exportAction, { kind: "link", label: "Open Invoices", href: "/super-admin/payments/invoices" }] };
    }
  }

  // ── support tickets ──
  if (/\btickets?\b/.test(q)) {
    const open = !/\ball\b/.test(q);
    const rows = await tickets(open);
    const head = ["Ticket", "School", "Subject", "Category", "Priority", "Status", "Raised by", "Created"];
    const table = rows.map((t): Cell[] => [t.code, t.institutions?.name ?? "", t.subject, t.category, t.priority, t.status, t.raised_by_name, day(t.created_at)]);
    const exportAction: AssistAction = { kind: "export", label: open ? "Export open tickets" : "Export tickets", name: open ? "open-tickets" : "tickets", head, rows: table, auto: wantsFile };
    if (wantsFile) return { reply: `Here are ${plural(rows.length, open ? "open ticket" : "ticket")}. The export window is open.`, actions: [exportAction] };
    if (/how many|count|number/.test(q)) return { reply: `${plural(rows.length, open ? "ticket" : "ticket")} ${open ? "are open" : "in total"}.`, actions: [] };
    return { reply: rows.length ? `${plural(rows.length, "open ticket")}:\n${list(rows.map((t) => `${t.code} · ${t.subject}${t.institutions ? ` · ${t.institutions.name}` : ""} (${t.priority})`))}` : "No open support tickets.", actions: [exportAction, { kind: "link", label: "Open Support tickets", href: "/super-admin/support/tickets" }] };
  }
  return null;
}
