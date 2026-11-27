import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { istDate, mySections, one, secLabel, sectionMap } from "./teacher.service";
import { progressModel, pupils, requireSection, teaching } from "./teacher-classes.service";

/** Lesson plans, chapter progress, homework, assignments and study materials: only this teacher's own work, in their own sections. */
const uid = z.string().uuid();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const mondayOf = (d: string) => addDay(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekLabel = (monday: string) => `Week ${Math.ceil(Number(monday.slice(8, 10)) / 7)}, ${MON[Number(monday.slice(5, 7)) - 1]}`;

/** The sections this teacher teaches, each with the subject they teach there. */
export async function mySubjectSections(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [sm, tt] = await Promise.all([sectionMap(inst, m.ids), teaching(inst, me)]);
  const out = new Map<string, { id: string; label: string; subject_id: string; subject: string }>();
  for (const t of tt) if (sm.has(t.section_id) && !out.has(t.section_id)) out.set(t.section_id, { id: t.section_id, label: secLabel(sm.get(t.section_id) ?? null), subject_id: t.subject_id, subject: t.subject });
  return { list: [...out.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })), by: out, sm };
}
export async function subjectIn(inst: string, me: string, sectionId: string) {
  const s = (await mySubjectSections(inst, me)).by.get(uid.parse(sectionId));
  if (!s) throw new HttpError(403, "You do not teach in that class.");
  return s;
}

