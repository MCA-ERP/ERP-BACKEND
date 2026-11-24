import { supabaseAdmin } from "../../../db/client";
import { scopeRule } from "../../lib/assist-scope";
import { HttpError } from "../../lib/http-error";
import type { AssistAction } from "../admin/assist-actions";
import { runAgent } from "../admin/assist-agent";
import type { ChatMessage } from "../admin/assist.service";
import { MODEL, NOT_SET, limit, provider, tidy } from "../admin/assist.service";
import { pending, receipts } from "../school/fees2.service";
import * as a from "./accounts.service";
import * as cf from "./accounts-fees.service";

/**
 * The assistant inside the Accounts portal. Its tools read the school's fee and finance records (the school and the person come from
 * the signed-in account, never from the question) and nothing here can change data. Directions come from the portal's own page list.
 */
const trim = (v: unknown, max = 9000) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…[cut]" : s; };
const filters = { search: { type: "string" }, export: { type: "boolean", description: "true when the person wants a file (Excel, PDF or CSV)" }, export_label: { type: "string" } };

const TOOLS = [
  { name: "fee_summary", description: "Fee collection this academic year: collected today and this month, outstanding, overdue students, collection rate, collection by month, by payment method, outstanding by class, and income against expenditure.", parameters: { type: "object", properties: {} } },
  { name: "overdue_students", description: "Students with overdue fees: class, parent, mobile, amount due, days overdue.", parameters: { type: "object", properties: { ...filters } } },
  { name: "latest_receipts", description: "The latest fee receipts: receipt number, student, amount, mode, date. Optional search by student or receipt number.", parameters: { type: "object", properties: { ...filters } } },
  { name: "concessions", description: "Concession types the school offers and who has an approved concession this year.", parameters: { type: "object", properties: {} } },
  { name: "my_notifications", description: "What needs this accountant's attention now.", parameters: { type: "object", properties: {} } },
  { name: "insights", description: "AI insights found in this month's accounts, fees and spending.", parameters: { type: "object", properties: {} } },
  { name: "portal_guide", description: "Every page of the Accounts portal with its address. Call it to explain where something is or to find an address for open_page_link.", parameters: { type: "object", properties: {} } },
  { name: "open_page_link", description: "Offer a button that opens an Accounts portal page, using an address from portal_guide.", parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" }, go: { type: "boolean", description: "true when the person asked to open or go to the page now (in any language); false when they only asked where it is" } }, required: ["href", "label"] } },
] as const;

async function runTool(inst: string, me: string, name: string, input: Record<string, unknown>, actions: AssistAction[], guide: string): Promise<string> {
  try {
    const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
    const file = (label: string, nm: string, head: string[], rows: (string | number | null)[][]) => actions.push({ kind: "export", label: label.slice(0, 60), name: nm, head, rows, auto: true });
    if (name === "fee_summary") return trim(await a.overview(inst));
    if (name === "overdue_students") {
      const r = await pending(inst, "overdue");
      const q = (str("search") ?? "").toLowerCase();
      const items = r.items.filter((x) => !q || `${x.student} ${x.class_label} ${x.registration_no}`.toLowerCase().includes(q));
      if (input.export === true) {
        if (!items.length) return "Nobody matches, so there is nothing to export.";
        file(str("export_label") ?? "Export overdue fees", "overdue-fees", ["Student", "Admission no.", "Class", "Parent", "Mobile", "Amount due", "Days overdue"], items.map((x) => [x.student, x.registration_no, x.class_label, x.father, x.mobile, x.due, x.days_overdue]));
        return trim({ exported_rows: items.length, note: "An export window opens. Tell the person how many rows it holds." });
      }
      return trim({ overdue_students: items.length, total_due: items.reduce((n, x) => n + x.due, 0), students: items.slice(0, 30).map((x) => ({ name: x.student, class: x.class_label, parent: x.father, mobile: x.mobile, due: x.due, days_overdue: x.days_overdue })) });
    }
    if (name === "latest_receipts") {
      const r = await receipts(inst);
      const q = (str("search") ?? "").toLowerCase();
      const items = r.items.filter((x) => x.status === "Valid" && (!q || `${x.student} ${x.receipt_no}`.toLowerCase().includes(q)));
      if (input.export === true && items.length) { file(str("export_label") ?? "Export receipts", "receipts", ["Receipt", "Date", "Student", "Class", "Amount", "Mode"], items.map((x) => [x.receipt_no, x.paid_on, x.student, x.class_label, x.total, x.mode])); return trim({ exported_rows: items.length }); }
      return trim({ count: items.length, receipts: items.slice(0, 15).map((x) => ({ receipt: x.receipt_no, date: x.paid_on, student: x.student, class: x.class_label, amount: x.total, mode: x.mode })) });
    }
    if (name === "concessions") {
      const [t, r] = await Promise.all([cf.concessionTypes(inst), cf.concessionRegister(inst)]);
      return trim({ types: t.items.map((x) => ({ name: x.name, value: x.value_text, for: x.for_whom, approved_by: x.approved_by, students: x.students })), students_with_concession: r.students, given_this_year: r.given });
    }
    if (name === "my_notifications") return trim((await a.notifications(inst, me)).items.map((n) => ({ title: n.title, note: n.note, unread: !n.read })));
    if (name === "insights") return trim(((await a.insightList(inst, me)) as unknown as { items: { title: string; text: string; suggest: string }[] }).items);
    if (name === "portal_guide") return guide || "No page list was sent.";
    if (name === "open_page_link") {
      const href = String(input.href ?? "");
      if (!/^\/accounts(\/[a-z0-9-]+){0,2}(\?[a-z0-9=&_-]*)?$/i.test(href) || !(guide.includes(`(${href.split("?")[0]})`) || href.split("?")[0] === "/accounts")) return "That address is not in the portal. Call portal_guide and use an address from it.";
      actions.push({ kind: "link", label: String(input.label ?? "Open page").slice(0, 60), href, go: input.go === true });
      return "Button added.";
    }
    return `Unknown tool '${name}'.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "the lookup failed"}`;
  }
}

export async function accountsChat(messages: ChatMessage[], page: string | undefined, guide: string, inst: string, me: string, roleLabel: string): Promise<{ reply: string; actions: AssistAction[] }> {
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);
  limit(me);
  const { data } = await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle();
  const school = (data as { name: string } | null)?.name ?? "the school";
  const system = [
    `You are MCA Assist, the assistant inside the Accounts (Fee & Finance) portal of ${school}, on the My Class Assist school ERP. You are talking to ${roleLabel || "the accountant"}. You know this portal and the school's fee and finance records.`,
    "You have read-only tools for this school's fee and finance records. For ANY question about collections, dues, overdue students, receipts, concessions, notifications or insights, call the tools and answer from what they return. Never guess or invent a number, name or date. You have no access to student marks, attendance, HR files or other teachers' data: say that is not available here. If nothing is recorded, say so plainly. You cannot change anything: for actions, say which page to open and what to click.",
    "When someone asks to open or go to a page (in English, Hindi or Telugu), call portal_guide if you need the address, then open_page_link with go=true, and confirm in one short line. Do not say a page is open unless you called the tool. When someone asks how to find a page, answer in one line with the bold path (for example: Open **Fee Collection → Counter Collection**.), call open_page_link once with go=false, and add nothing else. Only point to pages listed by portal_guide.",
    "Money is in rupees; write amounts like ₹1,25,000. Answer directly and briefly in plain language. Write **bold** around page names and menu paths, joined with arrows. Use short lines or simple lists; never markdown tables, pipes or headings, and never write HTML. Reply in the language the person wrote or spoke in (English, Hindi or Telugu); keep page names in English. Never show ids or UUIDs. Dates like 12 Oct 2026. Call tools only through the tool-calling mechanism and never write a tool call into your answer.",
    page ? `The person is currently on: ${page}` : "",
  scopeRule("Fee & Finance portal", "this school's fees, collections, dues, receipts, concessions and how to use the portal", "student marks or attendance, staff salaries or HR, admission decisions, the platform or other schools"),
  ].filter(Boolean).join("\n\n");
  try {
    const out = await runAgent({ provider: which, model: MODEL(), system, messages: messages.slice(-12), user: { permissions: [] }, tools: TOOLS as never, run: (n, i, ac) => runTool(inst, me, n, i, ac, guide) });
    return { reply: tidy(out.text) || "I could not come up with an answer. Try asking in another way.", actions: out.actions };
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("Accounts assistant failed:", status, err instanceof Error ? err.message.slice(0, 300) : err);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, status === 401 || status === 403 ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server." : status === 429 ? "The AI assistant is busy right now. Try again in a minute." : "The AI assistant could not answer right now. Try again in a moment.");
  }
}
