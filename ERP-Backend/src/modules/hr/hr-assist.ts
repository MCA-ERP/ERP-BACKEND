import { supabaseAdmin } from "../../../db/client";
import { scopeRule } from "../../lib/assist-scope";
import { HttpError } from "../../lib/http-error";
import type { AssistAction } from "../admin/assist-actions";
import { runAgent } from "../admin/assist-agent";
import type { ChatMessage } from "../admin/assist.service";
import { MODEL, NOT_SET, limit, provider, tidy } from "../admin/assist.service";
import { directory } from "../school/hr.service";
import * as p from "./hr-portal.service";

/**
 * The assistant inside the HR portal. Its tools read the school's staff, leave, hiring and payroll status (the school and the
 * person come from the signed-in account, never from the question), carry no PAN, bank or salary figures, and change nothing.
 */
const trim = (v: unknown, max = 9000) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…[cut]" : s; };

const TOOLS = [
  { name: "hr_today", description: "HR today: number of employees, present and on leave today, leave requests waiting, this month's payroll status and pay date, the 8-step HR and payroll workflow, and what is waiting for HR.", parameters: { type: "object", properties: {} } },
  { name: "staff_list", description: "Staff of this school: employee id, name, department, designation, joining date. Optional search by name, department or designation.", parameters: { type: "object", properties: { search: { type: "string" } } } },
  { name: "hiring_pipeline", description: "Open posts, applications, shortlisted, selected, offers and days to fill.", parameters: { type: "object", properties: {} } },
  { name: "my_notifications", description: "What needs HR's attention now.", parameters: { type: "object", properties: {} } },
  { name: "portal_guide", description: "Every page of the HR portal with its address. Call it to explain where something is or to find an address for open_page_link.", parameters: { type: "object", properties: {} } },
  { name: "open_page_link", description: "Offer a button that opens an HR portal page, using an address from portal_guide.", parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" }, go: { type: "boolean", description: "true when the person asked to open the page" } }, required: ["href"] } },
] as const;

async function runTool(inst: string, me: string, mods: string[], name: string, input: Record<string, unknown>, actions: AssistAction[], guide: string): Promise<string> {
  try {
    if (name === "hr_today") return trim(await p.overview(inst, mods));
    if (name === "staff_list") {
      const q = String(input.search ?? "").toLowerCase();
      const items = (await directory(inst)).items.filter((s) => !q || `${s.name} ${s.department} ${s.designation} ${s.emp_code}`.toLowerCase().includes(q));
      return trim({ count: items.length, staff: items.slice(0, 40).map((s) => ({ id: s.emp_code, name: s.name, department: s.department, designation: s.designation, joined: s.joined_on })) });
    }
    if (name === "hiring_pipeline") return trim(await p.pipeline(inst));
    if (name === "my_notifications") return trim((await p.notifications(inst, me, mods)).items.map((n) => ({ title: n.title, detail: n.detail, unread: !n.read })));
    if (name === "portal_guide") return guide || "No page list was sent.";
    if (name === "open_page_link") {
      const href = String(input.href ?? "");
      if (!/^\/hr(\/[a-z0-9-]+){0,2}(\?[a-z0-9=&_-]*)?$/i.test(href) || !(guide.includes(`(${href.split("?")[0]})`) || href.split("?")[0] === "/hr")) return "That address is not in the portal. Call portal_guide and use an address from it.";
      actions.push({ kind: "link", label: String(input.label ?? "Open page").slice(0, 60), href, go: input.go === true });
      return "Button added.";
    }
    return `Unknown tool '${name}'.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "the lookup failed"}`;
  }
}

export async function hrChat(messages: ChatMessage[], page: string | undefined, guide: string, inst: string, me: string, mods: string[], roleLabel: string): Promise<{ reply: string; actions: AssistAction[] }> {
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);
  limit(me);
  const { data } = await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle();
  const school = (data as { name: string } | null)?.name ?? "the school";
  const system = [
    `You are MCA Assist, the assistant inside the HR portal of ${school}, on the My Class Assist school ERP. You are talking to ${roleLabel || "the HR manager"}. You know this portal and the school's staff, leave, hiring and payroll status.`,
    "You have read-only tools for this school's HR records. For ANY question about staff, attendance, leave, hiring, payroll status or notifications, call the tools and answer from what they return. Never guess or invent a number, name or date. You do not have anyone's PAN, bank account or salary: say those are on the payroll pages.",
    "When someone asks to open or go to a page (in English, Hindi or Telugu), call portal_guide if you need the address, then open_page_link with go=true, and confirm in one short line. Do not say a page is open unless you called the tool. When someone asks how to find a page, answer in one line with the bold path and call open_page_link.",
    "Answer directly and briefly in plain language. Write **bold** around page names and menu paths, joined with arrows. Use short lines or simple lists; never markdown tables, pipes or headings, and never write HTML. Reply in the language the person wrote or spoke in (English, Hindi or Telugu); keep page names in English. Never show ids or UUIDs. Dates like 12 Oct 2026.",
    page ? `The person is currently on: ${page}` : "",
    scopeRule("HR portal", "this school's staff, attendance, leave, recruitment, payroll status and how to use the portal", "student marks or attendance, fees, admission decisions, individual pay or bank details, the platform or other schools"),
  ].filter(Boolean).join("\n\n");
  try {
    const out = await runAgent({ provider: which, model: MODEL(), system, messages: messages.slice(-12), user: { permissions: [] }, tools: TOOLS as never, run: (n, i, ac) => runTool(inst, me, mods, n, i, ac, guide) });
    return { reply: tidy(out.text) || "I could not come up with an answer. Try asking in another way.", actions: out.actions };
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("HR assistant failed:", status, err instanceof Error ? err.message.slice(0, 300) : err);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, status === 401 || status === 403 ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server." : status === 429 ? "The AI assistant is busy right now. Try again in a minute." : "The AI assistant could not answer right now. Try again in a moment.");
  }
}