/** Tells the parents of some students (a notification in the parent app's inbox). */
export async function notifyParents(inst: string, me: string, studentIds: string[], subject: string, body: string) {
  if (!studentIds.length) return 0;
  const g = (check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, relation").in("student_id", studentIds).limit(20000)) ?? []) as { student_id: string; guardian_id: string; relation: string }[];
  const pick = new Map<string, string>();
  for (const x of g) if (!pick.has(x.student_id) || x.relation === "Father") pick.set(x.student_id, x.guardian_id);
  const rows = [...pick.entries()].map(([student_id, guardian_id]) => ({ institution_id: inst, kind: "notification", guardian_id, student_id, subject: subject.slice(0, 200), body: body.slice(0, 2000), status: "Delivered", created_by: me }));
  if (rows.length) check(await supabaseAdmin.from("parent_messages").insert(rows).select("id"));
  return rows.length;
}

// ═════════════ lesson plans ═════════════
export async function lessonPlans(inst: string, me: string) {
  const [{ list, sm }, rows] = await Promise.all([mySubjectSections(inst, me), supabaseAdmin.from("lesson_plans").select("id, section_id, topic, week_of, periods, status, objectives, activities, remarks, submitted_on").eq("institution_id", inst).eq("teacher_id", me).order("week_of", { ascending: false }).limit(300)]);
  const items = ((check(rows) ?? []) as { id: string; section_id: string; topic: string; week_of: string; periods: number; status: string; objectives: string; activities: string; remarks: string; submitted_on: string | null }[]).map((r) => ({ ...r, week_label: weekLabel(r.week_of), class_label: secLabel(sm.get(r.section_id) ?? null) }));
  const monday = mondayOf(istDate());
  const m = await mySections(inst, me);
  const { chapters, grade, percent } = await progressModel(inst, me, m.ids);
  const current = new Map<string, string>();
  for (const s of list) { const ch = chapters.filter((c) => c.grade_id === grade.get(s.id) && c.subject_id === s.subject_id); current.set(s.id, (ch.find((c) => (percent.get(`${s.id}:${c.id}`) ?? 0) < 100)?.chapter) ?? ""); }
  return { items, sections: list.map((s) => ({ ...s, current_chapter: current.get(s.id) ?? "" })), weeks: Array.from({ length: 5 }, (_, i) => { const w = addDay(monday, 7 * i); return { value: w, label: weekLabel(w) }; }) };
}

export async function addLessonPlan(inst: string, me: string, input: unknown) {
  const i = z.object({ section_id: uid, week_of: iso, topic: z.string().trim().min(3, "Enter the chapter or topic.").max(200), periods: z.number().int().min(1).max(60), objectives: z.string().trim().max(2000).optional(), activities: z.string().trim().max(2000).optional() }).strict().parse(input);
  const s = await subjectIn(inst, me, i.section_id);
  const week = mondayOf(i.week_of);
  return check(await supabaseAdmin.from("lesson_plans").insert({ institution_id: inst, teacher_id: me, section_id: i.section_id, subject_id: s.subject_id, topic: i.topic, week_of: week, periods: i.periods, objectives: i.objectives ?? "", activities: i.activities ?? "", status: "Draft" }).select("id").single());
}

export async function submitLessonPlan(inst: string, me: string, id: string) {
  const r = check(await supabaseAdmin.from("lesson_plans").update({ status: "Submitted", submitted_on: istDate() }).eq("id", uid.parse(id)).eq("institution_id", inst).eq("teacher_id", me).in("status", ["Draft", "Returned"]).select("id")) as unknown[];
  if (!r.length) throw new HttpError(409, "Only a draft or a returned plan can be submitted.");
  return { ok: true };
}

export async function chapterProgress(inst: string, me: string, sectionId: string) {
  const s = await subjectIn(inst, me, sectionId);
  const m = await mySections(inst, me);
  const { chapters, grade, percent } = await progressModel(inst, me, [sectionId]);
  const ch = chapters.filter((c) => c.grade_id === grade.get(sectionId) && c.subject_id === s.subject_id);
  const items = ch.map((c, i) => { const p = percent.get(`${sectionId}:${c.id}`) ?? 0; const planned = c.periods ?? 0; return { id: c.id, no: i + 1, chapter: c.chapter, planned, taken: Math.round((planned * p) / 100), progress: p, status: p >= 100 ? "Done" : p > 0 ? "In progress" : "Not started" }; });
  const total = items.length ? Math.round(items.reduce((a, x) => a + x.progress, 0) / items.length) : null;
  const sm = await sectionMap(inst, [sectionId]);
  const kids = await pupils(inst, [sectionId]);
  return { label: secLabel(sm.get(sectionId) ?? null), subject: s.subject, students: kids.length, is_class_teacher: m.classTeacherOf.includes(sectionId), percent: total, done: items.filter((x) => x.status === "Done").length, total_chapters: items.length, current: items.find((x) => x.status !== "Done")?.chapter ?? "", items };
}

// ═════════════ homework ═════════════
type HW = { id: string; code: string; section_id: string; subject_id: string; title: string; instructions: string; given_on: string; due_on: string; status: string; max_marks: number; attachments: string[] };
const hwStatus = (s: string) => (s === "Active" ? "Published" : s);

async function myHomework(inst: string, me: string, ids?: string[]) {
  let q = supabaseAdmin.from("homework").select("id, code, section_id, subject_id, title, instructions, given_on, due_on, status, max_marks, attachments").eq("institution_id", inst).eq("given_by", me);
  if (ids) q = q.in("id", ids);
  return (check(await q.order("created_at", { ascending: false }).limit(500)) ?? []) as HW[];
}

export async function homeworkList(inst: string, me: string) {
  const [{ list, sm }, hw] = await Promise.all([mySubjectSections(inst, me), myHomework(inst, me)]);
  const subs = hw.length ? (check(await supabaseAdmin.from("hw_submissions").select("homework_id, status").eq("institution_id", inst).in("homework_id", hw.map((h) => h.id)).in("status", ["Submitted", "Late", "Checked"]).limit(50000)) ?? []) as { homework_id: string; status: string }[] : [];
  const kids = await pupils(inst, [...new Set(hw.map((h) => h.section_id))]);
  const subj = new Map(list.map((s) => [s.id, s.subject]));
  const items = hw.map((h) => { const total = kids.filter((k) => k.section_id === h.section_id).length; const n = subs.filter((s) => s.homework_id === h.id).length; return { id: h.id, code: h.code, section_id: h.section_id, class_label: secLabel(sm.get(h.section_id) ?? null), subject: subj.get(h.section_id) ?? "", title: h.title, instructions: h.instructions, given_on: h.given_on, due_on: h.due_on, max_marks: h.max_marks, attachment: h.attachments[0] ?? "", status: hwStatus(h.status), submitted_pct: h.status === "Draft" ? 0 : total ? Math.round((n / total) * 100) : 0 }; });
  return { items, sections: list.map((s) => ({ id: s.id, label: s.label, subject: s.subject })) };
}

export async function addHomework(inst: string, me: string, input: unknown) {
  const i = z.object({ section_id: uid, title: z.string().trim().min(3, "Enter the title.").max(200), instructions: z.string().trim().max(2000).optional(), given_on: iso, due_on: iso, max_marks: z.number().int().min(1).max(200).optional(), attachment_name: z.string().trim().max(150).optional(), publish: z.boolean() }).strict().parse(input);
  const s = await subjectIn(inst, me, i.section_id);
  if (i.due_on < i.given_on) throw new HttpError(400, "The due date is before the day it is given.");
  const row = check(await supabaseAdmin.from("homework").insert({ institution_id: inst, section_id: i.section_id, subject_id: s.subject_id, title: i.title, instructions: i.instructions ?? "", given_by: me, given_on: i.given_on, due_on: i.due_on, max_marks: i.max_marks ?? 10, attachments: i.attachment_name ? [i.attachment_name] : [], status: i.publish ? "Active" : "Draft" }).select("id, code").single()) as { id: string; code: string };
  return row;
}

export async function updateHomework(inst: string, me: string, id: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(3).max(200).optional(), due_on: iso.optional(), status: z.enum(["Published", "Draft", "Closed"]).optional() }).strict().parse(input);
  const [h] = await myHomework(inst, me, [uid.parse(id)]);
  if (!h) throw new HttpError(404, "Homework not found.");
  if (i.due_on && i.due_on < h.given_on) throw new HttpError(400, "The due date is before the day it was given.");
  if (i.status === "Closed" && h.due_on >= istDate() && !i.due_on) throw new HttpError(409, "Homework can be closed once its due date has passed.");
  if (i.status === "Draft" && h.status !== "Draft") throw new HttpError(409, "Published homework cannot go back to draft.");
  const patch = { ...(i.title ? { title: i.title } : {}), ...(i.due_on ? { due_on: i.due_on } : {}), ...(i.status ? { status: i.status === "Published" ? "Active" : i.status } : {}) };
  if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to change.");
  check(await supabaseAdmin.from("homework").update(patch).eq("id", id).eq("institution_id", inst).eq("given_by", me).select("id"));
  return { ok: true };
}

