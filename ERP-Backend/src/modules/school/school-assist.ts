import { supabaseAdmin } from "../../../db/client";
import { HttpError } from "../../lib/http-error";
import type { AssistAction } from "../admin/assist-actions";
import { runAgent } from "../admin/assist-agent";
import type { ChatMessage } from "../admin/assist.service";
import { MODEL, NOT_SET, limit, provider, tidy } from "../admin/assist.service";
import * as dash from "./dashboard.service";
import * as fe2 from "./fees2.service";
import * as accSvc from "../accounts/accounts.service";
import { SCHOOL_MENU } from "./school-portal-map";
import { MENU_MODULES } from "../../lib/portal-modules";

const LABEL_KEY: Record<string, string> = { "Front Office": "front-office", "Admission Management": "admission", "Student Management": "students", "Parent Management": "parents", "Academic Management": "academics", "Attendance Management": "attendance", "Timetable Management": "timetable", "Examination Management": "examinations", "Homework & LMS": "lms", "Fee & Finance Management": "fees", "HR & Staff Management": "hr", "Payroll Management": "payroll", "Transport Management": "transport", "Library Management": "library", "Inventory Management": "inventory", Communication: "communication", "Hostel Management": "hostel", "Visitor Management": "visitors", "Health & Student Welfare": "health", "Certificates & Documents": "certificates", "Activities & Events": "activities" };
/** null means "everything" (Super Admin). Otherwise only the modules the school's current plan includes. */
export const allowed = (modules: string[] | null, key: string) => modules === null || !MENU_MODULES[key] || MENU_MODULES[key].some((m) => modules.includes(m));
/** The portal guide with every page of a module the school does not have removed, so the assistant cannot point to it. */
export function menuFor(modules: string[] | null): string {
  if (modules === null) return SCHOOL_MENU;
  const out: string[] = []; let keep = true;
  for (const line of SCHOOL_MENU.split("\n")) { if (!line.startsWith(" ")) { const key = LABEL_KEY[line.trim()]; keep = !key || allowed(modules, key); } if (keep) out.push(line); }
  return out.join("\n");
}
const TOOL_NEEDS: Record<string, string> = { students: "students", staff: "hr", classes_and_subjects: "academics", fee_summary: "fees", fees_overdue: "fees", attendance_today: "attendance", admissions_summary: "admission" };

/**
 * The assistant inside the School Admin portal. Every tool reads only the signed-in school's own records (the school id
 * comes from the signed-in account, never from the question), and nothing here can change data.
 */
const ID = /^[0-9a-f-]{36}$/i;
const trim = (v: unknown, max = 9000) => { const s = JSON.stringify(v); return s.length > max ? s.slice(0, max) + "…[cut]" : s; };

const filters = { type: "object", properties: { search: { type: "string" }, export: { type: "boolean", description: "true when the person wants a file (Excel, PDF or CSV): an export button with all the rows is added" }, export_label: { type: "string" } } };

const TOOLS = [
  { name: "school_overview", description: "Headline counts for the school: students, staff, classes and anything that needs attention.", parameters: { type: "object", properties: {} } },
  { name: "students", description: "Students of the current academic year. tab: total, active, inactive (left or transferred) or new (admitted this year). Optional class name, gender (male or female) and search text. Returns counts per class and gender, and the students.", parameters: { type: "object", properties: { ...filters.properties, tab: { type: "string", enum: ["total", "active", "inactive", "new"] }, class_name: { type: "string" }, gender: { type: "string", enum: ["male", "female"] } } } },
  { name: "staff", description: "Staff of the school (teachers, accountants, front office and so on). tab: total, teaching or non (non-teaching). Optional search text.", parameters: { type: "object", properties: { ...filters.properties, tab: { type: "string", enum: ["total", "teaching", "non"] } } } },
  { name: "classes_and_subjects", description: "Classes with their sections, student counts and class-teacher assignments, plus the subject list.", parameters: { type: "object", properties: {} } },
  { name: "recent_activity", description: "What people did in the portal recently (the school's audit trail). tab: all or changes.", parameters: { type: "object", properties: { tab: { type: "string", enum: ["all", "changes"] }, search: { type: "string" } } } },
  { name: "fee_summary", description: "Fee collection for this academic year: collected today and this month, outstanding, overdue students, collection rate, collection by payment method and outstanding by class, and income against expenditure.", parameters: { type: "object", properties: {} } },
  { name: "fees_overdue", description: "Students whose fees are overdue, with class, parent, mobile, amount due and days overdue. Use for who has not paid.", parameters: { type: "object", properties: { ...filters.properties } } },
  { name: "attendance_today", description: "Student attendance marked today and the trend this year.", parameters: { type: "object", properties: {} } },
  { name: "admissions_summary", description: "Admissions: enquiries, applications, approved and rejected counts.", parameters: { type: "object", properties: {} } },
  { name: "portal_guide", description: "Every page of the portal with its address. Call it to explain where something is or to find an address for open_page_link.", parameters: { type: "object", properties: {} } },
  { name: "open_page_link", description: "Offer a button that opens a portal page, using an address from portal_guide.", parameters: { type: "object", properties: { href: { type: "string" }, label: { type: "string" }, go: { type: "boolean", description: "true when the person asked to open or go to the page now (in any language); false when they only asked where it is" } }, required: ["href", "label"] } },
] as const;

