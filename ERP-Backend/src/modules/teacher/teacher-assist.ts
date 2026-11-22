import { supabaseAdmin } from "../../../db/client";
import { HttpError } from "../../lib/http-error";
import type { AssistAction } from "../admin/assist-actions";
import { runAgent } from "../admin/assist-agent";
import type { ChatMessage } from "../admin/assist.service";
import { MODEL, NOT_SET, limit, provider, tidy } from "../admin/assist.service";
import * as t from "./teacher.service";
import * as tt from "./teacher-timetable.service";
import * as cl from "./teacher-classes.service";

/**
 * The assistant inside the Teacher portal. Every tool reads only what belongs to the signed-in teacher (the school and the
 * teacher both come from the signed-in account, never from the question), and nothing here can change data.
 */
const trim = (v: unknown, max = 9000) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…[cut]" : s; };

const TOOLS = [
  { name: "my_classes_today", description: "The signed-in teacher's own periods today: time, class, subject, room, and which one is now or next.", parameters: { type: "object", properties: {} } },
  { name: "my_classes", description: "The classes and sections this teacher teaches, with student counts.", parameters: { type: "object", properties: {} } },
  { name: "my_students", description: "Search the students of this teacher's own classes by name or admission number.", parameters: { type: "object", properties: { search: { type: "string" } }, required: ["search"] } },
  { name: "my_notifications", description: "What needs this teacher's attention now: unread items, pending tasks, parent messages.", parameters: { type: "object", properties: {} } },
  { name: "portal_guide", description: "Every page of the Teacher portal with its address. Call it to explain where something is or to find an address for open_page_link.", parameters: { type: "object", properties: {} } },
  { name: "open_page_link", description: "Offer a button that opens a Teacher portal page, using an address from portal_guide.", parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" }, go: { type: "boolean", description: "true when the person asked to open or go to the page now; false when they only asked where it is" } }, required: ["href", "label"] } },
] as const;

async function runTool(inst: string, me: string, name: string, input: Record<string, unknown>, actions: AssistAction[], guide: string): Promise<string> {
  try {
    if (name === "my_classes_today") {
      const r = await tt.daily(inst, me);
      return trim({ date: r.date, weekday: r.weekday, periods: r.items.map((x) => ({ period: x.period, from: x.starts, to: x.ends, class: x.section, subject: x.subject, room: x.room, state: x.state, substitution: x.substitution })) });
    }
    if (name === "my_classes") {
      const r = await cl.classList(inst, me);
      return trim(r);
    }
    if (name === "my_students") {
      const r = await t.searchMyStudents(inst, me, String(input.search ?? ""));
      return trim(r.hits.map((x) => ({ name: x.title, detail: x.subtitle })));
    }
    if (name === "my_notifications") {
      const r = await t.notifications(inst, me);
      return trim(r);
    }
    if (name === "portal_guide") return guide || "No page list was sent.";
    if (name === "open_page_link") {
      const href = String(input.href ?? "");
      if (!/^\/teacher(\/[a-z0-9-]+){0,2}(\?[a-z0-9=&_-]*)?$/i.test(href) || !guide.includes(`(${href.split("?")[0]})`)) return "That address is not in the portal. Call portal_guide and use an address from it.";
      actions.push({ kind: "link", label: String(input.label ?? "Open page").slice(0, 60), href, go: input.go === true });
      return "Button added.";
    }
    return `Unknown tool '${name}'.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "the lookup failed"}`;
  }
}

export async function teacherChat(messages: ChatMessage[], page: string | undefined, guide: string, inst: string, me: string, roleLabel: string): Promise<{ reply: string; actions: AssistAction[] }> {
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);
  limit(me);
  const { data } = await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle();
  const school = (data as { name: string } | null)?.name ?? "the school";
  const system = [
    `You are MCA Assist, the assistant inside the Teacher portal of ${school}, on the My Class Assist school ERP. You are talking to ${roleLabel || "a teacher"}. You know this portal and this teacher's own timetable, classes and students.`,
    "You have read-only tools for THIS teacher's own records only. For any question about their day, classes, students or notifications, call the tools and answer from what they return. Never guess or invent a name, number or time. You have no access to school-wide data, other teachers' data, fees or payroll: if asked, say that is not available to a teacher. If nothing is recorded, say so plainly. You cannot change anything: for actions, say which page to open and what to click.",
    "When someone asks to open or go to a page (in English, Hindi or Telugu), call portal_guide if you need the address, then open_page_link with go=true, and confirm in one short line. Do not say a page is open unless you called the tool. When someone asks how to find a page, answer in one line with the bold path (for example: Open **Attendance → Daily Attendance**.), call open_page_link once with go=false, and add nothing else.",
    "Answer directly and briefly in plain language. Write **bold** around page names and menu paths, joined with arrows. Use short lines or simple lists; never markdown tables, pipes or headings, and never write HTML. Reply in the language the person wrote or spoke in (English, Hindi or Telugu); keep page names in English. Never show ids or UUIDs. Dates like 12 Oct 2026. Call tools only through the tool-calling mechanism and never write a tool call into your answer.",
    page ? `The person is currently on: ${page}` : "",
  ].filter(Boolean).join("\n\n");
  try {
    const out = await runAgent({ provider: which, model: MODEL(), system, messages: messages.slice(-12), user: { permissions: [] }, tools: TOOLS as never, run: (n, i, a) => runTool(inst, me, n, i, a, guide) });
    return { reply: tidy(out.text) || "I could not come up with an answer. Try asking in another way.", actions: out.actions };
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("Teacher assistant failed:", status, err instanceof Error ? err.message.slice(0, 300) : err);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, status === 401 || status === 403 ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server." : status === 429 ? "The AI assistant is busy right now. Try again in a minute." : "The AI assistant could not answer right now. Try again in a moment.");
  }
}