type SubRow = { id: string | null; homework_id: string; code: string; student_id: string; student: string; class_label: string; title: string; due_on: string; submitted_on: string | null; marks: number | null; max_marks: number; feedback: string; status: string; file_name: string };
export async function homeworkSubmissions(inst: string, me: string) {
  const hw = (await myHomework(inst, me)).filter((h) => h.status !== "Draft");
  const ids = hw.map((h) => h.id);
  const [rows, kids, sm] = await Promise.all([
    ids.length ? supabaseAdmin.from("hw_submissions").select("id, homework_id, student_id, submitted_on, marks, feedback, status, file_name").eq("institution_id", inst).in("homework_id", ids).limit(50000) : Promise.resolve({ data: [], error: null }),
    pupils(inst, [...new Set(hw.map((h) => h.section_id))]), sectionMap(inst, [...new Set(hw.map((h) => h.section_id))]),
  ]);
  const R = (check(rows as never) ?? []) as { id: string; homework_id: string; student_id: string; submitted_on: string; marks: number | null; feedback: string | null; status: string; file_name: string | null }[];
  const items: SubRow[] = [];
  for (const h of hw) {
    for (const k of kids.filter((x) => x.section_id === h.section_id)) {
      const r = R.find((x) => x.homework_id === h.id && x.student_id === k.id);
      items.push({ id: r?.id ?? null, homework_id: h.id, code: h.code, student_id: k.id, student: k.name, class_label: secLabel(sm.get(h.section_id) ?? null), title: h.title, due_on: h.due_on, submitted_on: r?.status === "Pending" ? null : r?.submitted_on ?? null, marks: r?.marks ?? null, max_marks: h.max_marks, feedback: r?.feedback ?? "", status: r ? (r.status === "Reassessment" ? "Submitted" : r.status) : "Pending", file_name: r?.file_name ?? "" });
    }
  }
  const order = (a: SubRow, b: SubRow) => (a.due_on < b.due_on ? 1 : a.due_on > b.due_on ? -1 : a.class_label.localeCompare(b.class_label, undefined, { numeric: true }) || a.student.localeCompare(b.student));
  return { pending: items.filter((x) => x.status === "Pending").sort(order), submitted: items.filter((x) => x.status === "Submitted" || x.status === "Checked").sort(order), late: items.filter((x) => x.status === "Late").sort(order) };
}

