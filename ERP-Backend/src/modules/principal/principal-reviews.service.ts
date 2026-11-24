import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "../school/student-mgmt.service";
import { setRecordStatus } from "../school/student-extra.service";
import { saveLogo } from "../school/custom.service";
import { workload as ttWorkload } from "../school/timetable2.service";
import { BANDS } from "../school/marks.service";
import { everyone } from "../school/fees2.service";
import { yearStart } from "../school/fees.service";

/**
 * The Principal's review pages for Academics, Students and Attendance. They only read what the Teacher, Admissions and
 * School Admin portals write (classes, syllabus, lesson plans, marks, behaviour records, attendance); the few actions
 * (closing a behaviour record, a notice to a parent) go through the same tables those portals read and are logged in
 * `principal_decisions`. Every function takes the school from the server session.
 */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const nameOf = (p: { first_name?: string | null; last_name?: string | null } | null) => (p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : "");
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const PRESENT = ["P", "L", "H"];
const stageOf = (n: string) => { const m = /(\d+)/.exec(n); const c = m ? Number(m[1]) : 0; return !c ? "Pre-primary" : c <= 5 ? "Primary" : c <= 8 ? "Middle" : c <= 10 ? "Secondary" : "Senior secondary"; };

async function year(inst: string) {
  const ys = check(await supabaseAdmin.from("academic_years").select("id, name, start_date, end_date, is_current").eq("institution_id", inst).order("start_date", { ascending: false })) as { id: string; name: string; start_date: string; end_date: string; is_current: boolean }[];
  return ys.find((y) => y.is_current) ?? ys[0] ?? null;
}
async function grades(inst: string) {
  return check(await supabaseAdmin.from("grades").select("id, name, sort_order, is_active").eq("institution_id", inst).eq("is_active", true).order("sort_order")) as { id: string; name: string; sort_order: number }[];
}
async function sections(inst: string, yearId: string | undefined) {
  if (!yearId) return [];
  return check(await supabaseAdmin.from("sections").select("id, name, grade_id, class_teacher_id, campus_id").eq("institution_id", inst).eq("academic_year_id", yearId)) as { id: string; name: string; grade_id: string; class_teacher_id: string | null; campus_id: string | null }[];
}
async function people(inst: string, ids: string[]) {
  const u = [...new Set(ids.filter(Boolean))];
  if (!u.length) return new Map<string, string>();
  return new Map((check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name").eq("institution_id", inst).in("id", u)) as { id: string; first_name: string; last_name: string }[]).map((p) => [p.id, nameOf(p)]));
}

// ═════════════ academics ═════════════
export async function classes(inst: string) {
  const y = await year(inst);
  const [g, s, ro, camp] = await Promise.all([grades(inst), sections(inst, y?.id), roster(inst), supabaseAdmin.from("campuses").select("id, name").eq("institution_id", inst)]);
  const C = new Map((check(camp) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const kids = ro.items.filter((r) => r.enrol_status !== "Left" && r.enrol_status !== "Transferred");
  const items = g.map((c) => { const secs = s.filter((x) => x.grade_id === c.id); const campus = [...new Set(secs.map((x) => (x.campus_id ? C.get(x.campus_id) : null)).filter(Boolean))].join(", "); return { id: c.id, name: c.name, stage: stageOf(c.name), sections: secs.length, students: kids.filter((k) => k.grade_id === c.id).length, campus: campus || "—", status: "Active" }; });
  const students = items.reduce((n, c) => n + c.students, 0);
  return { year: y?.name ?? "", items, stats: { classes: g.length, first: g[0]?.name ?? null, last: g[g.length - 1]?.name ?? null, sections: s.length, average: s.length ? Math.round(students / s.length) : 0, teachers_assigned: s.filter((x) => x.class_teacher_id).length } };
}

export async function subjects(inst: string) {
  const [sub, ch, plans] = await Promise.all([
    supabaseAdmin.from("subjects").select("id, name, is_active").eq("institution_id", inst).eq("is_active", true).order("name"),
    supabaseAdmin.from("curriculum_chapters").select("subject_id, periods, status").eq("institution_id", inst).limit(30000),
    supabaseAdmin.from("lesson_plans").select("status, week_of").eq("institution_id", inst).gte("week_of", `${today().slice(0, 7)}-01`).limit(5000),
  ]);
  const S = check(sub) as { id: string; name: string }[]; const C = check(ch) as { subject_id: string; periods: number; status: string }[]; const P = check(plans) as { status: string }[];
  const rows = S.map((s) => { const c = C.filter((x) => x.subject_id === s.id); const all = c.reduce((n, x) => n + x.periods, 0); return { id: s.id, name: s.name, chapters: c.length, pct: all ? Math.round((c.filter((x) => x.status === "Completed").reduce((n, x) => n + x.periods, 0) / all) * 100) : null }; });
  const all = C.reduce((n, x) => n + x.periods, 0);
  const decided = P.filter((x) => x.status === "Approved" || x.status === "Returned").length;
  return { subjects: rows.length, syllabus_pct: all ? Math.round((C.filter((x) => x.status === "Completed").reduce((n, x) => n + x.periods, 0) / all) * 100) : null, plans_approved_pct: P.length ? Math.round((P.filter((x) => x.status === "Approved").length / Math.max(1, decided || P.length)) * 100) : null, rows: rows.filter((r) => r.pct !== null) };
}

export async function syllabus(inst: string) {
  const r = check(await supabaseAdmin.from("curriculum_chapters").select("id, chapter, periods, objective, planned_month, status, grades:grade_id(name, sort_order), subjects:subject_id(name)").eq("institution_id", inst).limit(3000)) as unknown as { id: string; chapter: string; periods: number; objective: string | null; planned_month: string | null; status: string; grades: { name: string; sort_order: number } | { name: string; sort_order: number }[] | null; subjects: { name: string } | { name: string }[] | null }[];
  const items = r.map((x) => ({ id: x.id, class_label: one(x.grades)?.name ?? "", order: one(x.grades)?.sort_order ?? 0, subject: one(x.subjects)?.name ?? "", chapter: x.chapter, periods: x.periods, objective: x.objective ?? "", month: x.planned_month ?? "", status: x.status })).sort((a, b) => a.order - b.order || a.subject.localeCompare(b.subject));
  const by = new Map<string, number>(); for (const i of items) by.set(i.subject, (by.get(i.subject) ?? 0) + 1);
  return { items, by_subject: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })) };
}

export async function subjectsByClass(inst: string) {
  const [g, gs] = await Promise.all([
    grades(inst),
    supabaseAdmin.from("grade_subjects").select("grade_id, is_mandatory, subjects:subject_id!inner(name, institution_id)").eq("subjects.institution_id", inst).limit(8000),
  ]);
  const rows = check(gs) as unknown as { grade_id: string; is_mandatory: boolean; subjects: { name: string } | { name: string }[] | null }[];
  const items = g.map((c) => ({ id: c.id, name: c.name, stage: stageOf(c.name), subjects: rows.filter((r) => r.grade_id === c.id).map((r) => ({ name: one(r.subjects)?.name ?? "", type: r.is_mandatory ? "Compulsory" : "Optional" })).sort((a, b) => a.name.localeCompare(b.name)) }));
  const stages = [...new Set(items.map((i) => i.stage))].map((st) => { const cls = items.filter((i) => i.stage === st); return { stage: st, classes: cls.map((c) => c.name), subjects: [...new Set(cls.flatMap((c) => c.subjects.map((s) => s.name)))] }; });
  return { items, stages };
}

export async function teacherWorkload(inst: string) {
  const w = await ttWorkload(inst);
  return { limit: w.limit, items: w.items };
}

export async function lessonPlans(inst: string) {
  const r = check(await supabaseAdmin.from("lesson_plans").select("id, topic, week_of, periods, progress, status, teacher_id, subjects:subject_id(name), sections:section_id(name, grades:grade_id(name))").eq("institution_id", inst).order("week_of", { ascending: false }).limit(300)) as unknown as { id: string; topic: string; week_of: string; periods: number; progress: number; status: string; teacher_id: string; subjects: { name: string } | { name: string }[] | null; sections: { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null }[];
  const T = await people(inst, r.map((x) => x.teacher_id));
  return { items: r.map((x) => { const sec = one(x.sections); return { id: x.id, teacher: T.get(x.teacher_id) ?? "", class_label: `${one(sec?.grades ?? null)?.name ?? ""} ${sec?.name ?? ""}`.trim(), subject: one(x.subjects)?.name ?? "", topic: x.topic, week_of: x.week_of, periods: x.periods, progress: x.progress, status: x.status }; }) };
}

// ═════════════ academic review: marks by class and by subject ═════════════
const gradeOf = (p: number) => (BANDS["CBSE 8-point (A1 – E)"].find((b) => p >= b.min) ?? { grade: "E" }).grade;
async function pickExam(inst: string, examId?: string) {
  const ex = check(await supabaseAdmin.from("exams").select("id, name, ends_on, exam_types:exam_type_id(max_marks)").eq("institution_id", inst).order("ends_on", { ascending: false }).limit(30)) as unknown as { id: string; name: string; exam_types: { max_marks: number } | { max_marks: number }[] | null }[];
  const list = ex.map((e) => ({ id: e.id, name: e.name, max: one(e.exam_types)?.max_marks ?? 100 }));
  if (examId) return { list, exam: list.find((e) => e.id === examId) ?? null };
  for (const e of list) { const c = await supabaseAdmin.from("exam_marks").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("exam_id", e.id).not("marks", "is", null); if ((c.count ?? 0) > 0) return { list, exam: e }; }
  return { list, exam: null };
}
type Mark = { student_id: string; subject_id: string; marks: number };
async function marksOf(inst: string, examId: string, studentIds: string[]) {
  if (!studentIds.length) return [] as Mark[];
  return check(await supabaseAdmin.from("exam_marks").select("student_id, subject_id, marks").eq("institution_id", inst).eq("exam_id", examId).eq("component", "Theory").eq("absent", false).not("marks", "is", null).in("student_id", studentIds).limit(60000)) as unknown as Mark[];
}

export async function classPerformance(inst: string, sectionId?: string, examId?: string) {
  const y = await year(inst);
  const [g, s, ro, pick] = await Promise.all([grades(inst), sections(inst, y?.id), roster(inst), pickExam(inst, examId)]);
  const secs = s.map((x) => ({ id: x.id, label: `${g.find((c) => c.id === x.grade_id)?.name ?? ""} ${x.name}`.trim(), order: g.find((c) => c.id === x.grade_id)?.sort_order ?? 0 })).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const sec = secs.find((x) => x.id === sectionId) ?? secs.find((x) => ro.items.some((r) => r.section_id === x.id)) ?? secs[0] ?? null;
  const kids = sec ? ro.items.filter((r) => r.section_id === sec.id && r.enrol_status !== "Left" && r.enrol_status !== "Transferred") : [];
  const marks = pick.exam ? await marksOf(inst, pick.exam.id, kids.map((k) => k.id)) : [];
  const rows = kids.map((k) => { const m = marks.filter((x) => x.student_id === k.id); const total = m.reduce((n, x) => n + Number(x.marks), 0); const of = m.length * (pick.exam?.max ?? 100); return { roll: k.roll_no, student: k.name, total, of, pct: of ? Math.round((total / of) * 100) : null, grade: of ? gradeOf(Math.round((total / of) * 100)) : "—", subjects: m.length }; }).filter((r) => r.pct !== null);
  return { sections: secs.map((x) => ({ id: x.id, label: x.label })), section: sec ? { id: sec.id, label: sec.label } : null, exams: pick.list.map((e) => ({ id: e.id, name: e.name })), exam: pick.exam ? { id: pick.exam.id, name: pick.exam.name } : null, rows };
}

export async function subjectPerformance(inst: string, gradeId?: string, examId?: string) {
  const y = await year(inst);
  const [g, ro, pick, sub] = await Promise.all([grades(inst), roster(inst), pickExam(inst, examId), supabaseAdmin.from("subjects").select("id, name").eq("institution_id", inst)]);
  const S = new Map((check(sub) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const cls = g.find((c) => c.id === gradeId) ?? g.find((c) => ro.items.some((r) => r.grade_id === c.id)) ?? g[0] ?? null;
  const kids = cls ? ro.items.filter((r) => r.grade_id === cls.id && r.enrol_status !== "Left" && r.enrol_status !== "Transferred") : [];
  const max = pick.exam?.max ?? 100;
  const marks = pick.exam ? await marksOf(inst, pick.exam.id, kids.map((k) => k.id)) : [];
  const bySub = new Map<string, { sum: number; n: number }>();
  for (const m of marks) { const a = bySub.get(m.subject_id) ?? { sum: 0, n: 0 }; a.sum += (Number(m.marks) / max) * 100; a.n++; bySub.set(m.subject_id, a); }
  const per = kids.map((k) => { const m = marks.filter((x) => x.student_id === k.id); return { avg: m.length ? (m.reduce((n, x) => n + (Number(x.marks) / max) * 100, 0) / m.length) : null, failed: m.filter((x) => (Number(x.marks) / max) * 100 < 33).length }; }).filter((x) => x.avg !== null) as { avg: number; failed: number }[];
  const dist = new Map<string, number>(); for (const p of per) dist.set(gradeOf(Math.round(p.avg)), (dist.get(gradeOf(Math.round(p.avg))) ?? 0) + 1);
  void y;
  return {
    classes: g.map((c) => ({ id: c.id, name: c.name })), class: cls ? { id: cls.id, name: cls.name } : null, exams: pick.list.map((e) => ({ id: e.id, name: e.name })), exam: pick.exam ? { id: pick.exam.id, name: pick.exam.name } : null,
    tiles: per.length ? { pass_rate: pct(per.filter((p) => p.failed === 0).length, per.length), below_33: per.filter((p) => p.failed > 0).length, average: Math.round((per.reduce((n, p) => n + p.avg, 0) / per.length) * 10) / 10, toppers: per.filter((p) => p.avg > 95).length } : null,
    by_subject: [...bySub.entries()].map(([id, a]) => ({ label: S.get(id) ?? "", pct: Math.round(a.sum / a.n) })).sort((a, b) => a.label.localeCompare(b.label)),
    distribution: BANDS["CBSE 8-point (A1 – E)"].map((b) => ({ label: b.grade, count: dist.get(b.grade) ?? 0 })),
  };
}

// ═════════════ students ═════════════
export async function sectionWise(inst: string) {
  const y = await year(inst);
  const [g, s, ro, rooms, T] = await Promise.all([grades(inst), sections(inst, y?.id), roster(inst), supabaseAdmin.from("rooms").select("name, section_id").eq("institution_id", inst), Promise.resolve(null)]);
  void T;
  const R = new Map((check(rooms) as { name: string; section_id: string | null }[]).filter((r) => r.section_id).map((r) => [r.section_id as string, r.name]));
  const names = await people(inst, s.map((x) => x.class_teacher_id ?? ""));
  const items = s.map((x) => { const c = g.find((k) => k.id === x.grade_id); return { id: x.id, label: `${c?.name ?? ""} ${x.name}`.trim(), order: c?.sort_order ?? 0, teacher: x.class_teacher_id ? names.get(x.class_teacher_id) ?? "" : "", room: R.get(x.id) ?? "", students: ro.items.filter((r) => r.section_id === x.id && r.enrol_status !== "Left" && r.enrol_status !== "Transferred").length, status: "Active" }; }).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return { items };
}

const BEHAVIOUR: Record<string, string> = { behaviour: "Behaviour record", disciplinary: "Disciplinary action", remark: "Remark" };
export async function behaviour(inst: string, tab: string) {
  const t = z.enum(["incidents", "actions", "followup"]).parse(tab);
  const kinds = t === "actions" ? ["disciplinary"] : ["behaviour", "disciplinary", "remark"];
  const [rows, ro] = await Promise.all([
    supabaseAdmin.from("stu_records").select("id, student_id, kind, title, extra, record_date, status, created_by").eq("institution_id", inst).in("kind", kinds).order("record_date", { ascending: false }).limit(500),
    roster(inst),
  ]);
  const R = check(rows) as { id: string; student_id: string; kind: string; title: string; extra: string | null; record_date: string; status: string; created_by: string | null }[];
  const by = new Map(ro.items.map((r) => [r.id, r])); const P = await people(inst, R.map((x) => x.created_by ?? ""));
  const items = R.filter((x) => t !== "followup" || x.status !== "Closed").map((x) => ({ id: x.id, student: by.get(x.student_id)?.name ?? "", class_label: by.get(x.student_id)?.class_label ?? "", type: BEHAVIOUR[x.kind] ?? x.kind, details: x.title, note: x.extra ?? "", by: x.created_by ? P.get(x.created_by) ?? "" : "", date: x.record_date, status: x.status }));
  return { items };
}
export async function closeBehaviour(inst: string, profile: string, id: string) {
  const r = check(await supabaseAdmin.from("stu_records").select("id, title, kind, status").eq("id", id).eq("institution_id", inst).in("kind", ["behaviour", "disciplinary", "remark"]).maybeSingle()) as { id: string; title: string; kind: string; status: string } | null;
  if (!r) throw new HttpError(404, "Record not found.");
  if (r.status === "Closed") throw new HttpError(409, "That record is already closed.");
  await setRecordStatus(inst, id, { status: "Closed" });
  await log(inst, profile, "discipline", id, r.title, "closed");
  return { ok: true };
}
async function log(inst: string, profile: string, kind: string, ref: string, title: string, action: string) {
  const who = check(await supabaseAdmin.from("user_profiles").select("first_name, last_name").eq("id", profile).eq("institution_id", inst).maybeSingle()) as { first_name: string; last_name: string } | null;
  check(await supabaseAdmin.from("principal_decisions").insert({ institution_id: inst, kind, ref_id: ref, title: title.slice(0, 200), action, decided_by: profile, decided_name: nameOf(who) }).select("id"));
}

// ═════════════ student attendance: monthly and defaulters ═════════════
interface Rec { student_id: string; att_date: string; status: string }
async function yearRecords(inst: string) {
  const y = await year(inst);
  if (!y) return { y, rec: [] as Rec[] };
  const rec = check(await supabaseAdmin.from("attendance_records").select("student_id, att_date, status").eq("institution_id", inst).gte("att_date", y.start_date).lte("att_date", today()).limit(300000)) as Rec[];
  return { y, rec };
}
export async function monthlyAttendance(inst: string) {
  const { y, rec } = await yearRecords(inst);
  const by = new Map<string, { p: number; t: number; days: Set<string> }>();
  for (const r of rec) { if (r.status === "V") continue; const k = r.att_date.slice(0, 7); const x = by.get(k) ?? { p: 0, t: 0, days: new Set<string>() }; x.t++; if (PRESENT.includes(r.status)) x.p++; x.days.add(r.att_date); by.set(k, x); }
  const now = today().slice(0, 7);
  return { year: y?.name ?? "", months: [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, x]) => ({ key: k, label: new Date(k + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), pct: pct(x.p, x.t), days: x.days.size, current: k === now })) };
}
export async function defaulters(inst: string) {
  const [{ rec }, ro] = await Promise.all([yearRecords(inst), roster(inst)]);
  const by = new Map<string, { p: number; t: number; a: number }>();
  for (const r of rec) { if (r.status === "V") continue; const x = by.get(r.student_id) ?? { p: 0, t: 0, a: 0 }; x.t++; if (PRESENT.includes(r.status)) x.p++; if (r.status === "A") x.a++; by.set(r.student_id, x); }
  const low = [...by.entries()].map(([id, x]) => ({ id, pct: pct(x.p, x.t), absent: x.a })).filter((x) => x.pct < 88).sort((a, b) => a.pct - b.pct);
  const K = new Map(ro.items.map((r) => [r.id, r]));
  const ids = low.map((x) => x.id).filter((id) => K.has(id)).slice(0, 300);
  const g = ids.length ? (check(await supabaseAdmin.from("student_guardians").select("student_id, relation, guardians:guardian_id!inner(institution_id, full_name, phone)").eq("guardians.institution_id", inst).in("student_id", ids)) as unknown as { student_id: string; relation: string; guardians: { full_name: string; phone: string } | { full_name: string; phone: string }[] | null }[]) : [];
  const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const calls = await supabaseAdmin.from("principal_decisions").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("kind", "parent-call").gte("decided_at", week);
  return {
    tiles: { below_88: low.filter((x) => K.has(x.id)).length, below_75: low.filter((x) => x.pct < 75 && K.has(x.id)).length, calls_this_week: calls.count ?? 0 },
    items: ids.map((id) => { const x = low.find((l) => l.id === id)!; const k = K.get(id)!; const kin = g.filter((q) => q.student_id === id); const f = kin.find((q) => q.relation === "Father") ?? kin[0]; const p = one(f?.guardians ?? null); return { id, student: k.name, class_label: k.class_label, pct: x.pct, absent: x.absent, parent: p?.full_name ?? "", mobile: p?.phone ?? "" }; }),
  };
}
/** The Principal calls or sends a notice to a parent: the call is only logged, the notice goes to the parent's app. */
export async function parentContact(inst: string, profile: string, studentId: string, input: unknown) {
  const { how } = z.object({ how: z.enum(["call", "notice"]) }).strict().parse(input);
  const s = check(await supabaseAdmin.from("students").select("id, first_name, last_name").eq("id", studentId).eq("institution_id", inst).maybeSingle()) as { id: string; first_name: string; last_name: string } | null;
  if (!s) throw new HttpError(404, "Student not found.");
  if (how === "notice") {
    const g = check(await supabaseAdmin.from("student_guardians").select("guardian_id, relation, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).eq("student_id", studentId)) as unknown as { guardian_id: string; relation: string }[];
    const p = g.find((x) => x.relation === "Father") ?? g[0];
    if (!p) throw new HttpError(409, "This child has no parent linked to send a notice to.");
    check(await supabaseAdmin.from("parent_messages").insert({ institution_id: inst, kind: "notification", guardian_id: p.guardian_id, student_id: studentId, subject: "Attendance notice", body: `${nameOf(s)}'s attendance is below the school's requirement. Please make sure ${s.first_name} attends regularly or meet the class teacher.`, created_by: profile }).select("id"));
  }
  await log(inst, profile, how === "call" ? "parent-call" : "parent-notice", studentId, `${how === "call" ? "Called" : "Notice sent to"} the parent of ${nameOf(s)}`, how);
  return { ok: true };
}

// ═════════════ staff attendance ═════════════
async function staff(inst: string) {
  const [p, h] = await Promise.all([
    supabaseAdmin.from("user_profiles").select("id, first_name, last_name, roles:role_id!inner(name)").eq("institution_id", inst).not("roles.name", "in", "(Parent,Student,Applicant)").limit(5000),
    supabaseAdmin.from("hr_staff").select("profile_id, department").eq("institution_id", inst).limit(5000),
  ]);
  const D = new Map((check(h) as { profile_id: string; department: string }[]).map((x) => [x.profile_id, x.department]));
  return (check(p) as { id: string; first_name: string; last_name: string }[]).map((x) => ({ id: x.id, name: nameOf(x), department: D.get(x.id) || "Unassigned" }));
}
export async function staffDaily(inst: string) {
  const [S, att] = await Promise.all([staff(inst), supabaseAdmin.from("staff_attendance").select("staff_id, status").eq("institution_id", inst).eq("att_date", today()).limit(5000)]);
  const A = new Map((check(att) as { staff_id: string; status: string }[]).map((x) => [x.staff_id, x.status]));
  const dep = new Map<string, { present: number; total: number }>();
  for (const s of S) { const d = dep.get(s.department) ?? { present: 0, total: 0 }; d.total++; if (PRESENT.includes(A.get(s.id) ?? "")) d.present++; dep.set(s.department, d); }
  return { recorded: A.size > 0, items: [...dep.entries()].map(([label, d]) => ({ label, ...d })).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)) };
}
export async function staffMonthly(inst: string) {
  const now = today(); const from = now.slice(0, 7) + "-01";
  const [S, att, hr] = await Promise.all([staff(inst), supabaseAdmin.from("staff_attendance").select("staff_id, att_date, status").eq("institution_id", inst).gte("att_date", from).lte("att_date", now).limit(100000), supabaseAdmin.from("hr_staff").select("profile_id, emp_code").eq("institution_id", inst).limit(5000)]);
  const E = new Map((check(hr) as { profile_id: string; emp_code: string }[]).map((x) => [x.profile_id, x.emp_code]));
  const R = check(att) as { staff_id: string; att_date: string; status: string }[];
  const label = new Date(from + "T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  return { label, items: S.map((s) => { const r = R.filter((x) => x.staff_id === s.id); return { id: s.id, name: s.name, code: E.get(s.id) ?? "", department: s.department, present: r.filter((x) => PRESENT.includes(x.status)).length, leave: r.filter((x) => x.status === "V").length, absent: r.filter((x) => x.status === "A").length, late: r.filter((x) => x.status === "L").length }; }).filter((x) => x.present + x.leave + x.absent + x.late > 0).sort((a, b) => a.name.localeCompare(b.name)) };
}
/** Staff who were late, absent without approved leave, or forgot to punch out in the last 7 days, with how often it happened this month. */
export async function staffExceptions(inst: string) {
  const now = today(); const week = new Date(Date.now() - 6 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); const month = now.slice(0, 7) + "-01";
  const from = week < month ? week : month;
  const [S, att, lv] = await Promise.all([staff(inst), supabaseAdmin.from("staff_attendance").select("staff_id, att_date, status, in_time, out_time").eq("institution_id", inst).gte("att_date", from).lte("att_date", now).limit(100000), supabaseAdmin.from("leave_requests").select("profile_id, from_date, to_date").eq("institution_id", inst).eq("status", "Approved").lte("from_date", now).gte("to_date", from).limit(5000)]);
  const K = new Map(S.map((s) => [s.id, s])); const L = check(lv) as { profile_id: string; from_date: string; to_date: string }[];
  type Ex = { staff_id: string; date: string; kind: string };
  const ex: Ex[] = [];
  for (const x of check(att) as { staff_id: string; att_date: string; status: string; in_time: string | null; out_time: string | null }[]) {
    if (!K.has(x.staff_id)) continue;
    if (x.status === "A" && !L.some((l) => l.profile_id === x.staff_id && l.from_date <= x.att_date && l.to_date >= x.att_date)) ex.push({ staff_id: x.staff_id, date: x.att_date, kind: "Absent" });
    else if (x.status === "L") ex.push({ staff_id: x.staff_id, date: x.att_date, kind: "Late" });
    else if (PRESENT.includes(x.status) && x.in_time && !x.out_time && x.att_date < now) ex.push({ staff_id: x.staff_id, date: x.att_date, kind: "No punch-out" });
  }
  const keys = new Map<string, Ex[]>(); for (const e of ex) { const k = e.staff_id + "|" + e.kind; keys.set(k, [...(keys.get(k) ?? []), e]); }
  const items = [...keys.values()].filter((l) => l.some((e) => e.date >= week)).map((l) => { const last = l.map((e) => e.date).sort().pop() as string; const s = K.get(l[0].staff_id)!; return { id: l[0].staff_id + "|" + l[0].kind, staff_id: s.id, staff: s.name, department: s.department, kind: l[0].kind, times: l.filter((e) => e.date >= month).length, last }; }).sort((a, b) => b.last.localeCompare(a.last) || a.staff.localeCompare(b.staff));
  return { items };
}
/** Asks a staff member for the reason: it becomes a request in their Help Desk waiting on them, so it shows in their own portal. */
export async function askReason(inst: string, profile: string, input: unknown) {
  const i = z.object({ staff_id: z.string().uuid(), kind: z.enum(["Absent", "Late", "No punch-out"]), date: z.string().regex(/^d{4}-d{2}-d{2}$/) }).strict().parse(input);
  const s = (await staff(inst)).find((x) => x.id === i.staff_id);
  if (!s) throw new HttpError(404, "Staff member not found.");
  const who = check(await supabaseAdmin.from("user_profiles").select("first_name, last_name").eq("id", profile).eq("institution_id", inst).maybeSingle()) as { first_name: string; last_name: string } | null;
  const day = new Date(i.date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  check(await supabaseAdmin.from("hd_tickets").insert({ institution_id: inst, subject: `Please explain: ${i.kind.toLowerCase()} on ${day}`, category: "Attendance", raised_by_name: nameOf(who) || "Principal", raised_by_kind: "Staff", priority: "Normal", assigned_name: s.name, status: "Waiting on you", created_by: i.staff_id, details: `The Principal has asked for the reason for your attendance exception on ${day}.` }).select("id"));
  await log(inst, profile, "ask-reason", i.staff_id, `Asked ${s.name} for the reason (${i.kind}, ${day})`, "asked");
  return { ok: true };
}

/** Every application of the year, for the Principal's Admission Review. */
export async function applications(inst: string) {
  const r = check(await supabaseAdmin.from("adm_applications").select("id, code, child, class_sought, parent_name, mobile, source, applied_on, status, level").eq("institution_id", inst).order("applied_on", { ascending: false }).limit(2000)) as { id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; source: string; applied_on: string; status: string; level: number }[];
  return { items: r.map((a) => ({ ...a, status: a.status === "Under review" ? "Under review" : a.status })) };
}

/** Staff leave that was approved or rejected, newest first (the pending ones are decided in the leave approval chain). */
export async function decidedLeave(inst: string, status: string) {
  const st = z.enum(["Approved", "Rejected"]).parse(status);
  const r = check(await supabaseAdmin.from("leave_requests").select("id, code, profile_id, leave_type, from_date, days, created_at").eq("institution_id", inst).eq("status", st).order("created_at", { ascending: false }).limit(500)) as { id: string; code: string; profile_id: string; leave_type: string; from_date: string; days: number; created_at: string }[];
  const S = new Map((await staff(inst)).map((s) => [s.id, s]));
  return { items: r.filter((x) => S.has(x.profile_id)).map((x) => ({ id: x.id, code: x.code, staff: S.get(x.profile_id)!.name, department: S.get(x.profile_id)!.department, leave_type: `${x.leave_type} leave`, from: x.from_date, days: Number(x.days), applied: x.created_at.slice(0, 10), status: st })) };
}

// ═════════════ school reports for the board: academic, attendance, finance, class by class ═════════════
export async function schoolReport(inst: string, kind: string, gradeId?: string) {
  const k = z.enum(["academic", "attendance", "finance"]).parse(kind);
  const [g, ro] = await Promise.all([grades(inst), roster(inst)]);
  const classes = g.map((c) => ({ id: c.id, name: c.name }));
  const scope = g.filter((c) => !gradeId || c.id === gradeId);
  const kids = (id: string) => ro.items.filter((r) => r.grade_id === id && r.enrol_status !== "Left" && r.enrol_status !== "Transferred");
  const gradeOf2 = new Map(ro.items.map((r) => [r.id, r.grade_id]));
  const y = await year(inst);
  if (k === "academic") {
    const [pick, sec, ch, sub, att] = await Promise.all([pickExam(inst), sections(inst, y?.id), supabaseAdmin.from("curriculum_chapters").select("grade_id, periods, status").eq("institution_id", inst).limit(30000), supabaseAdmin.from("subjects").select("id, name").eq("institution_id", inst), yearRecords(inst)]);
    const S = new Map((check(sub) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
    const marks = pick.exam ? await marksOf(inst, pick.exam.id, ro.items.map((r) => r.id)) : [];
    const max = pick.exam?.max ?? 100; const C = check(ch) as { grade_id: string; periods: number; status: string }[];
    const rows = scope.map((c) => {
      const ids = new Set(kids(c.id).map((x) => x.id)); const m = marks.filter((x) => ids.has(x.student_id));
      const per = [...ids].map((id) => { const l = m.filter((x) => x.student_id === id); return l.length ? { avg: l.reduce((n, x) => n + (Number(x.marks) / max) * 100, 0) / l.length, failed: l.some((x) => (Number(x.marks) / max) * 100 < 33) } : null; }).filter(Boolean) as { avg: number; failed: boolean }[];
      const bySub = new Map<string, { s: number; n: number }>(); for (const x of m) { const a = bySub.get(x.subject_id) ?? { s: 0, n: 0 }; a.s += (Number(x.marks) / max) * 100; a.n++; bySub.set(x.subject_id, a); }
      const ranked = [...bySub.entries()].map(([id, a]) => ({ name: S.get(id) ?? "", avg: a.s / a.n })).sort((a, b) => b.avg - a.avg);
      const cc = C.filter((x) => x.grade_id === c.id); const all = cc.reduce((n, x) => n + x.periods, 0);
      return { id: c.id, class_label: c.name, students: ids.size, sections: sec.filter((x) => x.grade_id === c.id).length, average: per.length ? Math.round((per.reduce((n, p) => n + p.avg, 0) / per.length) * 10) / 10 : null, pass_rate: per.length ? pct(per.filter((p) => !p.failed).length, per.length) : null, syllabus: all ? Math.round((cc.filter((x) => x.status === "Completed").reduce((n, x) => n + x.periods, 0) / all) * 100) : null, strongest: ranked[0]?.name ?? "", weakest: ranked.length > 1 ? ranked[ranked.length - 1].name : "" };
    });
    const withMarks = rows.filter((r) => r.average !== null);
    const scoped = att.rec.filter((r) => r.status !== "V" && (!gradeId || gradeOf2.get(r.student_id) === gradeId));
    const allSyl = C.filter((x) => !gradeId || x.grade_id === gradeId); const sp = allSyl.reduce((n, x) => n + x.periods, 0);
    return { kind: k, classes, exam: pick.exam?.name ?? "", tiles: { pass_rate: withMarks.length ? Math.round((withMarks.reduce((n, r) => n + (r.pass_rate ?? 0), 0) / withMarks.length) * 10) / 10 : null, average: withMarks.length ? Math.round((withMarks.reduce((n, r) => n + (r.average ?? 0), 0) / withMarks.length) * 10) / 10 : null, syllabus: sp ? Math.round((allSyl.filter((x) => x.status === "Completed").reduce((n, x) => n + x.periods, 0) / sp) * 100) : null, attendance: scoped.length ? pct(scoped.filter((r) => PRESENT.includes(r.status)).length, scoped.length) : null }, rows, year: y?.name ?? "" };
  }
  if (k === "attendance") {
    const { rec } = await yearRecords(inst); const now = today();
    const rows = scope.map((c) => {
      const mine = rec.filter((r) => r.status !== "V" && gradeOf2.get(r.student_id) === c.id);
      const day = mine.filter((r) => r.att_date === now); const per = new Map<string, { p: number; t: number }>();
      for (const r of mine) { const a = per.get(r.student_id) ?? { p: 0, t: 0 }; a.t++; if (PRESENT.includes(r.status)) a.p++; per.set(r.student_id, a); }
      const yr = mine.length ? pct(mine.filter((r) => PRESENT.includes(r.status)).length, mine.length) : null;
      return { id: c.id, class_label: c.name, students: kids(c.id).length, today: day.length ? pct(day.filter((r) => PRESENT.includes(r.status)).length, day.length) : null, year: yr, below_75: [...per.values()].filter((a) => pct(a.p, a.t) < 75).length, status: yr === null ? "—" : yr >= 92 ? "On track" : "Warning" };
    });
    const months = new Map<string, { p: number; t: number }>(); for (const r of rec) { if (r.status === "V" || (gradeId && gradeOf2.get(r.student_id) !== gradeId)) continue; const m = r.att_date.slice(0, 7); const a = months.get(m) ?? { p: 0, t: 0 }; a.t++; if (PRESENT.includes(r.status)) a.p++; months.set(m, a); }
    return { kind: k, classes, year: y?.name ?? "", months: [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, a]) => ({ key, label: new Date(key + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), pct: pct(a.p, a.t), current: key === today().slice(0, 7) })), rows };
  }
  const ev = await everyone(inst);
  const rows = scope.map((c) => {
    const mine = ev.detail.filter((d) => gradeOf2.get(d.student_id) === c.id);
    const billed = mine.reduce((n, d) => n + d.terms.reduce((m, t) => m + t.amount, 0), 0); const out = mine.reduce((n, d) => n + d.terms.reduce((m, t) => m + t.due, 0), 0);
    return { id: c.id, class_label: c.name, students: kids(c.id).length, per_student: mine.length ? Math.round(billed / mine.length) : 0, billed, collected: billed - out, outstanding: out, pct: billed ? Math.round(((billed - out) / billed) * 100) : null, defaulters: ev.rows.filter((r) => gradeOf2.get(r.student_id) === c.id && r.days_overdue > 30).length };
  });
  const billed = rows.reduce((n, r) => n + r.billed, 0); const out = rows.reduce((n, r) => n + r.outstanding, 0);
  return { kind: k, classes, year: y?.name ?? "", tiles: { billed, collected: billed - out, pct: billed ? Math.round(((billed - out) / billed) * 100) : null, outstanding: out, defaulters: rows.reduce((n, r) => n + r.defaulters, 0) }, rows };
}

// ═════════════ parent concerns: complaints, and the help desk ═════════════
export async function complaints(inst: string) {
  const r = check(await supabaseAdmin.from("parent_feedback").select("id, code, kind, about, comment, rating, raised_on, status, guardians:guardian_id(full_name), students:student_id(first_name, last_name)").eq("institution_id", inst).eq("kind", "complaint").order("raised_on", { ascending: false }).limit(500)) as unknown as { id: string; code: string; about: string; comment: string | null; rating: number | null; raised_on: string; status: string; guardians: { full_name: string } | { full_name: string }[] | null; students: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  return { items: r.map((x) => ({ id: x.id, code: x.code, parent: one(x.guardians)?.full_name ?? "", student: nameOf(one(x.students)), about: x.about, comment: x.comment ?? "", rating: x.rating, date: x.raised_on, status: x.status })) };
}
export async function helpDesk(inst: string) {
  const [t, cat] = await Promise.all([
    supabaseAdmin.from("hd_tickets").select("id, code, subject, category, raised_by_name, raised_by_kind, priority, assigned_name, status, rating, first_reply_at, resolved_at, created_at").eq("institution_id", inst).order("created_at", { ascending: false }).limit(1000),
    supabaseAdmin.from("hd_categories").select("name, reply_hours").eq("institution_id", inst),
  ]);
  const H = new Map((check(cat) as { name: string; reply_hours: number }[]).map((c) => [c.name, c.reply_hours]));
  const T = check(t) as { id: string; code: string; subject: string; category: string; raised_by_name: string; raised_by_kind: string; priority: string; assigned_name: string | null; status: string; rating: number | null; first_reply_at: string | null; resolved_at: string | null; created_at: string }[];
  const now = Date.now(); const month = today().slice(0, 7);
  const view = (x: (typeof T)[number]) => { const left = (H.get(x.category) ?? 24) - Math.floor((now - Date.parse(x.created_at)) / 3_600_000); return { id: x.id, code: x.code, subject: x.subject, category: x.category, by: x.raised_by_name, by_kind: x.raised_by_kind, with: x.assigned_name ?? "", priority: x.priority, status: x.status, hours_left: left }; };
  const open = T.filter((x) => x.status !== "Resolved");
  const urgent = open.map(view).filter((x) => x.priority === "High" || x.hours_left < 0);
  const thisMonth = T.filter((x) => x.created_at.slice(0, 7) === month && (x.first_reply_at || x.resolved_at));
  const ok = thisMonth.filter((x) => { const done = Date.parse((x.first_reply_at ?? x.resolved_at) as string); return (done - Date.parse(x.created_at)) / 3_600_000 <= (H.get(x.category) ?? 24); }).length;
  const rated = T.filter((x) => x.rating !== null);
  return { tiles: { open: open.length, urgent: urgent.length, within: thisMonth.length ? Math.round((ok / thisMonth.length) * 100) : null, satisfaction: rated.length ? Math.round((rated.reduce((n, x) => n + (x.rating ?? 0), 0) / rated.length) * 10) / 10 : null }, items: urgent.sort((a, b) => a.hours_left - b.hours_left) };
}
/** "Ask for update": the ticket goes to High priority so its team sees it first, and the request is logged. */
export async function askUpdate(inst: string, profile: string, id: string) {
  const t = check(await supabaseAdmin.from("hd_tickets").select("id, code, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; code: string; status: string } | null;
  if (!t) throw new HttpError(404, "Ticket not found.");
  if (t.status === "Resolved") throw new HttpError(409, "That request is already resolved.");
  check(await supabaseAdmin.from("hd_tickets").update({ priority: "High" }).eq("id", id).eq("institution_id", inst).select("id"));
  await log(inst, profile, "ask-update", id, `Asked for an update on ${t.code}`, "asked");
  return { ok: true };
}

// ═════════════ school store ═════════════
export async function store(inst: string) {
  const ys = await yearStart(inst); const month = today().slice(0, 7);
  const [bills, items] = await Promise.all([
    supabaseAdmin.from("store_bills").select("amount, sold_on").eq("institution_id", inst).gte("sold_on", ys).limit(100000),
    supabaseAdmin.from("inv_items").select("name, in_stock, reorder_at, unit_price, unit").eq("institution_id", inst).limit(5000),
  ]);
  const B = check(bills) as { amount: number; sold_on: string }[]; const I = check(items) as { name: string; in_stock: number; reorder_at: number; unit_price: number; unit: string }[];
  const by = new Map<string, number>(); for (const b of B) by.set(b.sold_on.slice(0, 7), (by.get(b.sold_on.slice(0, 7)) ?? 0) + b.amount);
  const low = I.filter((i) => i.reorder_at > 0 && i.in_stock <= i.reorder_at);
  const m = B.filter((b) => b.sold_on.slice(0, 7) === month);
  return { since: ys, sales: B.reduce((n, b) => n + b.amount, 0), bills: B.length, month: { amount: m.reduce((n, b) => n + b.amount, 0), bills: m.length }, stock_value: I.reduce((n, i) => n + i.in_stock * i.unit_price, 0), low: low.length, low_items: low.slice(0, 6).map((i) => i.name), by_month: [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, amount]) => ({ label: new Date(key + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), amount })) };
}

// ═════════════ the Principal's own settings: designation, photo, signature, notification choices ═════════════
const IMG = z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, "Use a PNG or JPG image.").max(200_000, "Keep the image under 150 KB").nullable();
export async function mySettings(inst: string, profile: string) {
  const [p, st, sch, d] = await Promise.all([
    supabaseAdmin.from("user_profiles").select("designation").eq("id", profile).eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("staff_settings").select("photo, prefs").eq("profile_id", profile).eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("school_profile").select("signature").eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("hr_designations").select("name").eq("institution_id", inst).eq("status", "Active").order("name"),
  ]);
  const s = check(st) as { photo: string | null; prefs: Record<string, boolean> } | null;
  return { designation: (check(p) as { designation: string | null } | null)?.designation ?? "", designations: (check(d) as { name: string }[]).map((x) => x.name), photo: s?.photo ?? null, signature: (check(sch) as { signature: string | null } | null)?.signature ?? null, prefs: s?.prefs ?? {} };
}
export async function saveMySettings(inst: string, profile: string, input: unknown) {
  const i = z.object({ designation: z.string().trim().max(100).optional(), photo: IMG.optional(), signature: IMG.optional(), prefs: z.record(z.string().max(40), z.boolean()).optional() }).strict().parse(input);
  if (i.designation !== undefined) check(await supabaseAdmin.from("user_profiles").update({ designation: i.designation || null }).eq("id", profile).eq("institution_id", inst).select("id"));
  if (i.photo !== undefined || i.prefs !== undefined) {
    const cur = check(await supabaseAdmin.from("staff_settings").select("photo, prefs").eq("profile_id", profile).eq("institution_id", inst).maybeSingle()) as { photo: string | null; prefs: Record<string, boolean> } | null;
    check(await supabaseAdmin.from("staff_settings").upsert({ profile_id: profile, institution_id: inst, photo: i.photo === undefined ? cur?.photo ?? null : i.photo, prefs: i.prefs ?? cur?.prefs ?? {}, updated_at: new Date().toISOString() }, { onConflict: "profile_id" }).select("profile_id"));
  }
  // the signature is the one the school prints on certificates and report cards
  if (i.signature !== undefined) await saveLogo(inst, { kind: "signature", logo: i.signature });
  return mySettings(inst, profile);
}
