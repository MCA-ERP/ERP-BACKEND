import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getRules } from "./attendance.service";
import { loadExam } from "./exam.service";
import { AREAS, BANDS } from "./marks.service";
import { roster } from "./student-mgmt.service";

/** Marks verification, results, rank and analysis, and report cards. */
const uid = z.string().uuid();
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const FIXED: Record<string, number> = { Practical: 30, Internal: 20 };
type Mark = { exam_id: string; student_id: string; subject_id: string; component: string; marks: number | null; absent: boolean; status: string; submitted_at: string | null; entered_by: string | null };
const COLS = "exam_id, student_id, subject_id, component, marks, absent, status, submitted_at, entered_by";

async function examMax(inst: string, examId: string) {
  const e = await loadExam(inst, examId);
  return { exam: e, max: one(e.exam_types)?.max_marks ?? 100 };
}
const maxOf = (component: string, theory: number) => (component === "Theory" ? theory : FIXED[component]);

// ═════════════ verification ═════════════
export async function verificationList(inst: string) {
  const [rows, ro, exams, subs, ts, types] = await Promise.all([
    supabaseAdmin.from("exam_marks").select(COLS).eq("institution_id", inst).neq("status", "Draft").limit(100000),
    roster(inst),
    supabaseAdmin.from("exams").select("id, name, exam_type_id").eq("institution_id", inst),
    supabaseAdmin.from("subjects").select("id, name").eq("institution_id", inst),
    supabaseAdmin.from("teacher_subjects").select("teacher_id, subject_id, section_id, teacher:teacher_id(first_name, last_name)").eq("institution_id", inst),
    supabaseAdmin.from("exam_types").select("id, max_marks").eq("institution_id", inst),
  ]);
  const kid = new Map(ro.items.map((r) => [r.id, r]));
  const en = new Map((check(exams) as { id: string; name: string; exam_type_id: string | null }[]).map((e) => [e.id, e]));
  const sn = new Map((check(subs) as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  const tm = new Map((check(types) as { id: string; max_marks: number }[]).map((t) => [t.id, t.max_marks]));
  const T = check(ts) as unknown as { subject_id: string; section_id: string | null; teacher: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  const g = new Map<string, { exam_id: string; section_id: string; subject_id: string; component: string; rows: Mark[] }>();
  for (const m of check(rows) as unknown as Mark[]) { const k = kid.get(m.student_id); if (!k?.section_id) continue; const key = `${m.exam_id}|${k.section_id}|${m.subject_id}|${m.component}`; const x = g.get(key) ?? { exam_id: m.exam_id, section_id: k.section_id, subject_id: m.subject_id, component: m.component, rows: [] }; x.rows.push(m); g.set(key, x); }
  const items = [...g.values()].map((x) => {
    const e = en.get(x.exam_id); const theory = (e?.exam_type_id ? tm.get(e.exam_type_id) : null) ?? 100; const max = maxOf(x.component, theory);
    const got = x.rows.filter((r) => !r.absent && r.marks !== null);
    const t = T.find((q) => q.subject_id === x.subject_id && q.section_id === x.section_id) ?? T.find((q) => q.subject_id === x.subject_id && q.section_id === null);
    const tt = one(t?.teacher ?? null);
    const status = x.rows.every((r) => r.status === "Verified") ? "Verified" : x.rows.some((r) => r.status === "Returned") ? "Returned for correction" : "Submitted";
    const sec = ro.items.find((r) => r.section_id === x.section_id);
    return { exam_id: x.exam_id, section_id: x.section_id, subject_id: x.subject_id, component: x.component, exam: e?.name ?? "", class_label: sec ? sec.class_label : "", subject: sn.get(x.subject_id) ?? "", component_label: x.component, teacher: tt ? `${tt.first_name} ${tt.last_name}`.trim() : "", entered: got.length, average: got.length ? Math.round((got.reduce((s, r) => s + Number(r.marks), 0) / (got.length * max)) * 100) : null, submitted: x.rows.map((r) => r.submitted_at ?? "").sort().pop() || null, status };
  });
  return { items: items.sort((a, b) => (b.submitted ?? "").localeCompare(a.submitted ?? "")) };
}

export async function decide(inst: string, input: unknown) {
  const i = z.object({ exam_id: uid, section_id: uid, subject_id: uid, component: z.enum(["Theory", "Practical", "Internal"]), action: z.enum(["verify", "return"]) }).strict().parse(input);
  const ids = (await roster(inst)).items.filter((r) => r.section_id === i.section_id).map((r) => r.id);
  if (!ids.length) throw new HttpError(404, "Section not found.");
  const cur = check(await supabaseAdmin.from("exam_marks").select("status").eq("institution_id", inst).eq("exam_id", i.exam_id).eq("subject_id", i.subject_id).eq("component", i.component).in("student_id", ids)) as { status: string }[];
  if (!cur.length || cur.every((r) => r.status === "Draft")) throw new HttpError(409, "Nothing has been submitted yet.");
  if (cur.every((r) => r.status === "Verified")) throw new HttpError(409, "These marks are already verified.");
  if (cur.some((r) => r.status === "Draft")) throw new HttpError(409, "Some marks are still in draft. Ask the teacher to submit them all.");
  check(await supabaseAdmin.from("exam_marks").update({ status: i.action === "verify" ? "Verified" : "Returned", updated_at: new Date().toISOString() }).eq("institution_id", inst).eq("exam_id", i.exam_id).eq("subject_id", i.subject_id).eq("component", i.component).in("student_id", ids).select("id"));
  return { ok: true };
}

// ═════════════ results ═════════════
async function compute(inst: string, examId: string, pick: (r: Awaited<ReturnType<typeof roster>>["items"][number]) => boolean) {
  const [{ exam, max }, ro, rules, subs] = await Promise.all([examMax(inst, examId), roster(inst), getRules(inst), supabaseAdmin.from("subjects").select("id, name").eq("institution_id", inst)]);
  const kids = ro.items.filter((r) => r.status === "Enrolled" && pick(r));
  const sn = new Map((check(subs) as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  const rows = kids.length ? (check(await supabaseAdmin.from("exam_marks").select(COLS).eq("institution_id", inst).eq("exam_id", examId).eq("component", "Theory").eq("status", "Verified").in("student_id", kids.map((k) => k.id))) as unknown as Mark[]) : [];
  const subjectIds = [...new Set(rows.map((r) => r.subject_id))].sort((a, b) => (sn.get(a) ?? "").localeCompare(sn.get(b) ?? ""));
  const bands = BANDS[rules.grading_scale] ?? [];
  const grade = (p: number) => bands.find((b) => p >= b.min)?.grade ?? "";
  const students = kids.map((k) => {
    const mine = subjectIds.map((s) => { const r = rows.find((x) => x.student_id === k.id && x.subject_id === s); const m = r && !r.absent ? Number(r.marks ?? 0) : null; return { subject_id: s, subject: sn.get(s) ?? "", marks: m, absent: !!r?.absent, pct: m === null ? null : Math.round((m / max) * 100) }; });
    const have = mine.filter((x) => x.marks !== null);
    const total = have.reduce((n, x) => n + (x.marks ?? 0), 0); const out = subjectIds.length * max;
    const pct = out ? Math.round((total / out) * 1000) / 10 : null;
    return { id: k.id, name: k.name, roll_no: k.roll_no, class_label: k.class_label, grade_id: k.grade_id, section_id: k.section_id, subjects: mine, total, out, pct, grade: pct === null ? "" : grade(pct), pass: subjectIds.length > 0 && mine.every((x) => x.pct !== null && x.pct >= rules.pass_mark), rank: 0 };
  }).sort((a, b) => (parseInt(a.roll_no) || 9999) - (parseInt(b.roll_no) || 9999) || a.name.localeCompare(b.name));
  const ranked = [...students].filter((s) => s.pct !== null).sort((a, b) => (b.pct as number) - (a.pct as number));
  ranked.forEach((s, i) => { s.rank = i > 0 && ranked[i - 1].pct === s.pct ? ranked[i - 1].rank : i + 1; });
  return { exam: exam.name, max, bands, subjects: subjectIds.map((id) => ({ id, name: sn.get(id) ?? "" })), students };
}

export async function results(inst: string, examId: string, sectionId: string) {
  const r = await compute(inst, examId, (k) => k.section_id === sectionId);
  const label = (await roster(inst)).items.find((k) => k.section_id === sectionId)?.class_label ?? "";
  return { ...r, label, verified: r.subjects.length > 0 };
}
export async function analysis(inst: string, examId: string, sectionId: string) {
  const ro = (await roster(inst)).items;
  const g = ro.find((k) => k.section_id === sectionId);
  const r = await compute(inst, examId, (k) => !!g && k.grade_id === g.grade_id);
  const have = r.students.filter((s) => s.pct !== null);
  const rules = await getRules(inst);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  const dist = r.bands.map((b) => ({ grade: b.grade, n: have.filter((s) => s.grade === b.grade).length }));
  const below = have.filter((s) => !s.pass).length;
  return { exam: r.exam, class_name: g?.class_name ?? "", students: have.length, pass_rate: have.length ? Math.round(((have.length - below) / have.length) * 1000) / 10 : 0, below, pass_mark: rules.pass_mark, average: avg(have.map((s) => s.pct as number)), toppers: have.filter((s) => (s.pct as number) >= 95).length, by_subject: r.subjects.map((s) => ({ name: s.name, avg: Math.round(avg(have.map((x) => x.subjects.find((y) => y.subject_id === s.id)?.pct).filter((v): v is number => typeof v === "number"))) })), distribution: dist };
}

// ═════════════ report cards ═════════════
const DEFAULT_TEMPLATES: [string, string, string][] = [["CBSE · Classes 1 – 5", "Descriptive indicators + grades", "Active"], ["CBSE · Classes 6 – 10", "Marks, grades and co-scholastic", "Active"], ["Classes 11 – 12", "Marks with practicals", "Active"], ["Pre-primary", "Skills checklist with comments", "Active"], ["Half-yearly progress", "Term 1 only", "Draft"]];
export async function templates(inst: string) {
  const have = check(await supabaseAdmin.from("report_templates").select("id").eq("institution_id", inst)) as unknown[];
  if (!have.length) check(await supabaseAdmin.from("report_templates").insert(DEFAULT_TEMPLATES.map(([name, about, status]) => ({ institution_id: inst, name, about, status }))).select("id"));
  return { items: check(await supabaseAdmin.from("report_templates").select("id, name, about, status").eq("institution_id", inst).order("name")) as unknown[] };
}
export async function setTemplate(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Draft"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("report_templates").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Template not found.");
  return { ok: true };
}
export async function cardRuns(inst: string, examId: string) {
  await loadExam(inst, examId);
  const [ro, marks, runs] = await Promise.all([roster(inst), supabaseAdmin.from("exam_marks").select("student_id, status").eq("institution_id", inst).eq("exam_id", examId).limit(100000), supabaseAdmin.from("report_card_runs").select("section_id, status").eq("exam_id", examId)]);
  const sec = new Map<string, { id: string; label: string; kids: Set<string>; order: number }>();
  for (const r of ro.items.filter((x) => x.status === "Enrolled" && x.section_id)) { const s = sec.get(r.section_id as string) ?? { id: r.section_id as string, label: r.class_label, kids: new Set<string>(), order: r.sort }; s.kids.add(r.id); sec.set(s.id, s); }
  const M = check(marks) as { student_id: string; status: string }[]; const R = new Map((check(runs) as { section_id: string; status: string }[]).map((x) => [x.section_id, x.status]));
  return { items: [...sec.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, undefined, { numeric: true })).map((s) => { const mine = M.filter((m) => s.kids.has(m.student_id)); return { section_id: s.id, label: s.label, marks: mine.length && mine.every((m) => m.status === "Verified") ? "Approved" : "Pending", run: R.get(s.id) ?? "Not started" }; }) };
}
async function needApproved(inst: string, examId: string, sectionId: string) {
  const row = (await cardRuns(inst, examId)).items.find((x) => x.section_id === sectionId);
  if (!row) throw new HttpError(404, "Section not found.");
  return row;
}
export async function generate(inst: string, input: unknown) {
  const i = z.object({ exam_id: uid, section_id: uid }).strict().parse(input);
  const row = await needApproved(inst, i.exam_id, i.section_id);
  if (row.marks !== "Approved") throw new HttpError(409, "Verify every mark for this class first.");
  if (row.run === "Published") return { ok: true, status: "Published" };
  check(await supabaseAdmin.from("report_card_runs").upsert({ exam_id: i.exam_id, section_id: i.section_id, institution_id: inst, status: "Generated", generated_at: new Date().toISOString() }, { onConflict: "exam_id,section_id" }).select("section_id"));
  return { ok: true, status: "Generated" };
}
export async function publishCards(inst: string, input: unknown, actor?: string) {
  const i = z.object({ exam_id: uid, section_id: uid }).strict().parse(input);
  const row = await needApproved(inst, i.exam_id, i.section_id);
  if (row.run !== "Generated") throw new HttpError(409, row.run === "Published" ? "Already published." : "Generate the report cards first.");
  const exam = await loadExam(inst, i.exam_id);
  const ids = (await roster(inst)).items.filter((r) => r.section_id === i.section_id).map((r) => r.id);
  const links = ids.length ? (check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).in("student_id", ids)) as { student_id: string; guardian_id: string }[]) : [];
  const seen = new Set<string>();
  const msgs = links.filter((l) => !seen.has(l.guardian_id) && seen.add(l.guardian_id)).map((l) => ({ institution_id: inst, kind: "notification", guardian_id: l.guardian_id, student_id: l.student_id, subject: `${exam.name} report card is ready`, body: "Open the parent app to see the report card.", created_by: actor ?? null }));
  for (let k = 0; k < msgs.length; k += 500) check(await supabaseAdmin.from("parent_messages").insert(msgs.slice(k, k + 500)).select("id"));
  check(await supabaseAdmin.from("report_card_runs").update({ status: "Published", published_at: new Date().toISOString() }).eq("exam_id", i.exam_id).eq("section_id", i.section_id).select("section_id"));
  return { ok: true, notified: msgs.length };
}
export async function card(inst: string, examId: string, studentId: string) {
  const ro = (await roster(inst)).items;
  const k = ro.find((r) => r.id === studentId);
  if (!k) throw new HttpError(404, "Student not found.");
  const [r, school, yr, att, co] = await Promise.all([
    compute(inst, examId, (x) => x.id === studentId),
    supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle(),
    supabaseAdmin.from("academic_years").select("name, start_date").eq("institution_id", inst).eq("is_current", true).maybeSingle(),
    supabaseAdmin.from("attendance_records").select("status").eq("student_id", studentId).limit(5000),
    supabaseAdmin.from("coscholastic_grades").select("area, grade").eq("student_id", studentId).eq("term", "Term 1"),
  ]);
  const s = r.students[0];
  const A = check(att) as { status: string }[];
  const years = yr.data as { name: string } | null;
  const grades = new Map((check(co) as { area: string; grade: string }[]).map((x) => [x.area, x.grade]));
  const p = s?.pct ?? null;
  const remark = p === null ? "" : p >= 85 ? "Excellent work. Keep it up." : p >= 70 ? "Consistent and hard-working." : p >= 50 ? "Doing well. A little more practice will help." : "Needs extra support. Please meet the class teacher.";
  return { school: (school.data as { name: string } | null)?.name ?? "", exam: r.exam, year: years?.name ?? "", name: k.name, class_label: k.class_label, roll_no: k.roll_no, attendance: A.length ? Math.round((A.filter((x) => x.status !== "A" && x.status !== "V").length / A.length) * 100) : null, max: r.max, subjects: (s?.subjects ?? []).map((x) => ({ name: x.subject, marks: x.marks, pct: x.pct, grade: x.pct === null ? "" : r.bands.find((b) => x.pct! >= b.min)?.grade ?? "" })), total: s?.total ?? 0, out: s?.out ?? 0, pct: p, grade: s?.grade ?? "", rank: s?.rank ?? 0, coscholastic: AREAS.map(([a]) => ({ area: a, grade: grades.get(a) ?? "" })).filter((x) => x.grade), remark, verified: !!s && r.subjects.length > 0 };
}
export async function holistic(inst: string) {
  const [ro, co] = await Promise.all([roster(inst), supabaseAdmin.from("coscholastic_grades").select("student_id, area").eq("institution_id", inst).eq("term", "Term 1").limit(100000)]);
  const done = new Map<string, Set<string>>();
  for (const c of check(co) as { student_id: string; area: string }[]) done.set(c.student_id, new Set([...(done.get(c.student_id) ?? []), c.area]));
  const stage = (n: string) => { const m = /(\d+)\s*$/.exec(n); const c = m ? +m[1] : 0; return !m ? "Nursery – UKG · Play-based" : c <= 2 ? "Classes 1 – 2 · Foundational" : c <= 5 ? "Classes 3 – 5 · Preparatory" : c <= 8 ? "Classes 6 – 8 · Middle" : "Classes 9 – 12 · Secondary"; };
  const by = new Map<string, { total: number; complete: number }>();
  for (const r of ro.items.filter((x) => x.status === "Enrolled")) { const s = stage(r.class_name); const b = by.get(s) ?? { total: 0, complete: 0 }; b.total++; if ((done.get(r.id)?.size ?? 0) >= AREAS.length) b.complete++; by.set(s, b); }
  const order = ["Nursery", "Classes 1", "Classes 3", "Classes 6", "Classes 9"];
  const stages = [...by.entries()].map(([name, v]) => ({ name, ...v, pct: v.total ? Math.round((v.complete / v.total) * 100) : 0 })).sort((a, b) => order.findIndex((o) => a.name.startsWith(o)) - order.findIndex((o) => b.name.startsWith(o)));
  return { total: stages.reduce((n, s) => n + s.total, 0), complete: stages.reduce((n, s) => n + s.complete, 0), stages };
}