export async function checkSubmission(inst: string, me: string, input: unknown) {
  const i = z.object({ homework_id: uid, student_id: uid, marks: z.number().min(0).max(200).nullable().optional(), feedback: z.string().trim().max(500).optional() }).strict().parse(input);
  const [h] = await myHomework(inst, me, [i.homework_id]);
  if (!h) throw new HttpError(404, "Homework not found.");
  if (i.marks !== undefined && i.marks !== null && i.marks > h.max_marks) throw new HttpError(400, `Marks cannot be more than ${h.max_marks}.`);
  const r = check(await supabaseAdmin.from("hw_submissions").update({ status: "Checked", ...(i.marks !== undefined ? { marks: i.marks } : {}), ...(i.feedback !== undefined ? { feedback: i.feedback || null } : {}) }).eq("homework_id", i.homework_id).eq("student_id", i.student_id).eq("institution_id", inst).in("status", ["Submitted", "Checked", "Reassessment"]).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "That student has not handed this in.");
  return { ok: true };
}

export async function acceptLate(inst: string, me: string, input: unknown) {
  const i = z.object({ homework_id: uid, student_id: uid }).strict().parse(input);
  if (!(await myHomework(inst, me, [i.homework_id])).length) throw new HttpError(404, "Homework not found.");
  const r = check(await supabaseAdmin.from("hw_submissions").update({ status: "Submitted" }).eq("homework_id", i.homework_id).eq("student_id", i.student_id).eq("institution_id", inst).eq("status", "Late").select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "That late submission was not found.");
  return { ok: true };
}

export async function remindParent(inst: string, me: string, input: unknown) {
  const i = z.object({ homework_id: uid, student_id: uid }).strict().parse(input);
  const [h] = await myHomework(inst, me, [i.homework_id]);
  if (!h) throw new HttpError(404, "Homework not found.");
  const k = (await pupils(inst, [h.section_id])).find((x) => x.id === i.student_id);
  if (!k) throw new HttpError(404, "That student is not in this class.");
  const n = await notifyParents(inst, me, [k.id], `Homework reminder: ${h.title}`, `${k.name} has not handed in "${h.title}" (${h.code}), due ${h.due_on}.`);
  if (!n) throw new HttpError(409, "There is no parent on file for this student.");
  return { ok: true };
}

// ═════════════ assignments ═════════════
type AS = { id: string; code: string; title: string; section_id: string; subject_id: string; due_on: string; max_marks: number; status: string; instructions: string; rubric_name: string | null; assigned_on: string | null };
const ASEL = "id, code, title, section_id, subject_id, due_on, max_marks, status, instructions, rubric_name, assigned_on";
async function myAssignments(inst: string, me: string, id?: string) {
  let q = supabaseAdmin.from("assignments").select(ASEL).eq("institution_id", inst).eq("assigned_by", me);
  if (id) q = q.eq("id", id);
  return (check(await q.order("created_at", { ascending: false }).limit(300)) ?? []) as AS[];
}

