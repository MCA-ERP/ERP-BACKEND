import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { staffList } from "./attendance2.service";
import { getAttSettings } from "./timetable.service";
import { roster } from "./student-mgmt.service";

/** Exams, papers, date sheets, seating, eligibility and hall tickets for one school. */
const uid = z.string().uuid();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM.");
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
export const STATUSES = ["Draft", "Scheduled", "Marks entry", "Results published"] as const;
const CLASSES = z.string().trim().max(40).regex(/^[0-9 ,–-]*$/, "Use numbers like 1 – 12 or 10, 12.");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEAVY = /^(english|mathematics|maths|science)$/i;

// ── classes text ──
export function classSet(text: string): Set<number> | null {
  const t = text.trim();
  if (!t) return null;
  const s = new Set<number>();
  for (const part of t.split(",")) { const m = /(\d+)\s*[–-]\s*(\d+)/.exec(part); if (m) for (let n = +m[1]; n <= +m[2]; n++) s.add(n); else if (/\d+/.test(part)) s.add(Number(/\d+/.exec(part)?.[0])); }
  return s;
}
export const gradeIn = (name: string, nums: Set<number> | null) => { const m = /(\d+)\s*$/.exec(name); return nums === null ? true : m ? nums.has(+m[1]) : false; };
const gradeNum = (name: string) => /(\d+)\s*$/.exec(name)?.[1] ?? name;

interface ExamRow { id: string; name: string; exam_type_id: string | null; classes: string; starts_on: string; ends_on: string; status: string; exam_types: { name: string; max_marks: number } | { name: string; max_marks: number }[] | null }
async function examById(inst: string, id: string) {
  const e = check(await supabaseAdmin.from("exams").select("id, name, exam_type_id, classes, starts_on, ends_on, status, exam_types:exam_type_id(name, max_marks)").eq("id", id).eq("institution_id", inst).maybeSingle()) as unknown as ExamRow | null;
  if (!e) throw new HttpError(404, "Exam not found.");
  return e;
}
export const loadExam = examById;

// ═════════════ exams ═════════════
export async function listExams(inst: string) {
  const rows = check(await supabaseAdmin.from("exams").select("id, name, exam_type_id, classes, starts_on, ends_on, status, exam_types:exam_type_id(name, max_marks)").eq("institution_id", inst).order("created_at", { ascending: false })) as unknown as ExamRow[];
  return { items: rows.map((r) => ({ id: r.id, name: r.name, exam_type_id: r.exam_type_id, type: one(r.exam_types)?.name ?? "", classes: r.classes, starts_on: r.starts_on, ends_on: r.ends_on, status: r.status })) };
}
const examBody = z.object({ name: z.string().trim().min(2, "Enter the exam.").max(100), exam_type_id: uid.nullable().optional(), classes: CLASSES.optional(), starts_on: iso, ends_on: iso, status: z.enum(STATUSES).optional() }).strict();
async function typeOk(inst: string, id: string | null | undefined) {
  if (!id) return;
  const t = check(await supabaseAdmin.from("exam_types").select("id").eq("id", id).eq("institution_id", inst).maybeSingle());
  if (!t) throw new HttpError(404, "Exam type not found.");
}
export async function addExam(inst: string, input: unknown) {
  const i = examBody.parse(input);
  if (i.ends_on < i.starts_on) throw new HttpError(400, "The exam must end on or after the day it starts.");
  await typeOk(inst, i.exam_type_id);
  const dup = check(await supabaseAdmin.from("exams").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "An exam with that name exists.");
  return check(await supabaseAdmin.from("exams").insert({ institution_id: inst, name: i.name, exam_type_id: i.exam_type_id ?? null, classes: i.classes ?? "", starts_on: i.starts_on, ends_on: i.ends_on, status: i.status ?? "Draft" }).select("id").single());
}
export async function updateExam(inst: string, id: string, input: unknown) {
  const i = examBody.parse(input);
  if (i.ends_on < i.starts_on) throw new HttpError(400, "The exam must end on or after the day it starts.");
  await examById(inst, id);
  await typeOk(inst, i.exam_type_id);
  const dup = check(await supabaseAdmin.from("exams").select("id").eq("institution_id", inst).ilike("name", i.name).neq("id", id)) as unknown[];
  if (dup.length) throw new HttpError(409, "An exam with that name exists.");
  check(await supabaseAdmin.from("exams").update({ name: i.name, exam_type_id: i.exam_type_id ?? null, classes: i.classes ?? "", starts_on: i.starts_on, ends_on: i.ends_on, ...(i.status ? { status: i.status } : {}) }).eq("id", id).select("id"));
  return { ok: true };
}

