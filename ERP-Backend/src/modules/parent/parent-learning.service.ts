import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { dateSheet, hallTickets } from "../school/exam.service";
import { AREAS } from "../school/marks.service";
import { card } from "../school/results.service";
import { DOMAINS } from "../teacher/teacher-exams.service";
import { one } from "../teacher/teacher.service";
import { childOf, hhmm, today, type Child } from "./parent-core";

/** What the teachers and the exam office record about one child, read only: results, exams, syllabus, timetable,
 *  competitive preparation, attendance, homework and online learning. Nothing unpublished is shown. */
const uid = z.string().uuid("Invalid id.");
const round1 = (n: number) => Math.round(n * 10) / 10;
type Named = { name: string } | { name: string }[] | null;
type Person = { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
const who = (p: Person) => { const x = one(p); return x ? `${x.first_name} ${x.last_name}`.trim() : ""; };

async function yearStartDate(inst: string) {
  const y = check(await supabaseAdmin.from("academic_years").select("name, start_date").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { name: string; start_date: string } | null;
  const now = today(); const apr = `${Number(now.slice(0, 4)) - (now.slice(5, 7) < "04" ? 1 : 0)}-04-01`;
  return { name: y?.name ?? "", start: y?.start_date ?? apr };
}

// ═════════════ results ═════════════
/** The exams whose report cards the school has published for this child's class, oldest first. */
export async function publishedExams(inst: string, child: Child) {
  if (!child.section_id) return [];
  const runs = (check(await supabaseAdmin.from("report_card_runs").select("exam_id, published_at, exams:exam_id(name, starts_on)").eq("institution_id", inst).eq("section_id", child.section_id).eq("status", "Published")) ?? []) as unknown as { exam_id: string; published_at: string | null; exams: { name: string; starts_on: string } | { name: string; starts_on: string }[] | null }[];
  return runs.map((r) => ({ id: r.exam_id, name: one(r.exams)?.name ?? "Exam", starts_on: one(r.exams)?.starts_on ?? "", published_at: r.published_at })).sort((a, b) => a.starts_on.localeCompare(b.starts_on));
}

/** One published report card. The rank among classmates is not passed on. */
async function reportCard(inst: string, child: Child, examId: string) {
  const { rank: _rank, ...c } = await card(inst, examId, child.id);
  const term = Number(today().slice(5, 7)) >= 4 && Number(today().slice(5, 7)) <= 9 ? "Term 1" : "Term 2";
  const remarks = (check(await supabaseAdmin.from("student_report_remarks").select("term, remark").eq("student_id", child.id)) ?? []) as { term: string; remark: string }[];
  const own = remarks.find((r) => r.term === term && r.remark)?.remark ?? remarks.find((r) => r.remark)?.remark;
  return { ...c, remark: own ?? c.remark, registration_no: child.registration_no };
}

export async function results(inst: string, child: Child) {
  const exams = await publishedExams(inst, child);
  const cards = await Promise.all(exams.slice(-6).map(async (e) => ({ exam: e, card: await reportCard(inst, child, e.id) })));
  const tests = cards.filter((c) => c.card.pct !== null).map((c) => ({ id: c.exam.id, name: c.exam.name, pct: c.card.pct as number, grade: c.card.grade, out: c.card.max }));
  const names = [...new Set(cards.flatMap((c) => c.card.subjects.map((s) => s.name)))];
  const subjects = names.map((name) => {
    const marks = cards.map((c) => { const s = c.card.subjects.find((x) => x.name === name); return { exam_id: c.exam.id, marks: s?.marks ?? null, pct: s?.pct ?? null }; });
    const have = marks.filter((m) => m.pct !== null).map((m) => m.pct as number);
    const average = have.length ? Math.round(have.reduce((a, b) => a + b, 0) / have.length) : null;
    return { name, marks, average, first: have[0] ?? null, latest: have[have.length - 1] ?? null, change: have.length > 1 ? have[have.length - 1] - have[0] : null };
  });
  return { exams: exams.map((e) => ({ id: e.id, name: e.name, published_at: e.published_at })), tests, subjects, cards: cards.map((c) => ({ exam_id: c.exam.id, ...c.card, published_at: c.exam.published_at })) };
}

/** A grade letter for an average, from the bands the report cards use. */
export const gradeFor = (pct: number) => [[91, "A1"], [81, "A2"], [71, "B1"], [61, "B2"], [51, "C1"], [41, "C2"], [33, "D"]].find(([m]) => pct >= (m as number))?.[1] as string ?? "E";

export async function records(inst: string, me: string, studentId: unknown, tab: string, examId?: string) {
  const { child } = await childOf(inst, me, studentId);
  if (tab === "report-cards" || tab === "marks" || tab === "progress") {
    const r = await results(inst, child);
    return { ...r, subjects: r.subjects.map((s) => ({ ...s, grade: s.average === null ? "" : gradeFor(s.average) })) };
  }
  if (tab === "coscholastic") {
    const rows = (check(await supabaseAdmin.from("coscholastic_grades").select("area, term, grade").eq("student_id", child.id)) ?? []) as { area: string; term: string; grade: string }[];
    const terms = [...new Set(rows.map((r) => r.term))].sort();
    return { terms, items: rows.length ? AREAS.map(([area, about]) => ({ area, about, grades: Object.fromEntries(rows.filter((r) => r.area === area).map((r) => [r.term, r.grade])) })) : [] };
  }
  if (tab === "holistic") {
    const rows = (check(await supabaseAdmin.from("holistic_cards").select("term, domains, comment, updated_at").eq("institution_id", inst).eq("student_id", child.id).order("term")) ?? []) as { term: string; domains: Record<string, string>; comment: string; updated_at: string }[];
    return { domains: DOMAINS, items: rows };
  }
  if (tab === "schedule" || tab === "seat") {
    const exams = await upcomingExams(inst, child);
    const exam = exams.find((e) => e.id === examId) ?? exams[0] ?? null;
    const list = exams.map((e) => ({ id: e.id, name: e.name }));
    if (!exam) return { exams: list, exam: null, items: [] as unknown[] };
    if (tab === "schedule") {
      const [sheet, papers] = await Promise.all([dateSheet(inst, exam.id), supabaseAdmin.from("exam_papers").select("paper_date, starts, ends, subjects:subject_id(name)").eq("institution_id", inst).eq("exam_id", exam.id).eq("grade_id", child.grade_id).order("paper_date")]);
      const P = (check(papers) ?? []) as unknown as { paper_date: string; starts: string; ends: string; subjects: Named }[];
      const items = P.map((p) => { const subject = one(p.subjects)?.name ?? ""; const s = sheet.items.find((x) => x.date === p.paper_date && x.subject === subject) as { day?: string; syllabus?: string; reporting?: string } | undefined; return { date: p.paper_date, day: new Date(`${p.paper_date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" }), subject, starts: hhmm(p.starts), ends: hhmm(p.ends), max_marks: exam.max_marks, syllabus: s?.syllabus ?? "", reporting: s?.reporting ?? "" }; });
      return { exams: list, exam: { id: exam.id, name: exam.name }, items };
    }
    const t = await hallTickets(inst, exam.id, child.id);
    const mine = t.items.find((x) => x.student_id === child.id);
    return { exams: list, exam: { id: exam.id, name: exam.name }, school: t.school, items: mine ? mine.papers.map((p) => ({ ...p, hall: mine.hall })) : [], hall: mine?.hall ?? "" };
  }
  throw new HttpError(404, "Unknown page.");
}

/** Scheduled exams that include this child's class and have a date sheet, nearest first. */
async function upcomingExams(inst: string, child: Child) {
  if (!child.grade_id) return [];
  const papers = (check(await supabaseAdmin.from("exam_papers").select("exam_id, exams:exam_id(name, starts_on, ends_on, status, exam_types:exam_type_id(max_marks))").eq("institution_id", inst).eq("grade_id", child.grade_id).gte("paper_date", `${Number(today().slice(0, 4)) - 1}-01-01`).limit(1000)) ?? []) as unknown as { exam_id: string; exams: unknown }[];
  const out = new Map<string, { id: string; name: string; starts_on: string; ends_on: string; max_marks: number | null }>();
  for (const p of papers) {
    const e = one(p.exams as { name: string; starts_on: string; ends_on: string; status: string; exam_types: { max_marks: number } | { max_marks: number }[] | null } | null);
    if (e && e.status !== "Draft" && e.ends_on >= today()) out.set(p.exam_id, { id: p.exam_id, name: e.name, starts_on: e.starts_on, ends_on: e.ends_on, max_marks: one(e.exam_types)?.max_marks ?? null });
  }
  return [...out.values()].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
}

// ═════════════ syllabus, timetable, competitive ═════════════
export async function syllabus(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  if (!child.grade_id) return { subjects: [], chapters: [] };
  const [ch, done] = await Promise.all([
    supabaseAdmin.from("curriculum_chapters").select("id, chapter, periods, planned_month, status, subjects:subject_id(name)").eq("institution_id", inst).eq("grade_id", child.grade_id).limit(3000),
    child.section_id ? supabaseAdmin.from("syllabus_progress").select("chapter_id, status, progress").eq("institution_id", inst).eq("section_id", child.section_id).limit(3000) : Promise.resolve({ data: [], error: null }),
  ]);
  const D = new Map(((check(done) ?? []) as { chapter_id: string; status: string; progress: number }[]).map((d) => [d.chapter_id, d]));
  const chapters = ((check(ch) ?? []) as unknown as { id: string; chapter: string; periods: number; planned_month: string | null; status: string; subjects: Named }[]).map((c) => {
    const d = D.get(c.id);
    const status = d ? (d.status === "Done" ? "Completed" : d.status) : c.status;
    return { id: c.id, subject: one(c.subjects)?.name ?? "", chapter: c.chapter, periods: c.periods, month: c.planned_month ?? "", status, progress: status === "Completed" ? 100 : d?.progress ?? 0 };
  }).sort((a, b) => a.subject.localeCompare(b.subject) || a.chapter.localeCompare(b.chapter, undefined, { numeric: true }));
  const subjects = [...new Set(chapters.map((c) => c.subject))].map((name) => { const all = chapters.filter((c) => c.subject === name); const total = all.reduce((n, c) => n + c.periods, 0); return { name, chapters: all.length, completed: all.filter((c) => c.status === "Completed").length, pct: total ? Math.round(all.reduce((n, c) => n + (c.periods * c.progress) / 100, 0) / total * 100) : 0 }; });
  return { subjects, chapters };
}

export async function timetable(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  const empty = { published: false, periods: [] as unknown[], slots: [] as unknown[], substitutions: [] as unknown[], class_teacher: child.class_teacher };
  if (!child.section_id) return empty;
  const state = check(await supabaseAdmin.from("tt_sections").select("status").eq("institution_id", inst).eq("section_id", child.section_id).maybeSingle()) as { status: string } | null;
  if (state?.status !== "Published") return empty;
  const [periods, slots, subs] = await Promise.all([
    supabaseAdmin.from("tt_periods").select("id, label, starts, ends, kind").eq("institution_id", inst).order("starts"),
    supabaseAdmin.from("tt_slots").select("day, period_id, subjects:subject_id(name), teacher:teacher_id(first_name, last_name)").eq("institution_id", inst).eq("section_id", child.section_id).limit(200),
    supabaseAdmin.from("substitutions").select("sub_date, period_id, subjects:subject_id(name), teacher:substitute_id(first_name, last_name)").eq("institution_id", inst).eq("section_id", child.section_id).eq("sub_date", today()),
  ]);
  return {
    published: true, class_teacher: child.class_teacher,
    periods: ((check(periods) ?? []) as { id: string; label: string; starts: string; ends: string; kind: string }[]).map((p) => ({ ...p, starts: hhmm(p.starts), ends: hhmm(p.ends) })),
    slots: ((check(slots) ?? []) as unknown as { day: number; period_id: string; subjects: Named; teacher: Person }[]).map((s) => ({ day: s.day, period_id: s.period_id, subject: one(s.subjects)?.name ?? "", teacher: who(s.teacher) })),
    substitutions: ((check(subs) ?? []) as unknown as { period_id: string; subjects: Named; teacher: Person }[]).map((s) => ({ period_id: s.period_id, subject: one(s.subjects)?.name ?? "", teacher: who(s.teacher) })),
  };
}

export async function competitive(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  const [mem, res, reg] = await Promise.all([
    supabaseAdmin.from("comp_members").select("programme_id, comp_programmes:programme_id(name, exams, schedule, sessions_per_week, institution_id, mentor:mentor_id(first_name, last_name))").eq("student_id", child.id),
    supabaseAdmin.from("comp_results").select("test_id, score_pct, comp_tests:test_id(name, test_date, programme_id, institution_id)").eq("student_id", child.id).limit(500),
    supabaseAdmin.from("comp_registrations").select("id, exam, exam_date, fee, status").eq("institution_id", inst).eq("student_id", child.id).order("exam_date"),
  ]);
  type Prog = { name: string; exams: string; schedule: string; sessions_per_week: number; institution_id: string; mentor: Person };
  const programmes = ((check(mem) ?? []) as unknown as { programme_id: string; comp_programmes: Prog | Prog[] | null }[]).map((m) => ({ id: m.programme_id, p: one(m.comp_programmes) })).filter((m) => m.p?.institution_id === inst).map((m) => ({ id: m.id, name: m.p!.name, exams: m.p!.exams, schedule: m.p!.schedule || `${m.p!.sessions_per_week} sessions a week`, mentor: who(m.p!.mentor) }));
  type Test = { name: string; test_date: string; programme_id: string; institution_id: string };
  const tests = ((check(res) ?? []) as unknown as { test_id: string; score_pct: number; comp_tests: Test | Test[] | null }[]).map((r) => ({ r, t: one(r.comp_tests) })).filter((x) => x.t?.institution_id === inst).map(({ r, t }) => ({ id: r.test_id, name: t!.name, date: t!.test_date, programme: programmes.find((p) => p.id === t!.programme_id)?.name ?? "", score: Number(r.score_pct) })).sort((a, b) => b.date.localeCompare(a.date));
  return { programmes, tests, registrations: (check(reg) ?? []) as { id: string; exam: string; exam_date: string; fee: number; status: string }[] };
}

// ═════════════ attendance ═════════════
const ATT: Record<string, string> = { P: "Present", A: "Absent", L: "Late", H: "Half day", V: "On leave" };
export async function attendanceData(inst: string, child: Child) {
  const y = await yearStartDate(inst);
  const rows = (check(await supabaseAdmin.from("attendance_records").select("att_date, status").eq("institution_id", inst).eq("student_id", child.id).gte("att_date", y.start).order("att_date", { ascending: false }).limit(500)) ?? []) as { att_date: string; status: keyof typeof ATT }[];
  const tally = (list: typeof rows) => { const n = (s: string) => list.filter((r) => r.status === s).length; const came = n("P") + n("L") + n("H"); return { days: list.length, present: came, absent: n("A"), late: n("L"), leave: n("V"), pct: list.length ? round1((came / list.length) * 100) : null }; };
  const months: { key: string; label: string; pct: number | null; days: number; present: number; absent: number; late: number; leave: number; partial: boolean }[] = [];
  for (let d = new Date(`${y.start.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= today().slice(0, 7) && months.length < 14; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const key = d.toISOString().slice(0, 7);
    months.push({ key, label: d.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), ...tally(rows.filter((r) => r.att_date.startsWith(key))), partial: key === today().slice(0, 7) });
  }
  const last = [...months].reverse().find((m) => m.days > 0);
  const monthName = last ? new Date(`${last.key}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", timeZone: "UTC" }) : "";
  return { year_name: y.name, year: tally(rows), month: last ? { ...last, name: monthName } : null, months: months.filter((m) => m.days > 0), records: rows.map((r) => ({ date: r.att_date, status: ATT[r.status] })) };
}
export async function attendance(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  const [a, lv] = await Promise.all([
    attendanceData(inst, child),
    supabaseAdmin.from("student_leaves").select("id, code, leave_type, from_date, to_date, days, applied_on, status").eq("institution_id", inst).eq("student_id", child.id).order("applied_on", { ascending: false }).limit(100),
  ]);
  return { ...a, leaves: (check(lv) ?? []) as { id: string; code: string; leave_type: string; from_date: string; to_date: string; days: number; applied_on: string; status: string }[] };
}

// ═════════════ homework and assignments ═════════════
export async function homeworkData(inst: string, child: Child) {
  if (!child.section_id) return { homework: [], assignments: [] };
  const [hw, as] = await Promise.all([
    supabaseAdmin.from("homework").select("id, code, title, instructions, given_on, due_on, status, max_marks, attachments, subjects:subject_id(name), teacher:given_by(first_name, last_name)").eq("institution_id", inst).eq("section_id", child.section_id).neq("status", "Draft").order("due_on", { ascending: false }).limit(300),
    supabaseAdmin.from("assignments").select("id, code, title, instructions, assigned_on, due_on, status, max_marks, subjects:subject_id(name), teacher:assigned_by(first_name, last_name)").eq("institution_id", inst).eq("section_id", child.section_id).neq("status", "Draft").order("due_on", { ascending: false }).limit(300),
  ]);
  const H = (check(hw) ?? []) as unknown as { id: string; code: string; title: string; instructions: string; given_on: string; due_on: string; status: string; max_marks: number; attachments: string[]; subjects: Named; teacher: Person }[];
  const A = (check(as) ?? []) as unknown as { id: string; code: string; title: string; instructions: string; assigned_on: string | null; due_on: string; status: string; max_marks: number; subjects: Named; teacher: Person }[];
  const [hs, ss] = await Promise.all([
    H.length ? supabaseAdmin.from("hw_submissions").select("homework_id, status, submitted_on, marks, feedback").eq("student_id", child.id).in("homework_id", H.map((x) => x.id)) : Promise.resolve({ data: [], error: null }),
    A.length ? supabaseAdmin.from("assignment_submissions").select("assignment_id, status, submitted_on, marks, feedback, feedback_sent, marks_published").eq("student_id", child.id).in("assignment_id", A.map((x) => x.id)) : Promise.resolve({ data: [], error: null }),
  ]);
  const HS = new Map(((check(hs) ?? []) as { homework_id: string; status: string; submitted_on: string; marks: number | null; feedback: string | null }[]).map((s) => [s.homework_id, s]));
  const AS = new Map(((check(ss) ?? []) as { assignment_id: string; status: string; submitted_on: string; marks: number | null; feedback: string | null; feedback_sent: boolean; marks_published: boolean }[]).map((s) => [s.assignment_id, s]));
  const state = (due: string, closed: boolean, s?: string) => s ?? (due < today() || closed ? "Not submitted" : "Pending");
  return {
    homework: H.map((x) => { const s = HS.get(x.id); return { id: x.id, code: x.code, title: x.title, instructions: x.instructions, subject: one(x.subjects)?.name ?? "", teacher: who(x.teacher), given_on: x.given_on, due_on: x.due_on, files: x.attachments ?? [], status: state(x.due_on, x.status === "Closed", s?.status), marks: s?.marks ?? null, max_marks: x.max_marks, feedback: s?.feedback ?? "" }; }),
    assignments: A.map((x) => { const s = AS.get(x.id); return { id: x.id, code: x.code, title: x.title, instructions: x.instructions, subject: one(x.subjects)?.name ?? "", teacher: who(x.teacher), given_on: x.assigned_on ?? "", due_on: x.due_on, status: state(x.due_on, x.status === "Closed", s?.status), marks: s?.marks_published ? s.marks : null, max_marks: x.max_marks, feedback: s?.feedback_sent ? s.feedback ?? "" : "" }; }),
  };
}
export const pendingWork = (d: Awaited<ReturnType<typeof homeworkData>>) => [...d.homework, ...d.assignments].filter((x) => x.status === "Pending" || x.status === "Reassessment").length;
export async function homework(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  return homeworkData(inst, child);
}

// ═════════════ online learning ═════════════
const web = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : "");
export async function online(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  if (!child.section_id) return { classes: [], materials: [], tests: [] };
  const [cl, mat, tests] = await Promise.all([
    supabaseAdmin.from("online_classes").select("id, name, session_date, session_time, duration_min, platform, link, status, teacher:teacher_id(first_name, last_name)").eq("institution_id", inst).eq("section_id", child.section_id).order("session_date", { ascending: false }).limit(200),
    supabaseAdmin.from("study_materials").select("id, title, kind, chapter, files, url, size_label, uploaded_on, subjects:subject_id(name)").eq("institution_id", inst).eq("section_id", child.section_id).eq("status", "Published").order("uploaded_on", { ascending: false }).limit(300),
    supabaseAdmin.from("online_tests").select("id, code, name, questions, minutes, status, opens_on, subjects:subject_id(name)").eq("institution_id", inst).eq("section_id", child.section_id).neq("status", "Draft").limit(200),
  ]);
  const T = (check(tests) ?? []) as unknown as { id: string; code: string; name: string; questions: number; minutes: number; status: string; opens_on: string | null; subjects: Named }[];
  const att = (T.length ? check(await supabaseAdmin.from("online_test_attempts").select("test_id, score_pct, submitted_at").eq("student_id", child.id).in("test_id", T.map((t) => t.id))) : []) as { test_id: string; score_pct: number; submitted_at: string }[];
  const S = new Map(att.map((a) => [a.test_id, a]));
  return {
    classes: ((check(cl) ?? []) as unknown as { id: string; name: string; session_date: string; session_time: string; duration_min: number; platform: string; link: string; status: string; teacher: Person }[]).map((c) => ({ id: c.id, name: c.name, date: c.session_date, time: hhmm(c.session_time), minutes: c.duration_min, platform: c.platform, link: c.status === "Scheduled" && c.session_date >= today() ? web(c.link) : "", status: c.status, teacher: who(c.teacher) })),
    materials: ((check(mat) ?? []) as unknown as { id: string; title: string; kind: string; chapter: string; files: string[]; url: string | null; size_label: string; uploaded_on: string; subjects: Named }[]).map((m) => ({ id: m.id, title: m.title, kind: m.kind, subject: one(m.subjects)?.name ?? "", chapter: m.chapter, files: m.files ?? [], url: web(m.url), size: m.size_label, date: m.uploaded_on })),
    tests: T.map((t) => ({ id: t.id, code: t.code, name: t.name, subject: one(t.subjects)?.name ?? "", questions: t.questions, minutes: t.minutes, status: t.status, opens_on: t.opens_on ?? "", score: S.get(t.id)?.score_pct ?? null })),
  };
}