export async function assignmentList(inst: string, me: string) {
  const [{ list, sm }, rows] = await Promise.all([mySubjectSections(inst, me), myAssignments(inst, me)]);
  const subs = rows.length ? (check(await supabaseAdmin.from("assignment_submissions").select("assignment_id").eq("institution_id", inst).in("assignment_id", rows.map((r) => r.id)).limit(50000)) ?? []) as { assignment_id: string }[] : [];
  const kids = await pupils(inst, [...new Set(rows.map((r) => r.section_id))]);
  const today = istDate();
  const items = rows.map((r) => { const total = kids.filter((k) => k.section_id === r.section_id).length; const n = subs.filter((s) => s.assignment_id === r.id).length; return { id: r.id, code: r.code, title: r.title, section_id: r.section_id, class_label: secLabel(sm.get(r.section_id) ?? null), assigned_on: r.assigned_on, due_on: r.due_on, max_marks: r.max_marks, submitted: n, total, status: r.status, instructions: r.instructions, rubric_name: r.rubric_name ?? "", days_left: Math.round((Date.parse(r.due_on) - Date.parse(today)) / 86400000) }; });
  return { items, sections: list.map((s) => ({ id: s.id, label: s.label, subject: s.subject })) };
}

export async function addAssignment(inst: string, me: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(3, "Enter the title.").max(200), section_id: uid, max_marks: z.number().int().min(1).max(200), due_on: iso, instructions: z.string().trim().max(2000).optional(), rubric_name: z.string().trim().max(150).optional(), assign_now: z.boolean() }).strict().parse(input);
  const s = await subjectIn(inst, me, i.section_id);
  if (i.due_on < istDate()) throw new HttpError(400, "The due date has already passed.");
  const row = check(await supabaseAdmin.from("assignments").insert({ institution_id: inst, title: i.title, section_id: i.section_id, subject_id: s.subject_id, assigned_by: me, due_on: i.due_on, max_marks: i.max_marks, instructions: i.instructions ?? "", rubric_name: i.rubric_name || null, status: i.assign_now ? "Assigned" : "Draft", assigned_on: i.assign_now ? istDate() : null }).select("id, code").single()) as { id: string; code: string };
  if (i.assign_now) await notifyParents(inst, me, (await pupils(inst, [i.section_id])).map((k) => k.id), `New assignment: ${i.title}`, `${i.title} (${row.code}) is due on ${i.due_on}. Maximum marks ${i.max_marks}.`);
  return row;
}

export async function assignNow(inst: string, me: string, id: string) {
  const [a] = await myAssignments(inst, me, uid.parse(id));
  if (!a) throw new HttpError(404, "Assignment not found.");
  if (a.status !== "Draft") throw new HttpError(409, "That assignment is already assigned.");
  if (a.due_on < istDate()) throw new HttpError(409, "Change the due date before assigning: it has passed.");
  check(await supabaseAdmin.from("assignments").update({ status: "Assigned", assigned_on: istDate() }).eq("id", id).eq("institution_id", inst).eq("assigned_by", me).select("id"));
  await notifyParents(inst, me, (await pupils(inst, [a.section_id])).map((k) => k.id), `New assignment: ${a.title}`, `${a.title} (${a.code}) is due on ${a.due_on}. Maximum marks ${a.max_marks}.`);
  return { ok: true };
}

export async function notifyAgain(inst: string, me: string, id: string) {
  const [a] = await myAssignments(inst, me, uid.parse(id));
  if (!a || a.status !== "Assigned") throw new HttpError(404, "Assignment not found.");
  const done = new Set(((check(await supabaseAdmin.from("assignment_submissions").select("student_id").eq("institution_id", inst).eq("assignment_id", id)) ?? []) as { student_id: string }[]).map((x) => x.student_id));
  const n = await notifyParents(inst, me, (await pupils(inst, [a.section_id])).map((k) => k.id).filter((s) => !done.has(s)), `Reminder: ${a.title}`, `${a.title} (${a.code}) is due on ${a.due_on}.`);
  return { notified: n };
}