function exportOf(label: string, name: string, head: string[], rows: (string | number | null)[][]): AssistAction {
  return { kind: "export", label: label.slice(0, 60), name, head, rows, auto: true };
}

async function runTool(inst: string, name: string, input: Record<string, unknown>, actions: AssistAction[], modules: string[] | null): Promise<string> {
  try {
    if (TOOL_NEEDS[name] && !allowed(modules, TOOL_NEEDS[name])) return "This school's plan does not include that module, so there is nothing to look up. Tell the person it is not part of their plan and suggest asking the administrator about upgrading.";
    const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
    const wantsFile = input.export === true;
    if (name === "school_overview") {
      const [o, s] = await Promise.all([dash.overview(inst), dash.staffStats(inst, {})]);
      return trim({ year: o.year?.name ?? null, students: o.students, staff: s.stats, attention: o.attention.map((a) => a.title) });
    }
    if (name === "students") {
      let grade: string | undefined;
      if (str("class_name")) {
        const { data } = await supabaseAdmin.from("grades").select("id, name").eq("institution_id", inst);
        const want = str("class_name")!.toLowerCase().replace(/\s+/g, "");
        grade = ((data ?? []) as { id: string; name: string }[]).find((g) => g.name.toLowerCase().replace(/\s+/g, "") === want || g.name.toLowerCase().replace(/\s+/g, "").endsWith(want))?.id;
        if (!grade) return "No class with that name. Call classes_and_subjects to see the class names.";
      }
      const r = await dash.studentStats(inst, { tab: str("tab"), search: str("search"), grade, gender: str("gender") });
      if (wantsFile) {
        if (!r.list.length) return "No students match, so there is nothing to export.";
        actions.push(exportOf(str("export_label") ?? "Export students", "students", ["Student", "Admission no.", "Class", "Gender", "Category", "Father", "Mobile", "Status"], r.list.map((x) => [x.name, x.registration_no, x.class_section, x.gender, x.category, x.father, x.mobile, x.status])));
        return trim({ exported_rows: r.list.length, note: "An export window opens. Tell the person how many rows it holds." });
      }
      return trim({ year: r.year?.name, counts: r.stats, by_class: r.by_class.filter((c) => c.value), matching: r.list.length, students: r.list.slice(0, 30).map((x) => ({ name: x.name, admission_no: x.registration_no, class: x.class_section, gender: x.gender, father: x.father, mobile: x.mobile, status: x.status })) });
    }
    if (name === "staff") {
      const r = await dash.staffStats(inst, { tab: str("tab"), search: str("search") });
      if (wantsFile) {
        if (!r.list.length) return "No staff match, so there is nothing to export.";
        actions.push(exportOf(str("export_label") ?? "Export staff", "staff", ["Name", "Designation", "Type", "Email", "Mobile", "Status"], r.list.map((x) => [x.name, x.designation, x.type, x.email, x.mobile, x.status])));
        return trim({ exported_rows: r.list.length, note: "An export window opens. Tell the person how many rows it holds." });
      }
      return trim({ counts: r.stats, by_role: r.by_role, staff: r.list.slice(0, 40).map((x) => ({ name: x.name, designation: x.designation, type: x.type, email: x.email, mobile: x.mobile, status: x.status })) });
    }
    if (name === "classes_and_subjects") {
      const r = await dash.academicOverview(inst);
      return trim({ year: r.year?.name, stats: r.stats, classes: r.classes.map((c) => ({ name: c.name, sections: c.sections, students: c.students, status: c.status })), subjects: r.subjects.map((s) => s.name) });
    }
    if (name === "recent_activity") {
      const r = await dash.recentActivity(inst, { tab: str("tab") === "changes" ? "changes" : "all", search: str("search") });
      return trim(r.list.slice(0, 20).map((x) => ({ when: x.time, user: x.user, action: x.action, record: x.record })));
    }
    if (name === "fee_summary") return trim(await accSvc.overview(inst));
    if (name === "fees_overdue") {
      const r = await fe2.pending(inst, "overdue");
      if (wantsFile) {
        if (!r.items.length) return "Nobody is overdue, so there is nothing to export.";
        actions.push(exportOf(str("export_label") ?? "Export overdue fees", "overdue-fees", ["Student", "Admission no.", "Class", "Parent", "Mobile", "Amount due", "Days overdue"], r.items.map((x) => [x.student, x.registration_no, x.class_label, x.father, x.mobile, x.due, x.days_overdue])));
        return trim({ exported_rows: r.items.length, note: "An export window opens. Tell the person how many rows it holds." });
      }
      return trim({ overdue_students: r.items.length, total_due: r.items.reduce((n, x) => n + x.due, 0), students: r.items.slice(0, 30).map((x) => ({ name: x.student, class: x.class_label, parent: x.father, mobile: x.mobile, due: x.due, days_overdue: x.days_overdue })) });
    }
    if (name === "attendance_today") return trim(await dash.attendanceOverview(inst));
    if (name === "admissions_summary") return trim(await dash.admissionOverview(inst));
    if (name === "portal_guide") return menuFor(modules);
    if (name === "open_page_link") {
      const href = String(input.href ?? "");
      const known = new Set([...menuFor(modules).matchAll(/\((\/school[a-z0-9\-/]*)\)/gi)].map((m) => m[1]));
      if (!known.has(href.split("?")[0])) return "That address is not in the portal. Call portal_guide and use an address from it.";
      actions.push({ kind: "link", label: String(input.label ?? "Open page").slice(0, 60), href, go: input.go === true });
      return "Button added.";
    }
    return `Unknown tool '${name}'.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "the lookup failed"}`;
  }
}

