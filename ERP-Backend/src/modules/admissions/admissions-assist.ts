import { supabaseAdmin } from "../../../db/client";
import { scopeRule } from "../../lib/assist-scope";
import { HttpError } from "../../lib/http-error";
import type { AssistAction } from "../admin/assist-actions";
import { runAgent } from "../admin/assist-agent";
import type { ChatMessage } from "../admin/assist.service";
import { MODEL, NOT_SET, limit, provider, tidy } from "../admin/assist.service";
import * as a from "./admissions.service";
import { create as createEnquiry } from "../school/front-office.service";

/**
 * The assistant inside the Admissions portal. It can read this school's admission records and do the lead work the person asks for (add an enquiry,
 * make a lead, log a follow-up, send the application, mark lost) through the same service functions the pages use, so every rule and school check still applies.
 */
const trim = (v: unknown, max = 9000) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…[cut]" : s; };

const TOOLS = [
  { name: "admissions_summary", description: "The admissions season so far: enquiries, applications, admitted, families waiting at each of the 11 steps, fees collected, seats taken against seats, follow-ups due and enquiry sources.", parameters: { type: "object", properties: {} } },
  { name: "find_family", description: "Find a child or family in the admission pipeline by name, parent, mobile, enquiry or application number, or admission number. Returns the step each is at.", parameters: { type: "object", properties: { search: { type: "string" } }, required: ["search"] } },
  { name: "follow_ups_due", description: "Leads whose follow-up is due today or overdue: child, class, parent, mobile, interest, counsellor, date.", parameters: { type: "object", properties: {} } },
  { name: "find_lead", description: "Find a new enquiry or a lead by the child's or parent's name. Returns a lead_id and whether it is a new enquiry or a lead. Always call this before any action on a child; if more than one matches, ask which one.", parameters: { type: "object", properties: { search: { type: "string" } }, required: ["search"] } },
  { name: "create_lead", description: "Make a NEW enquiry a lead (starts follow-up). Use the lead_id from find_lead.", parameters: { type: "object", properties: { lead_id: { type: "string" } }, required: ["lead_id"] } },
  { name: "send_application", description: "Send the application: turns a LEAD into an application. Use the lead_id from find_lead.", parameters: { type: "object", properties: { lead_id: { type: "string" } }, required: ["lead_id"] } },
  { name: "log_followup", description: "Log a call, visit, message or email on a lead.", parameters: { type: "object", properties: { lead_id: { type: "string" }, how: { type: "string", enum: ["Call", "Visit", "Message", "Email"] }, outcome: { type: "string" }, interest: { type: "string", enum: ["Hot", "Warm", "Cold"] }, next_followup: { type: "string", description: "YYYY-MM-DD, optional" } }, required: ["lead_id", "how", "outcome", "interest"] } },
  { name: "mark_lost", description: "Mark a lead or new enquiry as lost, with a reason.", parameters: { type: "object", properties: { lead_id: { type: "string" }, reason: { type: "string" } }, required: ["lead_id", "reason"] } },
  { name: "add_enquiry", description: "Record a new admission enquiry.", parameters: { type: "object", properties: { child: { type: "string" }, class_sought: { type: "string", description: "Nursery, LKG, UKG or Class 1 to Class 12" }, parent_name: { type: "string" }, mobile: { type: "string" }, source: { type: "string", description: "Front office, Phone, Walk-in, Website, Referral, Admission fair or Social media" } }, required: ["child", "class_sought", "parent_name", "mobile"] } },
  { name: "my_notifications", description: "What needs this person's attention now.", parameters: { type: "object", properties: {} } },
  { name: "portal_guide", description: "Every page of the Admissions portal with its address. Call it to explain where something is or to find an address for open_page_link.", parameters: { type: "object", properties: {} } },
  { name: "open_page_link", description: "Offer a button that opens an Admissions portal page, using an address from portal_guide.", parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" }, go: { type: "boolean", description: "true when the person asked to open it now" } }, required: ["href"] } },
] as const;

async function runTool(inst: string, me: string, name: string, input: Record<string, unknown>, actions: AssistAction[], guide: string): Promise<string> {
  try {
    if (name === "admissions_summary") return trim(await a.overview(inst));
    if (name === "find_family") { const r = await a.search(inst, input.search); return r.hits.length ? trim(r.hits.map((x) => ({ child: x.title, details: x.subtitle }))) : "Nobody matches that."; }
    if (name === "follow_ups_due") return trim((await a.leads(inst, true)).items.slice(0, 30));
    if (name === "find_lead") { const q = String(input.search ?? "").toLowerCase(); const [e, l] = await Promise.all([a.newEnquiries(inst), a.leads(inst, false)]); const hits = [...e.items.map((x) => ({ lead_id: x.id, kind: "new enquiry", child: x.child, class: x.class_sought, parent: x.parent_name })), ...l.items.map((x) => ({ lead_id: x.id, kind: "lead", child: x.child, class: x.class_sought, parent: x.parent_name }))].filter((x) => `${x.child} ${x.parent}`.toLowerCase().includes(q)); return hits.length ? trim(hits.slice(0, 8)) : "No lead or new enquiry matches that name."; }
    if (name === "create_lead") { await a.createLead(inst, me, String(input.lead_id)); return "Done: the enquiry is now a lead."; }
    if (name === "send_application") { await a.sendApplication(inst, me, String(input.lead_id)); return "Done: the lead is now an application (step 3, Application)."; }
    if (name === "log_followup") { await a.logFollowup(inst, me, String(input.lead_id), { how: input.how, outcome: input.outcome, interest: input.interest, next_followup: typeof input.next_followup === "string" ? input.next_followup : null }); return "Done: the follow-up is logged."; }
    if (name === "mark_lost") { await a.markLost(inst, String(input.lead_id), { reason: input.reason }); return "Done: marked lost."; }
    if (name === "add_enquiry") { await createEnquiry(inst, "adm-enquiries", { child: input.child, class_sought: input.class_sought, parent_name: input.parent_name, mobile: String(input.mobile ?? "").replace(/D/g, "").slice(-10), source: typeof input.source === "string" ? input.source : "Front office" }, me); return "Done: the enquiry is recorded."; }
    if (name === "my_notifications") return trim((await a.notifications(inst, me)).items.map((n) => ({ title: n.title, note: n.note, unread: !n.read })));
    if (name === "portal_guide") return guide || "No page list was sent.";
    if (name === "open_page_link") {
      const href = String(input.href ?? "");
      if (!/^\/admissions(\/[a-z0-9-]+){0,2}(\?[a-z0-9=&_-]*)?$/i.test(href) || !(guide.includes(`(${href.split("?")[0]})`) || href.split("?")[0] === "/admissions")) return "That address is not in the portal. Call portal_guide and use an address from it.";
      actions.push({ kind: "link", label: String(input.label ?? "Open page").slice(0, 60), href, go: input.go === true });
      return "Button added.";
    }
    return `Unknown tool '${name}'.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "the lookup failed"}`;
  }
}

export async function admissionsChat(messages: ChatMessage[], page: string | undefined, guide: string, inst: string, me: string, roleLabel: string): Promise<{ reply: string; actions: AssistAction[] }> {
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);
  limit(me);
  const { data } = await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle();
  const school = (data as { name: string } | null)?.name ?? "the school";
  const system = [
    `You are MCA Assist, the assistant inside the Admissions portal of ${school}, on the My Class Assist school ERP. You are talking to ${roleLabel || "the Admissions Head"}. You know this portal and the school's admission records.`,
    "You have tools to read this school's admission records and to do lead work: add_enquiry, create_lead, log_followup, send_application and mark_lost. When the person asks for one of these, DO it with the tools (call find_lead first; if several children match, ask which one) and then say plainly what you did. Never claim an action you did not perform; if a tool returns an error, say what it said. You cannot do anything else (fees, approvals, allocation): say it must be done on the page and offer a link. For ANY question about enquiries, leads, follow-ups, applications, the pipeline, seats, admission fees or notifications, call the tools and answer from what they return. Never guess or invent a number, name or date. You have no access to student marks, attendance, fee dues, HR files or other staff's data: say that is not available here. If nothing matches, say so.",
    "When someone asks to open or go to a page (in English, Hindi or Telugu), call portal_guide if you need the address, then open_page_link with go=true, and confirm in one short line. Do not say a page is open unless you called the tool. When someone asks how to find a page, answer in one line with the bold path (for example: Open **Leads & Follow-up → Lead Management**.), call open_page_link without go.",
    "Answer directly and briefly in plain language. Write **bold** around page names and menu paths, joined with arrows. Use short lines or simple lists; never markdown tables, pipes or headings, and never write HTML. Reply in the language the person wrote or spoke in (English, Hindi or Telugu); keep page names in English. Never show ids or UUIDs.",
    page ? `The person is currently on: ${page}` : "",
  scopeRule("Admissions portal", "this school's enquiries, leads, applications, seats and how to use the portal", "fee ledgers or accounts books, staff salaries, student marks or attendance, the platform or other schools"),
  ].filter(Boolean).join("\n\n");
  try {
    const out = await runAgent({ provider: which, model: MODEL(), system, messages: messages.slice(-12), user: { permissions: [] }, tools: TOOLS as never, run: (n, i, ac) => runTool(inst, me, n, i, ac, guide) });
    return { reply: tidy(out.text) || "I could not come up with an answer. Try asking in another way.", actions: out.actions };
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("Admissions assistant failed:", status, err instanceof Error ? err.message.slice(0, 300) : err);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, status === 401 || status === 403 ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server." : status === 429 ? "The AI assistant is busy right now. Try again in a minute." : "The AI assistant could not answer right now. Try again in a moment.");
  }
}