export async function extendDue(inst: string, me: string, id: string, input: unknown) {
  const { days } = z.object({ days: z.number().int().min(1).max(14) }).strict().parse(input);
  const [a] = await myAssignments(inst, me, uid.parse(id));
  if (!a || a.status !== "Assigned") throw new HttpError(404, "Assignment not found.");
  const base = a.due_on < istDate() ? istDate() : a.due_on;
  check(await supabaseAdmin.from("assignments").update({ due_on: addDay(base, days) }).eq("id", id).eq("institution_id", inst).eq("assigned_by", me).select("id"));
  return { ok: true };
}

const grade = (p: number) => (p >= 91 ? "A1" : p >= 81 ? "A2" : p >= 71 ? "B1" : p >= 61 ? "B2" : p >= 51 ? "C1" : p >= 41 ? "C2" : p >= 33 ? "D" : "E");
export async function assignmentMarks(inst: string, me: string, id: string) {
  const [a] = await myAssignments(inst, me, uid.parse(id));
  if (!a || a.status === "Draft") throw new HttpError(404, "Assignment not found.");
  const [kids, subs, sm] = await Promise.all([pupils(inst, [a.section_id]), supabaseAdmin.from("assignment_submissions").select("student_id, status, marks, feedback, feedback_sent, marks_published, submitted_on").eq("institution_id", inst).eq("assignment_id", id), sectionMap(inst, [a.section_id])]);
  const S = new Map(((check(subs) ?? []) as { student_id: string; status: string; marks: number | null; feedback: string | null; feedback_sent: boolean; marks_published: boolean }[]).map((s) => [s.student_id, s]));
  const students = kids.map((k) => { const s = S.get(k.id); const p = s?.marks !== null && s?.marks !== undefined ? Math.round((Number(s.marks) / a.max_marks) * 100) : null; return { student_id: k.id, roll_no: k.roll_no, name: k.name, status: s ? s.status : "Not submitted", marks: s?.marks ?? null, percent: p, grade: p === null ? "" : grade(p), feedback: s?.feedback ?? "", feedback_sent: !!s?.feedback_sent, published: !!s?.marks_published }; });
  return { id: a.id, code: a.code, title: a.title, class_label: secLabel(sm.get(a.section_id) ?? null), students_total: kids.length, submitted: S.size, due_on: a.due_on, max_marks: a.max_marks, students, published: students.length > 0 && students.filter((s) => s.marks !== null).every((s) => s.published) && students.some((s) => s.marks !== null) };
}

export async function saveMarks(inst: string, me: string, id: string, input: unknown) {
  const i = z.object({ items: z.array(z.object({ student_id: uid, marks: z.number().min(0).max(200).nullable() }).strict()).min(1).max(500), publish: z.boolean().optional() }).strict().parse(input);
  const [a] = await myAssignments(inst, me, uid.parse(id));
  if (!a || a.status === "Draft") throw new HttpError(404, "Assignment not found.");
  const ok = new Set((await pupils(inst, [a.section_id])).map((k) => k.id));
  if (i.items.some((x) => !ok.has(x.student_id))) throw new HttpError(400, "One of the students is not in this class.");
  if (i.items.some((x) => x.marks !== null && x.marks > a.max_marks)) throw new HttpError(400, `Marks cannot be more than ${a.max_marks}.`);
  const rows = i.items.filter((x) => x.marks !== null).map((x) => ({ institution_id: inst, assignment_id: id, student_id: x.student_id, marks: x.marks, status: "Checked", ...(i.publish ? { marks_published: true } : {}) }));
  if (rows.length) check(await supabaseAdmin.from("assignment_submissions").upsert(rows, { onConflict: "assignment_id,student_id" }).select("id"));
  if (i.publish) check(await supabaseAdmin.from("assignment_submissions").update({ marks_published: true }).eq("assignment_id", id).eq("institution_id", inst).not("marks", "is", null).select("id"));
  return { saved: rows.length };
}

