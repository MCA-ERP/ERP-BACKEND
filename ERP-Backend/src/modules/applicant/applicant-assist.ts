import { supabaseAdmin } from "../../../db/client";
import { HttpError } from "../../lib/http-error";
import { scopeRule } from "../../lib/assist-scope";
import type { AssistAction } from "../admin/assist-actions";
import { runAgent } from "../admin/assist-agent";
import type { ChatMessage } from "../admin/assist.service";
import { MODEL, NOT_SET, limit, provider, tidy } from "../admin/assist.service";
import * as a from "./applicant.service";

/**
 * The assistant inside the Applicant portal. Every tool reads only what belongs to the signed-in family (the school and the
 * family come from the signed-in account, never from the question), plus the school's public admission information
 * (classes, seats, fees, calendar, FAQs). It has no tool for staff, other families, school-wide numbers or money books, and it
 * cannot change data: it can only point to pages.
 */
const trim = (v: unknown, max = 8000) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…[cut]" : s; };
const none = { type: "object", properties: {} } as const;

const TOOLS = [
  { name: "my_applications", description: "This family's applications: child, class, status and the 8-step progress.", parameters: none },
  { name: "my_status", description: "Where this family's application stands: next step, documents verified, assessment, seats left in the class, fees paid, key dates and latest office messages.", parameters: none },
  { name: "my_documents", description: "The documents for this family's application: which are uploaded, verified or need a re-upload.", parameters: none },
  { name: "my_fees", description: "What this family owes and has paid: application fee, admission fee and receipts.", parameters: none },
  { name: "my_notifications", description: "This family's notifications.", parameters: none },
  { name: "school_classes_and_seats", description: "Classes open for admission with eligibility, seats and seats left.", parameters: none },
  { name: "school_fee_structure", description: "The school's fee structure for a class (admission fee, caution deposit, regular fees).", parameters: { type: "object", properties: { class: { type: "string", description: "Nursery, LKG, UKG or Class 1 to Class 12" } }, required: ["class"] } },
  { name: "school_calendar", description: "Published admission dates.", parameters: none },
  { name: "school_faqs", description: "The school's published admission FAQs.", parameters: none },
  { name: "school_overview", description: "The school's public profile: board, classes, campuses, contact.", parameters: none },
  { name: "portal_guide", description: "Every page of the Applicant portal with its address.", parameters: none },
  { name: "open_page_link", description: "Offer a button that opens an Applicant portal page, using an address from portal_guide.", parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" }, go: { type: "boolean" } }, required: ["href"] } },
] as const;

async function runTool(inst: string, me: string, name: string, input: Record<string, unknown>, actions: AssistAction[], guide: string): Promise<string> {
  try {
    if (name === "my_applications") return trim((await a.myApplications(inst, me)).items.map((x) => ({ child: x.child, class: x.class_sought, code: x.code, status: x.label, draft: x.draft, steps: x.steps.map((s) => `${s.label}: ${s.state}`) })));
    if (name === "my_status") return trim(await a.overview(inst, me));
    if (name === "my_documents") { const first = (await a.myApplications(inst, me)).items[0]; return first ? trim((await a.documents(inst, me, first.id)).items.map((d) => ({ document: d.doc_type, needed: d.required ? "required" : "optional", status: d.status, note: d.note }))) : "There is no application yet."; }
    if (name === "my_fees") return trim((await a.fees(inst, me)).items.map((i) => ({ child: i.child, lines: i.lines.map((l) => ({ fee: l.label, amount: l.amount, status: l.status })), receipts: i.receipts })));
    if (name === "my_notifications") return trim((await a.notifications(inst, me)).items.map((n) => ({ title: n.title, text: n.text, unread: n.unread })));
    if (name === "school_classes_and_seats") return trim(await a.classesAndSeats(inst));
    if (name === "school_fee_structure") return trim(await a.feeStructure(inst, String(input.class ?? "Class 1")));
    if (name === "school_calendar") return trim(await a.calendar(inst));
    if (name === "school_faqs") return trim(await a.faqs(inst));
    if (name === "school_overview") { const o = await a.schoolOverview(inst); return trim({ name: o.name, board: o.board, classes: o.classes, campuses: o.campuses, contact: o.contact }); }
    if (name === "portal_guide") return guide || "No page list was sent.";
    if (name === "open_page_link") {
      const href = String(input.href ?? "");
      if (!/^\/applicant(\/[a-z0-9-]+){0,2}(\?[a-z0-9=&_-]*)?$/i.test(href) || !(guide.includes(`(${href.split("?")[0]})`) || href.split("?")[0] === "/applicant")) return "That address is not in the portal. Call portal_guide and use an address from it.";
      actions.push({ kind: "link", label: String(input.label ?? "Open page").slice(0, 60), href, go: input.go === true });
      return "Button added.";
    }
    return `Unknown tool '${name}'.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "the lookup failed"}`;
  }
}

export async function applicantChat(messages: ChatMessage[], page: string | undefined, guide: string, inst: string, me: string): Promise<{ reply: string; actions: AssistAction[] }> {
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);
  limit(me);
  const { data } = await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle();
  const school = (data as { name: string } | null)?.name ?? "the school";
  const system = [
    `You are MCA Assist, the assistant inside the Applicant portal of ${school}, on the My Class Assist school ERP. You are talking to a parent or guardian who is applying for their child's admission.`,
    "You have read-only tools for THIS family's own application, documents, fees, messages and notifications, and for the school's public admission information (classes and seats, fees, calendar, FAQs). For questions about their application, call the tools and answer from what they return. Never guess or invent a name, number, date or amount. You cannot change anything: for an action (upload, book, pay, message) tell them which page does it and offer a button.",
    "When someone asks to open or go to a page (in English, Hindi or Telugu), call portal_guide if you need the address, then open_page_link with go=true, and confirm in one short line. Do not say a page is open unless you called the tool.",
    "Answer directly and briefly in plain, friendly language. Write **bold** around page names and menu paths, joined with arrows. Use short lines or simple lists; never markdown tables, pipes or headings, and never write HTML. Reply in the language the person wrote or spoke in (English, Hindi or Telugu); keep page names in English. Never show ids or UUIDs. Money is in rupees, like ₹25,000.",
    scopeRule("Applicant portal", "this family's own application, documents, assessment, fees, messages and notifications, the school's public admission information, and how to use the portal", "how many teachers or students the school has, staff or salary details, other families or applicants, the admissions team's internal leads, merit lists of others, school accounts or collections, marks or attendance, other schools, the platform"),
    page ? `The person is currently on: ${page}` : "",
  ].filter(Boolean).join("\n\n");
  try {
    const out = await runAgent({ provider: which, model: MODEL(), system, messages: messages.slice(-12), user: { permissions: [] }, tools: TOOLS as never, run: (n, i, ac) => runTool(inst, me, n, i, ac, guide) });
    return { reply: tidy(out.text) || "I could not come up with an answer. Try asking in another way.", actions: out.actions };
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("Applicant assistant failed:", status, err instanceof Error ? err.message.slice(0, 300) : err);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, status === 401 || status === 403 ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server." : status === 429 ? "The AI assistant is busy right now. Try again in a minute." : "The AI assistant could not answer right now. Try again in a moment.");
  }
}
