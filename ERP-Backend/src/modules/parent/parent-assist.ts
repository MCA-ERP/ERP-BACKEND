import { supabaseAdmin } from "../../../db/client";
import { HttpError } from "../../lib/http-error";
import { scopeRule } from "../../lib/assist-scope";
import type { AssistAction } from "../admin/assist-actions";
import { runAgent } from "../admin/assist-agent";
import type { ChatMessage } from "../admin/assist.service";
import { MODEL, NOT_SET, limit, provider, tidy } from "../admin/assist.service";
import * as hm from "./parent-home.service";
import * as ln from "./parent-learning.service";
import * as fe from "./parent-fees.service";
import * as sc from "./parent-school.service";
import { family, today } from "./parent-core";

/**
 * The assistant inside the Parent portal. Every tool reads through the same functions the pages use, so it only ever sees
 * the signed-in parent's own children (the school and the account come from the signed-in session; a child is chosen by
 * first name from that family). It cannot change anything: it can only point to pages.
 */
const trim = (v: unknown, max = 8000) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…[cut]" : s; };
const child = { type: "object", properties: { child: { type: "string", description: "The child's first name. Leave out for the first child." } } } as const;
const none = { type: "object", properties: {} } as const;

/** tool name, what it returns, and the plan modules it needs (any one) */
const DATA: [string, string, string[]][] = [
  ["my_children", "The parent's children with class and class teacher.", []],
  ["attendance", "A child's attendance this year, month by month, and leave applications.", ["attendance"]],
  ["results", "A child's published exam results by test and subject.", ["exams"]],
  ["fees", "A child's fee terms, dues and receipts.", ["fees"]],
  ["homework", "A child's homework and assignments with status.", ["homework"]],
  ["timetable", "A child's weekly class timetable.", ["timetable"]],
  ["school_bus", "A child's bus route, stop, timings and today's trip.", ["transport"]],
  ["library", "Library books with a child, reservations and fines.", ["library"]],
  ["notices", "Circulars, announcements and class diary entries.", []],
  ["school_calendar", "School dates for the next 90 days.", []],
  ["notifications", "The parent's notifications.", []],
];