export async function sendFeedback(inst: string, me: string, id: string, input: unknown) {
  const i = z.object({ items: z.array(z.object({ student_id: uid, feedback: z.string().trim().min(1).max(500) }).strict()).min(1).max(500) }).strict().parse(input);
  const [a] = await myAssignments(inst, me, uid.parse(id));
  if (!a || a.status === "Draft") throw new HttpError(404, "Assignment not found.");
  const have = new Set(((check(await supabaseAdmin.from("assignment_submissions").select("student_id").eq("institution_id", inst).eq("assignment_id", id)) ?? []) as { student_id: string }[]).map((x) => x.student_id));
  const rows = i.items.filter((x) => have.has(x.student_id));
  for (const r of rows) check(await supabaseAdmin.from("assignment_submissions").update({ feedback: r.feedback, feedback_sent: true }).eq("assignment_id", id).eq("student_id", r.student_id).eq("institution_id", inst).select("id"));
  await notifyParents(inst, me, rows.map((r) => r.student_id), `Feedback: ${a.title}`, `Your child's work on "${a.title}" (${a.code}) has been marked. Open the app to see the feedback.`);
  return { sent: rows.length };
}

// ═════════════ study materials ═════════════
const KIND = { PDF: "PDFs", Document: "Notes", Video: "Videos" } as const;
type SM = { id: string; title: string; doc_type: string; section_id: string; subject_id: string; chapter: string; uploaded_on: string; size_label: string; views: number; shared: boolean; shared_on: string | null; files: string[]; url: string | null; uploaded_by: string | null };
const MSEL = "id, title, doc_type, section_id, subject_id, chapter, uploaded_on, size_label, views, shared, shared_on, files, url, uploaded_by";

export async function materials(inst: string, me: string) {
  const [{ list, sm }, rows, m] = await Promise.all([mySubjectSections(inst, me), supabaseAdmin.from("study_materials").select(MSEL).eq("institution_id", inst).eq("uploaded_by", me).order("created_at", { ascending: false }).limit(500), mySections(inst, me)]);
  const { chapters, grade } = await progressModel(inst, me, m.ids);
  return {
    items: ((check(rows) ?? []) as SM[]).map((r) => ({ id: r.id, title: r.title, type: r.doc_type, class_label: secLabel(sm.get(r.section_id) ?? null), chapter: r.chapter, uploaded_on: r.uploaded_on, size: r.size_label, views: r.views, shared: r.shared, file_name: r.files[0] ?? "", url: r.url ?? "" })),
    sections: list.map((s) => ({ id: s.id, label: s.label, subject: s.subject, chapters: chapters.filter((c) => c.grade_id === grade.get(s.id) && c.subject_id === s.subject_id).map((c) => c.chapter) })),
  };
}

const YT = /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//i;
export async function addMaterial(inst: string, me: string, input: unknown) {
  const i = z.object({ doc_type: z.enum(["PDF", "Document", "Video"]), title: z.string().trim().min(2, "Enter the title.").max(200), section_id: uid, chapter: z.string().trim().max(200).optional(), file_name: z.string().trim().max(150).optional(), size_label: z.string().trim().max(30).optional(), url: z.string().trim().max(300).regex(/^(https?:\/\/\S+)?$/i, "The link must start with https://").optional(), shared: z.boolean() }).strict().parse(input);
  const s = await subjectIn(inst, me, i.section_id);
  const f = i.file_name ?? "";
  if (i.doc_type === "PDF" && !/\.pdf$/i.test(f)) throw new HttpError(400, "Choose a PDF file.");
  if (i.doc_type === "Document" && !/\.(pptx?|docx?|xlsx?|csv|odt|ods|odp)$/i.test(f)) throw new HttpError(400, "Choose a slides, Word or spreadsheet file.");
  if (i.doc_type === "Video" && !(/\.mp4$/i.test(f) || (i.url && YT.test(i.url)))) throw new HttpError(400, "Choose an MP4 file or paste a YouTube link.");
  if (i.url && !YT.test(i.url)) throw new HttpError(400, "Paste a YouTube link, like https://youtube.com/…");
  check(await supabaseAdmin.from("study_materials").insert({ institution_id: inst, title: i.title, kind: KIND[i.doc_type], doc_type: i.doc_type, section_id: i.section_id, subject_id: s.subject_id, chapter: i.chapter ?? "", files: f ? [f] : [], size_label: i.size_label ?? (i.url ? "Link" : ""), url: i.url || null, uploaded_by: me, status: "Published", shared: i.shared, shared_on: i.shared ? istDate() : null }).select("id"));
  return { ok: true };
}