// ═════════════ papers ═════════════
export async function listPapers(inst: string, examId?: string) {
  let q = supabaseAdmin.from("exam_papers").select("id, exam_id, paper_date, starts, ends, hall, status, exams:exam_id(name), grades:grade_id(name, sort_order), subjects:subject_id(name), inv:invigilator_id(first_name, last_name)").eq("institution_id", inst);
  if (examId) q = q.eq("exam_id", examId);
  const rows = check(await q.order("paper_date", { ascending: false }).limit(3000)) as unknown as { id: string; exam_id: string; paper_date: string; starts: string; ends: string; hall: string | null; status: string; exams: { name: string } | { name: string }[] | null; grades: { name: string } | { name: string }[] | null; subjects: { name: string } | { name: string }[] | null; inv: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  return { items: rows.map((r) => { const v = one(r.inv); return { id: r.id, exam_id: r.exam_id, exam: one(r.exams)?.name ?? "", class_label: one(r.grades)?.name ?? "", subject: one(r.subjects)?.name ?? "", date: r.paper_date, starts: r.starts.slice(0, 5), ends: r.ends.slice(0, 5), hall: r.hall ?? "", invigilator: v ? `${v.first_name} ${v.last_name}`.trim() : "", status: r.status }; }).sort((a, b) => a.date.localeCompare(b.date)) };
}
export async function addPaper(inst: string, input: unknown) {
  const i = z.object({ exam_id: uid, grade_id: uid, subject_id: uid, paper_date: iso, starts: hhmm, ends: hhmm, hall: z.string().trim().max(100).optional(), invigilator_id: uid.nullable().optional() }).strict().parse(input);
  if (i.ends <= i.starts) throw new HttpError(400, "The paper must end after it starts.");
  const ex = await examById(inst, i.exam_id);
  const [g, s] = await Promise.all([supabaseAdmin.from("grades").select("id, name").eq("id", i.grade_id).eq("institution_id", inst).maybeSingle(), supabaseAdmin.from("subjects").select("id").eq("id", i.subject_id).eq("institution_id", inst).maybeSingle()]);
  const grade = check(g) as { id: string; name: string } | null;
  if (!grade || !check(s)) throw new HttpError(404, "Class or subject not found.");
  if (!gradeIn(grade.name, classSet(ex.classes))) throw new HttpError(400, "That class isn't part of this exam.");
  if (i.paper_date < ex.starts_on || i.paper_date > ex.ends_on) throw new HttpError(400, "The date is outside the exam dates.");
  const dup = check(await supabaseAdmin.from("exam_papers").select("id").eq("exam_id", i.exam_id).eq("grade_id", i.grade_id).eq("subject_id", i.subject_id)) as unknown[];
  if (dup.length) throw new HttpError(409, "That paper is already scheduled.");
  const clash = check(await supabaseAdmin.from("exam_papers").select("id").eq("exam_id", i.exam_id).eq("grade_id", i.grade_id).eq("paper_date", i.paper_date)) as unknown[];
  if (clash.length) throw new HttpError(409, "That class already has a paper that day.");
  return check(await supabaseAdmin.from("exam_papers").insert({ institution_id: inst, exam_id: i.exam_id, grade_id: i.grade_id, subject_id: i.subject_id, paper_date: i.paper_date, starts: i.starts, ends: i.ends, hall: i.hall || null, invigilator_id: i.invigilator_id ?? null }).select("id").single());
}
export async function deletePaper(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("exam_papers").delete().eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Paper not found.");
  return { ok: true };
}

// ═════════════ date sheet ═════════════
const dsBody = z.object({ exam_id: uid, classes: CLASSES, first_date: iso, gap: z.number().int().min(0).max(5), time: z.enum(["09:30-12:30", "09:30-11:30", "10:00-13:00"]), saturdays: z.boolean(), skip_events: z.boolean() }).strict();
async function sheetSubjects(inst: string, classes: string) {
  const [g, gs, sb] = await Promise.all([supabaseAdmin.from("grades").select("id, name").eq("institution_id", inst).eq("is_active", true), supabaseAdmin.from("grade_subjects").select("grade_id, subject_id, grades:grade_id!inner(institution_id)").eq("grades.institution_id", inst).limit(20000), supabaseAdmin.from("subjects").select("id, name").eq("institution_id", inst).eq("is_active", true)]);
  const nums = classSet(classes);
  const grades = (check(g) as { id: string; name: string }[]).filter((x) => gradeIn(x.name, nums));
  const ids = new Set(grades.map((x) => x.id));
  const links = (check(gs) as { grade_id: string; subject_id: string }[]).filter((x) => ids.has(x.grade_id));
  const names = new Map((check(sb) as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  const subjects = [...new Set(links.map((l) => l.subject_id))].map((id) => ({ id, name: names.get(id) ?? "" })).filter((s) => s.name).sort((a, b) => a.name.localeCompare(b.name));
  return { grades, links, subjects };
}
export async function generateSheet(inst: string, input: unknown) {
  const i = dsBody.parse(input);
  await examById(inst, i.exam_id);
  const { subjects } = await sheetSubjects(inst, i.classes);
  if (!subjects.length) throw new HttpError(409, "No subjects are linked to those classes yet.");
  const heavy = subjects.filter((s) => HEAVY.test(s.name)); const light = subjects.filter((s) => !HEAVY.test(s.name));
  const order: typeof subjects = [];
  for (let k = 0; k < Math.max(heavy.length, light.length); k++) { if (heavy[k]) order.push(heavy[k]); if (light[k]) order.push(light[k]); }
  const off = new Set<string>();
  if (i.skip_events) for (const e of (check(await supabaseAdmin.from("calendar_events").select("event_date, end_date").eq("institution_id", inst)) as { event_date: string; end_date: string | null }[])) for (let d = new Date(e.event_date + "T00:00:00Z"), z = new Date((e.end_date ?? e.event_date) + "T00:00:00Z"); d <= z; d = new Date(d.getTime() + 86400000)) off.add(d.toISOString().slice(0, 10));
  const ok = (d: Date) => d.getUTCDay() !== 0 && (i.saturdays || d.getUTCDay() !== 6) && !off.has(d.toISOString().slice(0, 10));
  const nextAllowed = (d: Date) => { let x = new Date(d.getTime()); for (let n = 0; n < 400 && !ok(x); n++) x = new Date(x.getTime() + 86400000); return x; };
  let cur = nextAllowed(new Date(i.first_date + "T00:00:00Z"));
  const rows: { date: string; day: string; subject_id: string; subject: string; main: boolean; prepare: number | null }[] = [];
  let prev: Date | null = null;
  for (const s of order) {
    rows.push({ date: cur.toISOString().slice(0, 10), day: DAYS[cur.getUTCDay()], subject_id: s.id, subject: s.name, main: HEAVY.test(s.name), prepare: prev ? Math.round((cur.getTime() - prev.getTime()) / 86400000) - 1 : null });
    prev = cur;
    let step = new Date(cur.getTime());
    for (let n = 0; n < i.gap + 1; n++) { step = nextAllowed(new Date(step.getTime() + 86400000)); }
    cur = step;
  }
  const [a, b] = i.time.split("-");
  return { time: { starts: a, ends: b }, items: rows, from: rows[0].date, to: rows[rows.length - 1].date };
}
export async function publishSheet(inst: string, input: unknown) {
  const i = dsBody.parse(input);
  const ex = await examById(inst, i.exam_id);
  const gen = await generateSheet(inst, i);
  const { grades, links } = await sheetSubjects(inst, i.classes);
  const plan = await seatingPlan(inst, { ...ex, classes: i.classes });
  const hall = plan.rooms.length ? (plan.rooms.length === 1 ? plan.rooms[0].name : `${plan.rooms[0].name} – ${plan.rooms[plan.rooms.length - 1].name}`) : null;
  const rows = [];
  for (const g of grades) for (const r of gen.items) if (links.some((l) => l.grade_id === g.id && l.subject_id === r.subject_id)) rows.push({ institution_id: inst, exam_id: i.exam_id, grade_id: g.id, subject_id: r.subject_id, paper_date: r.date, starts: gen.time.starts, ends: gen.time.ends, hall, invigilator_id: plan.invigilators(r.subject_id)[0]?.id ?? null });
  if (!rows.length) throw new HttpError(409, "Nothing to publish.");
  check(await supabaseAdmin.from("exam_papers").upsert(rows, { onConflict: "exam_id,grade_id,subject_id" }).select("id"));
  check(await supabaseAdmin.from("exams").update({ classes: i.classes, starts_on: gen.from, ends_on: gen.to, status: ex.status === "Draft" ? "Scheduled" : ex.status }).eq("id", i.exam_id).select("id"));
  return { papers: rows.length, from: gen.from, to: gen.to };
}
export async function dateSheet(inst: string, examId: string) {
  const ex = await examById(inst, examId);
  const rows = check(await supabaseAdmin.from("exam_papers").select("paper_date, starts, ends, subject_id, grade_id, subjects:subject_id(name), grades:grade_id(name)").eq("exam_id", examId).eq("institution_id", inst).order("paper_date")) as unknown as { paper_date: string; starts: string; ends: string; subject_id: string; subjects: { name: string } | { name: string }[] | null; grades: { name: string } | { name: string }[] | null }[];
  const ch = check(await supabaseAdmin.from("curriculum_chapters").select("subject_id").eq("institution_id", inst).limit(5000)) as { subject_id: string }[];
  const seen = new Map<string, { date: string; subject: string; subject_id: string }>();
  for (const r of rows) seen.set(`${r.paper_date}|${r.subject_id}`, { date: r.paper_date, subject: one(r.subjects)?.name ?? "", subject_id: r.subject_id });
  const nums = rows.map((r) => Number(gradeNum(one(r.grades)?.name ?? ""))).filter((n) => !isNaN(n));
  return {
    exam: { id: ex.id, name: ex.name, classes: ex.classes || (nums.length ? `${Math.min(...nums)} – ${Math.max(...nums)}` : "") }, time: rows[0] ? { starts: rows[0].starts.slice(0, 5), ends: rows[0].ends.slice(0, 5) } : null,
    items: [...seen.values()].sort((a, b) => a.date.localeCompare(b.date)).map((s) => { const n = ch.filter((c) => c.subject_id === s.subject_id).length; const rep = rows[0] ? (() => { const [h, m] = rows[0].starts.split(":").map(Number); const t = h * 60 + m - 30; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; })() : ""; return { date: s.date, day: DAYS[new Date(s.date + "T00:00:00Z").getUTCDay()], subject: s.subject, reporting: rep, syllabus: n ? `Chapters 1 – ${n}` : "—" }; }),
  };
}
export async function sendSheet(inst: string, input: unknown, actor?: string) {
  const { exam_id } = z.object({ exam_id: uid }).strict().parse(input);
  const ex = await examById(inst, exam_id);
  const sheet = await dateSheet(inst, exam_id);
  if (!sheet.items.length) throw new HttpError(409, "Publish a date sheet first.");
  const nums = classSet(ex.classes);
  const kids = (await roster(inst)).items.filter((r) => r.status === "Enrolled" && gradeIn(r.class_name, nums));
  const ids = new Set(kids.map((k) => k.id));
  const links = check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).limit(20000)) as { student_id: string; guardian_id: string }[];
  const seen = new Set<string>();
  const rows = links.filter((l) => ids.has(l.student_id) && !seen.has(l.guardian_id) && seen.add(l.guardian_id)).map((l) => ({ institution_id: inst, kind: "notification", guardian_id: l.guardian_id, student_id: l.student_id, subject: `${ex.name} date sheet`, body: sheet.items.map((s) => `${s.date} ${s.subject}`).join("; ").slice(0, 1900), created_by: actor ?? null }));
  for (let k = 0; k < rows.length; k += 500) check(await supabaseAdmin.from("parent_messages").insert(rows.slice(k, k + 500)).select("id"));
  return { sent: rows.length };
}

// ═════════════ seating ═════════════
interface Seat { id: string; name: string; section_id: string; label: string; roll: number }
export async function seatingPlan(inst: string, ex: { classes: string }) {
  const nums = classSet(ex.classes);
  const [ro, rooms, staff, cand] = await Promise.all([roster(inst), supabaseAdmin.from("rooms").select("id, name, capacity, status").eq("institution_id", inst), staffList(inst), supabaseAdmin.from("teacher_subjects").select("teacher_id, subject_id").eq("institution_id", inst)]);
  const kids = ro.items.filter((r) => r.status === "Enrolled" && r.section_id && gradeIn(r.class_name, nums));
  const seats: Seat[] = kids.map((k) => ({ id: k.id, name: k.name, section_id: k.section_id as string, label: `${gradeNum(k.class_name)}${k.section}`, roll: parseInt(k.roll_no) || 0 }));
  const by = new Map<string, Seat[]>();
  for (const s of seats) by.set(s.section_id, [...(by.get(s.section_id) ?? []), s]);
  const groups = [...by.values()].map((g) => g.sort((a, b) => a.roll - b.roll || a.name.localeCompare(b.name))).sort((a, b) => b.length - a.length);
  const L: Seat[] = []; const R: Seat[] = [];
  for (const g of groups) (L.length <= R.length ? L : R).push(...g);
  const rs = (check(rooms) as { id: string; name: string; capacity: number; status: string }[]).filter((r) => r.status === "Available").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const plan: { id: string; name: string; capacity: number; students: number; doors: string[]; benches: { n: number; left: Seat | null; right: Seat | null }[] }[] = [];
  let i = 0;
  for (const r of rs) {
    if (i >= Math.max(L.length, R.length)) break;
    const per = Math.max(1, Math.floor(r.capacity / 2));
    const benches = [];
    for (let k = 0; k < per && i < Math.max(L.length, R.length); k++, i++) benches.push({ n: k + 1, left: L[i] ?? null, right: R[i] ?? null });
    const inRoom = benches.flatMap((b) => [b.left, b.right]).filter((x): x is Seat => !!x);
    const doors: string[] = []; const sec = new Map<string, Seat[]>();
    for (const s of inRoom) sec.set(s.label, [...(sec.get(s.label) ?? []), s]);
    for (const [lab, list] of sec) { const rolls = list.map((x) => x.roll); doors.push(`${lab.replace(/^(\d+)/, "$1 ")}: roll ${Math.min(...rolls)}${rolls.length > 1 ? ` – ${Math.max(...rolls)}` : ""}`); }
    plan.push({ id: r.id, name: r.name, capacity: r.capacity, students: inRoom.length, doors, benches });
  }
  const teachers = new Map<string, Set<string>>();
  for (const c of (check(cand) ?? []) as { teacher_id: string; subject_id: string }[]) teachers.set(c.subject_id, new Set([...(teachers.get(c.subject_id) ?? []), c.teacher_id]));
  const invigilators = (subject: string) => { const skip = teachers.get(subject) ?? new Set<string>(); return staff.filter((t) => !skip.has(t.id)); };
  const seatOf = new Map<string, { room: string; seat: number }>();
  for (const r of plan) for (const b of r.benches) { if (b.left) seatOf.set(b.left.id, { room: r.name, seat: (b.n - 1) * 2 + 1 }); if (b.right) seatOf.set(b.right.id, { room: r.name, seat: (b.n - 1) * 2 + 2 }); }
  return { students: seats.length, sections: by.size, rooms: plan, seatOf, invigilators, unseated: Math.max(0, seats.length - plan.reduce((n, r) => n + r.students, 0)), capacity: rs.reduce((n, r) => n + r.capacity, 0) };
}
export async function seating(inst: string, examId: string, subjectId?: string) {
  const ex = await examById(inst, examId);
  const plan = await seatingPlan(inst, ex);
  const papers = check(await supabaseAdmin.from("exam_papers").select("paper_date, starts, subject_id, subjects:subject_id(name)").eq("exam_id", examId).eq("institution_id", inst).order("paper_date")) as unknown as { paper_date: string; starts: string; subject_id: string; subjects: { name: string } | { name: string }[] | null }[];
  const subs = new Map<string, { id: string; name: string; date: string; starts: string }>();
  for (const p of papers) if (!subs.has(p.subject_id)) subs.set(p.subject_id, { id: p.subject_id, name: one(p.subjects)?.name ?? "", date: p.paper_date, starts: p.starts.slice(0, 5) });
  const list = [...subs.values()];
  const cur = list.find((s) => s.id === subjectId) ?? list[0] ?? null;
  const inv = cur ? plan.invigilators(cur.id) : [];
  const rooms = plan.rooms.map((r, k) => ({ id: r.id, name: r.name, capacity: r.capacity, students: r.students, doors: r.doors, invigilators: inv.length ? (r.capacity >= 60 ? [inv[(k * 2) % inv.length], inv[(k * 2 + 1) % inv.length]] : [inv[k % inv.length]]).map((x) => x.name).filter((n, j, a) => a.indexOf(n) === j) : [], benches: r.benches.map((b) => ({ n: b.n, left: b.left ? `${b.left.label}-${String(b.left.roll).padStart(2, "0")}` : "—", right: b.right ? `${b.right.label}-${String(b.right.roll).padStart(2, "0")}` : "—" })) }));
  return { exam: { id: ex.id, name: ex.name, classes: ex.classes }, subjects: list, paper: cur, students: plan.students, sections: plan.sections, capacity: plan.capacity, unseated: plan.unseated, invigilator_count: inv.length, not_invigilating: inv.length ? [] : [], rooms };
}

// ═════════════ eligibility and hall tickets ═════════════
export async function eligibility(inst: string, examId: string) {
  const ex = await examById(inst, examId);
  const nums = classSet(ex.classes);
  const [ro, set, y] = await Promise.all([roster(inst), getAttSettings(inst), supabaseAdmin.from("academic_years").select("start_date").eq("institution_id", inst).eq("is_current", true).maybeSingle()]);
  const start = (y.data as { start_date: string } | null)?.start_date;
  const R = start ? (check(await supabaseAdmin.from("attendance_records").select("student_id, status").eq("institution_id", inst).gte("att_date", start).limit(500000)) as { student_id: string; status: string }[]) : [];
  const tot = new Map<string, { a: number; n: number }>();
  for (const r of R) { const t = tot.get(r.student_id) ?? { a: 0, n: 0 }; t.n++; if (r.status !== "A" && r.status !== "V") t.a++; tot.set(r.student_id, t); }
  return { min: set.min_exam, exam: ex.name, items: ro.items.filter((r) => r.status === "Enrolled" && gradeIn(r.class_name, nums)).map((r) => { const t = tot.get(r.id); const pct = t ? Math.round((t.a / t.n) * 100) : null; return { student_id: r.id, name: r.name, class_label: r.class_label, registration_no: r.registration_no, attendance: pct, eligible: pct === null ? null : pct >= set.min_exam }; }) };
}
export async function hallTickets(inst: string, examId: string, studentId?: string) {
  const ex = await examById(inst, examId);
  const [ro, plan, papers, school] = await Promise.all([roster(inst), seatingPlan(inst, ex), supabaseAdmin.from("exam_papers").select("grade_id, paper_date, starts, ends, grades:grade_id(name), subjects:subject_id(name)").eq("exam_id", examId).eq("institution_id", inst).order("paper_date"), supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle()]);
  const P = check(papers) as unknown as { grade_id: string; paper_date: string; starts: string; ends: string; grades: { name: string } | { name: string }[] | null; subjects: { name: string } | { name: string }[] | null }[];
  const nums = classSet(ex.classes);
  const kids = ro.items.filter((r) => r.status === "Enrolled" && gradeIn(r.class_name, nums) && (!studentId || r.id === studentId)).slice(0, 600);
  return { school: (school.data as { name: string } | null)?.name ?? "", exam: ex.name, items: kids.map((k) => { const s = plan.seatOf.get(k.id); return { student_id: k.id, name: k.name, class_label: k.class_label, roll_no: k.roll_no, hall: s ? `${s.room}, seat ${s.seat}` : "Not allotted", papers: P.filter((p) => one(p.grades)?.name === k.class_name).map((p) => ({ date: p.paper_date, subject: one(p.subjects)?.name ?? "", starts: p.starts.slice(0, 5), ends: p.ends.slice(0, 5) })) }; }) };
}