export async function schoolChat(messages: ChatMessage[], page: string | undefined, who: string, inst: string, roleLabel: string, modules: string[] | null = null): Promise<{ reply: string; actions: AssistAction[] }> {
  if (!ID.test(inst)) throw new HttpError(400, "No school is selected.");
  const which = provider();
  if (!which) throw new HttpError(503, NOT_SET);
  limit(who);
  const { data } = await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle();
  const school = (data as { name: string } | null)?.name ?? "the school";
  const system = [
    `You are MCA Assist, the assistant inside the School Admin portal of ${school}, on the My Class Assist school ERP. You are talking to ${roleLabel || "a staff member"} of this school. You know this portal and this school's data.`,
    "You have read-only tools for this school's own records: students, staff, classes, subjects, fees (collection and overdue), attendance, admissions and recent activity. For ANY question about the school's data, call the tools and answer from what they return. Never guess or invent a number, name or date. If nothing is recorded yet, say so plainly.",
    "When the person asks for a list, file, Excel, PDF or CSV, call the tool with export=true. You cannot change anything: for actions, say which page to open and what to click.",
    "When someone tells you to open or go to a page (in English, Hindi or Telugu, typed or spoken), call portal_guide if you need the address, then open_page_link with go=true, and confirm in one short line. Do not say a page is open unless you called the tool. When someone asks how to open or find a page, answer in one line with the bold path (for example: Open **Dashboard → Student Statistics**.), call open_page_link once with go=false, and add nothing else.",
    "Answer directly and briefly in plain language. Write **bold** around page names and menu paths, joined with arrows. Use short lines or simple lists; never markdown tables, pipes or headings, and never write HTML. Reply in the language the person wrote or spoke in (English, Hindi or Telugu); keep page names in English. Never show ids or UUIDs. Dates like 12 Oct 2026. Call tools only through the tool-calling mechanism and never write a tool call into your answer.",
    modules === null ? "" : `This school's plan currently includes only these parts of the portal: ${Object.keys(LABEL_KEY).filter((l) => allowed(modules, LABEL_KEY[l])).concat(["Dashboard", "My Profile", "My Work", "Reports & Analytics", "School Settings"]).join(", ")}. Anything else (for example ${Object.keys(LABEL_KEY).filter((l) => !allowed(modules, LABEL_KEY[l])).slice(0, 4).join(", ") || "nothing"}) is NOT available to this school: say it is not part of their plan, never describe it, open it or look it up.`,
    page ? `The person is currently on: ${page}` : "",
  ].filter(Boolean).join("\n\n");

  try {
    const out = await runAgent({ provider: which, model: MODEL(), system, messages: messages.slice(-12), user: { permissions: [] }, tools: TOOLS as never, run: (n, i, a) => runTool(inst, n, i, a, modules) });
    return { reply: tidy(out.text) || "I could not come up with an answer. Try asking in another way.", actions: out.actions };
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.error("School assistant failed:", status, err instanceof Error ? err.message.slice(0, 300) : err);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, status === 401 || status === 403 ? "The AI assistant's key was rejected. Ask the platform team to check the key on the server." : status === 429 ? "The AI assistant is busy right now. Try again in a minute." : "The AI assistant could not answer right now. Try again in a moment.");
  }
}