async function runTool(inst: string, me: string, mods: string[], name: string, input: Record<string, unknown>, actions: AssistAction[], guide: string): Promise<string> {
  try {
    if (name === "portal_guide") return guide || "No page list was sent.";
    if (name === "open_page_link") {
      const href = String(input.href ?? "");
      if (!/^\/parent(\/[a-z0-9-]+){0,2}(\?[a-z0-9=&_-]*)?$/i.test(href) || !(guide.includes(`(${href.split("?")[0]})`) || href.split("?")[0] === "/parent")) return "That address is not in the portal. Call portal_guide and use an address from it.";
      actions.push({ kind: "link", label: String(input.label ?? "Open page").slice(0, 60), href, go: input.go === true });
      return "Button added.";
    }
    const tool = DATA.find((d) => d[0] === name);
    if (!tool) return `Unknown tool '${name}'.`;
    if (tool[2].length && !tool[2].some((m) => mods.includes(m))) return "The school's plan does not include this.";
    const fam = await family(inst, me);
    const wanted = String(input.child ?? "").trim().toLowerCase();
    const kid = wanted ? fam.children.find((c) => c.first_name.toLowerCase() === wanted || c.name.toLowerCase() === wanted) : fam.children[0];
    if (name === "my_children") return trim(fam.children.map((c) => ({ name: c.name, class: c.class_label, class_teacher: c.class_teacher })));
    if (name === "school_calendar") return trim((await hm.calendar(inst, me, today(), new Date(Date.parse(today()) + 90 * 86400000).toISOString().slice(0, 10))).items.map((e) => ({ title: e.title, date: e.event_date, kind: e.kind })));
    if (name === "notifications") return trim((await hm.notifications(inst, me, mods, fam)).items.slice(0, 30).map((n) => ({ title: n.title, text: n.text, unread: n.unread })));
    if (!kid) return "That child is not linked to this parent.";
    if (name === "attendance") { const a = await ln.attendance(inst, me, kid.id); return trim({ year: a.year, months: a.months, leaves: a.leaves }); }
    if (name === "results") { const r = await ln.results(inst, kid); return trim({ tests: r.tests, subjects: r.subjects.map((s) => ({ subject: s.name, average: s.average })) }); }
    if (name === "fees") { const f = await fe.termRows(inst, kid); return trim({ terms: f.terms, outstanding: f.outstanding }); }
    if (name === "homework") { const h = await ln.homeworkData(inst, kid); return trim([...h.homework, ...h.assignments].slice(0, 40).map((x) => ({ subject: x.subject, title: x.title, due: x.due_on, status: x.status }))); }
    if (name === "timetable") return trim(await ln.timetable(inst, me, kid.id));
    if (name === "school_bus") return trim(await sc.transport(inst, me, kid.id));
    if (name === "library") return trim(await sc.libraryData(inst, kid));
    const n = await sc.notices(inst, me, kid.id);
    return trim({ notices: n.items.slice(0, 20), diary: n.diary.slice(0, 20) });
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "the lookup failed"}`;
  }
}

export async function parentChat(messages: ChatMessage[], page: string | undefined, guide: string, inst: string, me: string, mods: string[]): Promise<{ reply: string; actions: AssistAction[] }> {
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);
  limit(me);
  const { data } = await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle();
  const school = (data as { name: string } | null)?.name ?? "the school";
  const tools = [
    ...DATA.map(([name, description]) => ({ name, description, parameters: name === "my_children" || name === "school_calendar" || name === "notifications" ? none : child })),
    { name: "portal_guide", description: "Every page of the Parent portal with its address.", parameters: none },
    { name: "open_page_link", description: "Offer a button that opens a Parent portal page, using an address from portal_guide.", parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" }, go: { type: "boolean" } }, required: ["href"] } },
  ];
  const system = [
    `You are MCA Assist, the assistant inside the Parent portal of ${school}, on the My Class Assist school ERP. You are talking to a parent about their own children.`,
    "You have read-only tools for THIS parent's own children and the school notices meant for them. Call the tools and answer from what they return. Never guess or invent a name, number, date or amount. You cannot change anything: for an action (pay, apply for leave, message a teacher, book a meeting, give consent) say which page does it and offer a button.",
    "When someone asks to open or go to a page (in English, Hindi or Telugu), call portal_guide if you need the address, then open_page_link with go=true, and confirm in one short line. Do not say a page is open unless you called the tool.",
    "Answer directly and briefly in plain, friendly language. Write **bold** around page names and menu paths, joined with arrows. Use short lines or simple lists; never markdown tables, pipes or headings, and never write HTML. Reply in the language the person wrote or spoke in (English, Hindi or Telugu); keep page names in English. Never show ids or UUIDs. Money is in rupees, like ₹25,000.",
    scopeRule("Parent portal", "this parent's own children (attendance, results, fees, homework, timetable, bus, library), the school's notices and calendar, and how to use the portal", "other students or families, class ranks, staff salaries or personal details, school accounts or collections, admissions leads, other schools, the platform"),
    page ? `The person is currently on: ${page}` : "",
  ].filter(Boolean).join("\n\n");
  try {
    const out = await runAgent({ provider: which, model: MODEL(), system, messages: messages.slice(-12), user: { permissions: [] }, tools: tools as never, run: (n, i, ac) => runTool(inst, me, mods, n, i, ac, guide) });
    return { reply: tidy(out.text) || "I could not come up with an answer. Try asking in another way.", actions: out.actions };
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("Parent assistant failed:", status, err instanceof Error ? err.message.slice(0, 300) : err);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, status === 401 || status === 403 ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server." : status === 429 ? "The AI assistant is busy right now. Try again in a minute." : "The AI assistant could not answer right now. Try again in a moment.");
  }
}
