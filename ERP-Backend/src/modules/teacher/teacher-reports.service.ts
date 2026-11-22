import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { istDate, mySections, secLabel, sectionMap } from "./teacher.service";
import { flatGuardians, pupils, requireSection, studentProfile, yearBounds } from "./teacher-classes.service";
import { gradebookFor } from "./teacher-exams.service";
import { mySubjectSections, notifyParents } from "./teacher-work.service";

/** Class reports and individual student reports for the teacher's own classes. */
const attended = (s: string) => s === "P" || s === "L" || s === "H";
const pct = (a: number, n: number) => (n ? Math.round((a / n) * 1000) / 10 : null);
const term = () => (Number(istDate().slice(5, 7)) >= 4 && Number(istDate().slice(5, 7)) <= 9 ? "Term 1" : "Term 2");

export async function classAttendanceReport(inst: string, me: string, sectionId: string) {
  await requireSection(inst, me, sectionId, true);
  const y = await yearBounds(inst);
  const [kids, sm] = await Promise.all([pupils(inst, [sectionId]), sectionMap(inst, [sectionId])]);
  const rec = (check(await supabaseAdmin.from("attendance_records").select("student_id, att_date, status").eq("institution_id", inst).eq("section_id", sectionId).gte("att_date", y?.start_date ?? istDate()).limit(200000)) ?? []) as { student_id: string; att_date: string; status: string }[];
  const month = istDate().slice(0, 7);
  const months = [...new Set(rec.map((r) => r.att_date.slice(0, 7)))].sort();
  const per = kids.map((k) => { const r = rec.filter((x) => x.student_id === k.id); return { k, n: r.length, a: r.filter((x) => attended(x.status)).length, absent: r.filter((x) => x.status === "A").length }; });
  const low = per.filter((p) => p.n && (p.a / p.n) * 100 < 85);
  const g = low.length ? flatGuardians(check(await supabaseAdmin.from("student_guardians").select("student_id, relation, guardians:guardian_id(full_name, phone)").in("student_id", low.map((p) => p.k.id)).limit(5000))) : [];
  const parent = (sid: string) => g.filter((x) => x.student_id === sid).sort((a, b) => (a.relation === "Father" ? -1 : 1) - (b.relation === "Father" ? -1 : 1))[0];
  return {
    label: secLabel(sm.get(sectionId) ?? null), students: kids.length, year: y?.name ?? "", this_year: pct(rec.filter((r) => attended(r.status)).length, rec.length), this_month: pct(rec.filter((r) => r.att_date.startsWith(month) && attended(r.status)).length, rec.filter((r) => r.att_date.startsWith(month)).length),
    full: per.filter((p) => p.n && (p.a / p.n) * 100 >= 97).length,
    months: months.map((m) => ({ month: m, percent: pct(rec.filter((r) => r.att_date.startsWith(m) && attended(r.status)).length, rec.filter((r) => r.att_date.startsWith(m)).length) })), current_month: month,
    below: low.sort((a, b) => a.a / a.n - b.a / b.n).map((p) => ({ id: p.k.id, roll_no: p.k.roll_no, name: p.k.name, attendance: Math.round((p.a / p.n) * 100), days_absent: p.absent, father: parent(p.k.id)?.full_name ?? "", mobile: parent(p.k.id)?.phone ?? "" })),
  };
}

export async function classAcademicReport(inst: string, me: string, sectionId: string) {
  const g = await gradebookFor(inst, me, sectionId);
  type S = (typeof g.students)[number] & { percent: number };
  const done = g.students.filter((s) => s.percent !== null) as S[];
  const avgPct = (i: number) => { const v = done.map((s) => s.scores[i]).filter((x): x is number => x !== null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length / g.exams[i].max) * 1000) / 10 : null; };
  const order = ["A1", "A2", "B1", "B2", "C1", "C2", "D", "E"];
  const top = [...done].sort((a, b) => b.percent - a.percent);
  const m = await mySections(inst, me);
  return {
    label: g.label, subject: g.subject, students: g.students.length, is_class_teacher: m.classTeacherOf.includes(sectionId), exams: g.exams.map((e) => e.name),
    average: done.length ? Math.round((done.reduce((a, s) => a + s.percent, 0) / done.length) * 10) / 10 : null, pass_rate: done.length ? Math.round((done.filter((s) => s.percent >= g.pass_mark).length / done.length) * 100) : null,
    top_score: top[0] ? { percent: top[0].percent, name: top[0].name } : null, below_50: done.filter((s) => s.percent < 50).length,
    by_assessment: g.exams.map((e, i) => ({ name: e.name, percent: avgPct(i) })),
    grades: order.map((gr) => ({ grade: gr, n: done.filter((s) => s.grade === gr).length })),
    top5: top.slice(0, 5).map((s) => ({ id: s.id, roll_no: s.roll_no, name: s.name, percent: s.percent })),
    support: [...done].sort((a, b) => a.percent - b.percent).slice(0, 5).map((s) => ({ id: s.id, roll_no: s.roll_no, name: s.name, percent: s.percent, attendance: s.attendance })),
  };
}

export async function reportSections(inst: string, me: string) {
  const { list } = await mySubjectSections(inst, me);
  const m = await mySections(inst, me);
  return { sections: list.map((s) => ({ id: s.id, label: s.label, subject: s.subject, is_class_teacher: m.classTeacherOf.includes(s.id) })) };
}

export async function studentReport(inst: string, me: string, studentId: string) {
  const p = await studentProfile(inst, me, studentId);
  const m = await mySections(inst, me);
  const k = (await pupils(inst, m.ids)).find((x) => x.id === studentId);
  if (!k) throw new HttpError(404, "That student is not in one of your classes.");
  const g = await gradebookFor(inst, me, k.section_id);
  const mine = g.students.find((s) => s.id === studentId);
  const done = g.students.filter((s) => s.percent !== null) as { percent: number }[];
  const avg = done.length ? Math.round((done.reduce((a, s) => a + s.percent, 0) / done.length) * 10) / 10 : null;
  const classAvg = g.exams.map((e, i) => { const v = g.students.map((s) => s.scores[i]).filter((x): x is number => x !== null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; });
  const rem = check(await supabaseAdmin.from("student_report_remarks").select("remark").eq("student_id", studentId).eq("term", term()).maybeSingle()) as { remark: string } | null;
  return { ...p, grade: mine?.grade ?? "", section_average: avg, class_label: g.label, term: term(), assessments: g.exams.map((e, i) => ({ name: e.name, score: mine?.scores[i] ?? null, max: e.max, class_average: classAvg[i] })), remark: rem?.remark ?? "", is_class_teacher: m.classTeacherOf.includes(k.section_id) };
}

export async function saveRemark(inst: string, me: string, input: unknown) {
  const i = z.object({ student_id: z.string().uuid(), remark: z.string().trim().max(500), share: z.boolean().optional() }).strict().parse(input);
  const m = await mySections(inst, me);
  const k = (await pupils(inst, m.ids)).find((x) => x.id === i.student_id);
  if (!k) throw new HttpError(403, "That student is not in one of your classes.");
  check(await supabaseAdmin.from("student_report_remarks").upsert({ institution_id: inst, student_id: i.student_id, term: term(), remark: i.remark, updated_by: me, updated_at: new Date().toISOString() }, { onConflict: "student_id,term" }).select("student_id"));
  if (i.share) {
    if (!i.remark) throw new HttpError(400, "Write the remark first.");
    if (!(await notifyParents(inst, me, [k.id], `Report remark for ${k.name}`, i.remark))) throw new HttpError(409, "There is no parent on file for this student.");
  }
  return { ok: true };
}