export async function setSharing(inst: string, me: string, id: string, input: unknown) {
  const { shared } = z.object({ shared: z.boolean() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("study_materials").update({ shared, shared_on: shared ? istDate() : null }).eq("id", uid.parse(id)).eq("institution_id", inst).eq("uploaded_by", me).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Material not found.");
  return { ok: true };
}

export async function sharedMaterials(inst: string, me: string) {
  const { list } = await mySubjectSections(inst, me);
  const subjects = [...new Set(list.map((s) => s.subject_id))];
  if (!subjects.length) return { items: [] };
  const rows = (check(await supabaseAdmin.from("study_materials").select(`${MSEL}, who:uploaded_by(first_name, last_name), sections:section_id(name, grades:grade_id(name))`).eq("institution_id", inst).eq("shared", true).in("subject_id", subjects).neq("uploaded_by", me).order("shared_on", { ascending: false }).limit(300)) ?? []) as unknown as (SM & { who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null; sections: { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null })[];
  return { items: rows.map((r) => { const w = one(r.who); const sec = one(r.sections); return { id: r.id, title: r.title, type: r.doc_type, class_label: `Class ${(one(sec?.grades ?? null)?.name ?? "").replace(/^(Grade|Class)\s+/i, "")}`, shared_by: w ? `${w.first_name} ${w.last_name}`.trim() : "", shared_on: r.shared_on ?? r.uploaded_on, chapter: r.chapter, size: r.size_label }; }) };
}

export async function saveShared(inst: string, me: string, id: string, input: unknown) {
  const { section_id } = z.object({ section_id: uid.optional() }).strict().parse(input);
  const src = check(await supabaseAdmin.from("study_materials").select(`${MSEL}, grade:section_id(grade_id)`).eq("id", uid.parse(id)).eq("institution_id", inst).eq("shared", true).maybeSingle()) as unknown as (SM & { grade: { grade_id: string } | { grade_id: string }[] | null }) | null;
  if (!src) throw new HttpError(404, "That material is not shared.");
  const { list } = await mySubjectSections(inst, me);
  const mine = list.filter((s) => s.subject_id === src.subject_id);
  if (!mine.length) throw new HttpError(403, "You do not teach this subject.");
  const sameGrade = await sectionGrades(inst, mine.map((s) => s.id));
  const g = one(src.grade)?.grade_id;
  const target = (section_id ? mine.find((s) => s.id === section_id) : null) ?? mine.find((s) => sameGrade.get(s.id) === g) ?? mine[0];
  check(await supabaseAdmin.from("study_materials").insert({ institution_id: inst, title: src.title, kind: KIND[src.doc_type as keyof typeof KIND] ?? "Notes", doc_type: src.doc_type, section_id: target.id, subject_id: src.subject_id, chapter: src.chapter, files: src.files, size_label: src.size_label, url: src.url, uploaded_by: me, status: "Published", shared: false }).select("id"));
  return { ok: true, class_label: target.label };
}
async function sectionGrades(inst: string, ids: string[]) {
  const r = (check(await supabaseAdmin.from("sections").select("id, grade_id").eq("institution_id", inst).in("id", ids)) ?? []) as { id: string; grade_id: string }[];
  return new Map(r.map((x) => [x.id, x.grade_id]));
}
void requireSection;
