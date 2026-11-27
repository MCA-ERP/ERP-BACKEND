import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";

/** Homework, assignments, study materials, online classes, online tests, submissions and evaluation. */
const uid = z.string().uuid();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const files = z.array(z.string().trim().min(1).max(150)).max(5).optional();
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const full = (p: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null) => { const x = one(p); return x ? `${x.first_name} ${x.last_name}`.trim() : ""; };
type Sec = { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null;
const sec = (s: Sec) => { const x = one(s); return x ? `${one(x.grades)?.name ?? ""} ${x.name}`.trim() : ""; };
const JOIN = "sections:section_id(name, grades:grade_id(name)), subjects:subject_id(name)";
const nm = (s: { name: string } | { name: string }[] | null) => one(s)?.name ?? "";

async function own(inst: string, section: string, subject: string | null, teacher?: string | null) {
  const [s, b, t] = await Promise.all([
    supabaseAdmin.from("sections").select("id").eq("id", section).eq("institution_id", inst).maybeSingle(),
    subject ? supabaseAdmin.from("subjects").select("id").eq("id", subject).eq("institution_id", inst).maybeSingle() : Promise.resolve({ data: { id: "x" }, error: null }),
    teacher ? supabaseAdmin.from("user_profiles").select("id").eq("id", teacher).eq("institution_id", inst).maybeSingle() : Promise.resolve({ data: { id: "x" }, error: null }),
  ]);
  if (!check(s)) throw new HttpError(404, "Class not found.");
  if (!check(b)) throw new HttpError(404, "Subject not found.");
  if (!check(t)) throw new HttpError(404, "Teacher not found.");
}
const gone = (rows: unknown[]) => { if (!rows.length) throw new HttpError(404, "Not found."); return { ok: true }; };

// ═════════════ homework ═════════════
type HwRow = { id: string; code: string; title: string; section_id: string; subject_id: string; given_by: string | null; given_on: string; due_on: string; submitted_pct: number | null; attachments: string[]; status: string; sections: Sec; subjects: { name: string } | { name: string }[] | null; who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null };
export async function listHomework(inst: string) {
  const [rows, subs, ro] = await Promise.all([supabaseAdmin.from("homework").select(`id, code, title, section_id, subject_id, given_by, given_on, due_on, submitted_pct, attachments, status, ${JOIN}, who:given_by(first_name, last_name)`).eq("institution_id", inst).order("given_on", { ascending: false }).order("created_at", { ascending: false }).limit(2000), supabaseAdmin.from("hw_submissions").select("homework_id, status").eq("institution_id", inst).limit(100000), roster(inst)]);
  const S = (check(subs) ?? []) as { homework_id: string; status: string }[];
  const size = new Map<string, number>(); for (const r of ro.items) if (r.section_id) size.set(r.section_id, (size.get(r.section_id) ?? 0) + 1);
  return { items: (check(rows) as unknown as HwRow[]).map((r) => { const mine = S.filter((x) => x.homework_id === r.id); const n = size.get(r.section_id) ?? 0; const done = mine.filter((x) => x.status !== "Pending").length; return { id: r.id, code: r.code, title: r.title, section_id: r.section_id, subject_id: r.subject_id, given_by_id: r.given_by, class_label: sec(r.sections), subject: nm(r.subjects), given_by: full(r.who), given_on: r.given_on, due_on: r.due_on, submitted: mine.length && n ? Math.min(100, Math.round((done / n) * 100)) : r.submitted_pct, attachments: r.attachments, status: r.status }; }) };
}
const hwBody = z.object({ section_id: uid, subject_id: uid, title: z.string().trim().min(2, "Enter the title.").max(200), given_by: uid.nullable().optional(), given_on: iso, due_on: iso, submitted_pct: z.number().int().min(0).max(100).nullable().optional(), attachments: files, status: z.enum(["Active", "Closed", "Draft"]).optional() }).strict();
export async function addHomework(inst: string, input: unknown, actor?: string) {
  const i = hwBody.parse(input);
  if (i.due_on < i.given_on) throw new HttpError(400, "The due date is before the day it was given.");
  await own(inst, i.section_id, i.subject_id, i.given_by);
  return check(await supabaseAdmin.from("homework").insert({ institution_id: inst, section_id: i.section_id, subject_id: i.subject_id, title: i.title, given_by: i.given_by ?? actor ?? null, given_on: i.given_on, due_on: i.due_on, submitted_pct: i.submitted_pct ?? null, attachments: i.attachments ?? [], status: i.status ?? "Active" }).select("id, code").single());
}
export async function updateHomework(inst: string, id: string, input: unknown) {
  const i = hwBody.parse(input);
  if (i.due_on < i.given_on) throw new HttpError(400, "The due date is before the day it was given.");
  await own(inst, i.section_id, i.subject_id, i.given_by);
  return gone(check(await supabaseAdmin.from("homework").update({ section_id: i.section_id, subject_id: i.subject_id, title: i.title, given_by: i.given_by ?? null, given_on: i.given_on, due_on: i.due_on, submitted_pct: i.submitted_pct ?? null, attachments: i.attachments ?? [], ...(i.status ? { status: i.status } : {}) }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]);
}

// ═════════════ assignments ═════════════
export async function listAssignments(inst: string) {
  const rows = check(await supabaseAdmin.from("assignments").select(`id, code, title, section_id, subject_id, assigned_by, due_on, max_marks, status, ${JOIN}, who:assigned_by(first_name, last_name)`).eq("institution_id", inst).order("created_at", { ascending: false }).limit(2000)) as unknown as { id: string; code: string; title: string; due_on: string; max_marks: number; status: string; sections: Sec; subjects: { name: string } | { name: string }[] | null; who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  return { items: rows.map((r) => ({ id: r.id, code: r.code, title: r.title, class_label: sec(r.sections), subject: nm(r.subjects), assigned_by: full(r.who), due_on: r.due_on, max_marks: r.max_marks, status: r.status })) };
}
export async function addAssignment(inst: string, input: unknown, actor?: string) {
  const i = z.object({ title: z.string().trim().min(2, "Enter the title.").max(200), section_id: uid, subject_id: uid, assigned_by: uid.nullable().optional(), due_on: iso, max_marks: z.number().int().min(1).max(200), status: z.enum(["Assigned", "Draft", "Closed"]).optional() }).strict().parse(input);
  await own(inst, i.section_id, i.subject_id, i.assigned_by);
  return check(await supabaseAdmin.from("assignments").insert({ institution_id: inst, title: i.title, section_id: i.section_id, subject_id: i.subject_id, assigned_by: i.assigned_by ?? actor ?? null, due_on: i.due_on, max_marks: i.max_marks, status: i.status ?? "Assigned" }).select("id, code").single());
}
export async function setAssignmentStatus(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Assigned", "Draft", "Closed"]) }).strict().parse(input);
  return gone(check(await supabaseAdmin.from("assignments").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]);
}

// ═════════════ study materials ═════════════
export async function listMaterials(inst: string) {
  const rows = check(await supabaseAdmin.from("study_materials").select(`id, title, kind, files, uploaded_on, views, status, ${JOIN}, who:uploaded_by(first_name, last_name)`).eq("institution_id", inst).order("uploaded_on", { ascending: false }).order("created_at", { ascending: false }).limit(2000)) as unknown as { id: string; title: string; kind: string; files: string[]; uploaded_on: string; views: number; status: string; sections: Sec; subjects: { name: string } | { name: string }[] | null; who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  return { items: rows.map((r) => ({ id: r.id, title: r.title, kind: r.kind, class_label: sec(r.sections), subject: nm(r.subjects), files: r.files, uploaded_by: full(r.who), uploaded_on: r.uploaded_on, views: r.views, status: r.status })) };
}
export async function addMaterial(inst: string, input: unknown, actor?: string) {
  const i = z.object({ title: z.string().trim().min(2, "Enter the title.").max(200), kind: z.enum(["Notes", "PDFs", "Videos", "Links"]), section_id: uid, subject_id: uid, files: files, uploaded_by: uid.nullable().optional(), uploaded_on: iso.optional() }).strict().parse(input);
  await own(inst, i.section_id, i.subject_id, i.uploaded_by);
  return check(await supabaseAdmin.from("study_materials").insert({ institution_id: inst, title: i.title, kind: i.kind, section_id: i.section_id, subject_id: i.subject_id, files: i.files ?? [], uploaded_by: i.uploaded_by ?? actor ?? null, uploaded_on: i.uploaded_on ?? today() }).select("id").single());
}
export async function setMaterialStatus(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Draft", "Published"]) }).strict().parse(input);
  return gone(check(await supabaseAdmin.from("study_materials").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]);
}

// ═════════════ online classes ═════════════
export async function listSessions(inst: string) {
  const rows = check(await supabaseAdmin.from("online_classes").select("id, name, session_date, session_time, link, attended_pct, status, sections:section_id(name, grades:grade_id(name)), who:teacher_id(first_name, last_name)").eq("institution_id", inst).order("session_date", { ascending: false }).order("session_time", { ascending: false }).limit(2000)) as unknown as { id: string; name: string; session_date: string; session_time: string; link: string; attended_pct: number | null; status: string; sections: Sec; who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  return { items: rows.map((r) => ({ id: r.id, name: r.name, class_label: sec(r.sections), teacher: full(r.who), date: r.session_date, time: r.session_time.slice(0, 5), link: r.link, attended: r.attended_pct, status: r.status })) };
}
export async function addSession(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the session.").max(200), section_id: uid, teacher_id: uid.nullable().optional(), session_date: iso, session_time: z.string().regex(/^\d{2}:\d{2}$/, "Choose a time."), link: z.string().trim().max(300).regex(/^(https:\/\/\S+)?$/i, "The link must start with https://").optional() }).strict().parse(input);
  await own(inst, i.section_id, null, i.teacher_id);
  return check(await supabaseAdmin.from("online_classes").insert({ institution_id: inst, name: i.name, section_id: i.section_id, teacher_id: i.teacher_id ?? null, session_date: i.session_date, session_time: i.session_time, link: i.link ?? "" }).select("id").single());
}
export async function setSessionStatus(inst: string, id: string, input: unknown) {
  const i = z.object({ status: z.enum(["Scheduled", "Completed", "Cancelled"]), attended: z.number().int().min(0).max(100).optional() }).strict().parse(input);
  const cur = check(await supabaseAdmin.from("online_classes").select("status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { status: string } | null;
  if (!cur) throw new HttpError(404, "Session not found.");
  if (cur.status !== "Scheduled") throw new HttpError(409, "That session is already closed.");
  check(await supabaseAdmin.from("online_classes").update({ status: i.status, ...(i.status === "Completed" && i.attended !== undefined ? { attended_pct: i.attended } : {}) }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ online tests ═════════════
export async function listTests(inst: string) {
  const rows = check(await supabaseAdmin.from("online_tests").select(`id, name, questions, minutes, attempted_pct, average_pct, status, ${JOIN}`).eq("institution_id", inst).order("created_at", { ascending: false }).limit(2000)) as unknown as { id: string; name: string; questions: number; minutes: number; attempted_pct: number | null; average_pct: number | null; status: string; sections: Sec; subjects: { name: string } | { name: string }[] | null }[];
  return { items: rows.map((r) => ({ id: r.id, name: r.name, class_label: sec(r.sections), subject: nm(r.subjects), questions: r.questions, minutes: r.minutes, attempted: r.attempted_pct, average: r.average_pct, status: r.status })) };
}
export async function addTest(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the test.").max(200), section_id: uid, subject_id: uid, questions: z.number().int().min(1).max(300), minutes: z.number().int().min(5).max(300), attempted: z.number().int().min(0).max(100).nullable().optional(), average: z.number().int().min(0).max(100).nullable().optional() }).strict().parse(input);
  await own(inst, i.section_id, i.subject_id);
  return check(await supabaseAdmin.from("online_tests").insert({ institution_id: inst, name: i.name, section_id: i.section_id, subject_id: i.subject_id, questions: i.questions, minutes: i.minutes, attempted_pct: i.attempted ?? null, average_pct: i.average ?? null }).select("id").single());
}
export async function setTestStatus(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Draft", "Open", "Closed"]) }).strict().parse(input);
  return gone(check(await supabaseAdmin.from("online_tests").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]);
}

// ═════════════ submissions and evaluation ═════════════
export async function listSubmissions(inst: string) {
  const [rows, ro] = await Promise.all([supabaseAdmin.from("hw_submissions").select("id, homework_id, student_id, submitted_on, marks, feedback, status, hw:homework_id(title)").eq("institution_id", inst).order("submitted_on", { ascending: false }).order("created_at", { ascending: false }).limit(5000), roster(inst)]);
  const k = new Map(ro.items.map((r) => [r.id, r]));
  return { students: ro.items.filter((r) => r.status === "Enrolled").map((r) => ({ id: r.id, name: r.name, class_label: r.class_label })), items: (check(rows) as unknown as { id: string; homework_id: string; student_id: string; submitted_on: string; marks: number | null; feedback: string | null; status: string; hw: { title: string } | { title: string }[] | null }[]).map((r) => ({ id: r.id, homework_id: r.homework_id, student: k.get(r.student_id)?.name ?? "", class_label: k.get(r.student_id)?.class_label ?? "", homework: one(r.hw)?.title ?? "", submitted_on: r.submitted_on, marks: r.marks, feedback: r.feedback ?? "", status: r.status })) };
}
export async function addSubmission(inst: string, input: unknown) {
  const i = z.object({ homework_id: uid, student_id: uid, submitted_on: iso.optional(), status: z.enum(["Submitted", "Pending", "Late"]).optional() }).strict().parse(input);
  const hw = check(await supabaseAdmin.from("homework").select("id, due_on, section_id").eq("id", i.homework_id).eq("institution_id", inst).maybeSingle()) as { id: string; due_on: string; section_id: string } | null;
  if (!hw) throw new HttpError(404, "Homework not found.");
  const kid = (await roster(inst)).items.find((r) => r.id === i.student_id);
  if (!kid) throw new HttpError(404, "Student not found.");
  if (kid.section_id !== hw.section_id) throw new HttpError(400, "That student isn't in this homework's class.");
  const on = i.submitted_on ?? today();
  const dup = check(await supabaseAdmin.from("hw_submissions").select("id").eq("homework_id", i.homework_id).eq("student_id", i.student_id)) as unknown[];
  if (dup.length) throw new HttpError(409, "That student already has a submission for this homework.");
  return check(await supabaseAdmin.from("hw_submissions").insert({ institution_id: inst, homework_id: i.homework_id, student_id: i.student_id, submitted_on: on, status: i.status ?? (on > hw.due_on ? "Late" : "Submitted") }).select("id").single());
}
export async function evaluate(inst: string, id: string, input: unknown) {
  const i = z.object({ marks: z.number().min(0).max(100).nullable().optional(), feedback: z.string().trim().max(500).optional(), status: z.enum(["Submitted", "Pending", "Late", "Reassessment"]).optional() }).strict().parse(input);
  if (i.marks === undefined && i.feedback === undefined && !i.status) throw new HttpError(400, "Nothing to change.");
  return gone(check(await supabaseAdmin.from("hw_submissions").update({ ...(i.marks !== undefined ? { marks: i.marks } : {}), ...(i.feedback !== undefined ? { feedback: i.feedback || null } : {}), ...(i.status ? { status: i.status } : {}) }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]);
}
