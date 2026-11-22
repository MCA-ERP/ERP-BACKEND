import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getRules } from "../school/attendance.service";
import { classSet, gradeIn } from "../school/exam.service";
import { BANDS, coscholastic, saveCoscholastic, saveSheet, sheet } from "../school/marks.service";
import { istDate, mySections, one, secLabel, sectionMap } from "./teacher.service";
import { pupils, requireSection, teaching } from "./teacher-classes.service";
import { mySubjectSections, subjectIn } from "./teacher-work.service";

/** Examinations: my papers and invigilation, marks entry, gradebook, holistic cards and competitive prep. All of it starts from this teacher's own classes and subjects. */
const uid = z.string().uuid();
const MY_MAX: Record<string, number> = { Practical: 30, Internal: 20 };
const clsName = (g: string) => `Class ${g.replace(/^(Grade|Class)\s+/i, "")}`;

// ═════════════ exam schedule ═════════════
type Paper = { id: string; exam_id: string; grade_id: string; subject_id: string; paper_date: string; starts: string; ends: string; hall: string | null; status: string; invigilator_id: string | null; paper_file: string | null; exams: { name: string; status: string } | { name: string; status: string }[] | null; grades: { name: string; sort_order: number } | { name: string; sort_order: number }[] | null; subjects: { name: string } | { name: string }[] | null };
const PSEL = "id, exam_id, grade_id, subject_id, paper_date, starts, ends, hall, status, invigilator_id, paper_file, exams:exam_id(name, status), grades:grade_id(name, sort_order), subjects:subject_id(name)";

async function myGradeSubjects(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [tt, sec] = await Promise.all([teaching(inst, me), m.ids.length ? supabaseAdmin.from("sections").select("id, grade_id").eq("institution_id", inst).in("id", m.ids) : Promise.resolve({ data: [], error: null })]);
  const grade = new Map(((check(sec as never) ?? []) as { id: string; grade_id: string }[]).map((s) => [s.id, s.grade_id]));
  return { pairs: new Set(tt.filter((t) => grade.has(t.section_id)).map((t) => `${grade.get(t.section_id)}:${t.subject_id}`)), tt, grade, m };
}

export async function schedule(inst: string, me: string) {
  const { pairs, tt, grade, m } = await myGradeSubjects(inst, me);
  const gids = [...new Set(grade.values())];
  const q = supabaseAdmin.from("exam_papers").select(PSEL).eq("institution_id", inst).order("paper_date").limit(3000);
  const rows = (check(await q) ?? []) as unknown as Paper[];
  const sm = await sectionMap(inst, m.ids);
  const today = istDate();
  const mine = rows.filter((r) => pairs.has(`${r.grade_id}:${r.subject_id}`) || r.invigilator_id === me);
  // one line per exam, subject, day, time and hall; the classes are joined
  const groups = new Map<string, Paper[]>();
  for (const r of mine) { const k = [r.exam_id, r.subject_id, r.paper_date, r.starts, r.ends, r.hall ?? ""].join("|"); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const items = [...groups.values()].map((g) => {
    const first = g[0]; const subject = one(first.subjects)?.name ?? "";
    const setter = g.some((p) => pairs.has(`${p.grade_id}:${p.subject_id}`)); const inv = g.some((p) => p.invigilator_id === me);
    const upcoming = first.paper_date >= today;
    const duty = [setter ? (upcoming ? "Paper setter" : "Evaluator") : "", inv ? "Invigilator" : ""].filter(Boolean).join(", ");
    const nums = g.map((p) => one(p.grades)?.name ?? "").map((n) => Number((/(\d+)\s*$/.exec(n) ?? [])[1])).filter(Number.isFinite).sort((a, b) => a - b);
    const classes = nums.length > 1 && nums[nums.length - 1] - nums[0] === nums.length - 1 ? `Classes ${nums[0]} – ${nums[nums.length - 1]}` : g.length > 1 ? `Classes ${nums.join(", ")}` : clsName(one(first.grades)?.name ?? "");
    const mySecs = [...sm.values()].filter((s) => g.some((p) => grade.get(s.id) === p.grade_id)).map((s) => secLabel(s).replace(/^Class\s*/, "")).sort();
    const examStatus = one(first.exams)?.status ?? "";
    return { ids: g.map((p) => p.id), exam_id: first.exam_id, exam: one(first.exams)?.name ?? "", classes, my_sections: mySecs, paper: subject, date: first.paper_date, starts: first.starts.slice(0, 5), ends: first.ends.slice(0, 5), hall: first.hall ?? "", duty, setter, invigilator: inv, upcoming, status: upcoming ? "Upcoming" : "Completed", exam_status: examStatus, paper_file: g.map((p) => p.paper_file).find(Boolean) ?? "", can_upload: setter && upcoming, can_enter_marks: setter && !upcoming && examStatus === "Marks entry" };
  });
  void gids; void tt;
  return { upcoming: items.filter((x) => x.upcoming).sort((a, b) => (a.date < b.date ? -1 : 1)), completed: items.filter((x) => !x.upcoming).sort((a, b) => (a.date < b.date ? 1 : -1)) };
}

export async function uploadPaper(inst: string, me: string, input: unknown) {
  const i = z.object({ ids: z.array(uid).min(1).max(20), file_name: z.string().trim().min(1).max(160) }).strict().parse(input);
  if (!/\.(pdf|docx?|jpe?g|png)$/i.test(i.file_name)) throw new HttpError(400, "Upload the paper as a PDF, Word file or photo.");
  const { pairs } = await myGradeSubjects(inst, me);
  const rows = (check(await supabaseAdmin.from("exam_papers").select("id, grade_id, subject_id, paper_date").eq("institution_id", inst).in("id", i.ids)) ?? []) as { id: string; grade_id: string; subject_id: string; paper_date: string }[];
  if (rows.length !== i.ids.length || rows.some((r) => !pairs.has(`${r.grade_id}:${r.subject_id}`))) throw new HttpError(403, "You can only upload papers for the subjects you teach.");
  if (rows.some((r) => r.paper_date < istDate())) throw new HttpError(409, "That paper has already been held.");
  check(await supabaseAdmin.from("exam_papers").update({ paper_file: i.file_name, paper_uploaded_by: me }).in("id", i.ids).eq("institution_id", inst).select("id"));
  return { ok: true };
}

export async function invigilation(inst: string, me: string) {
  const rows = (check(await supabaseAdmin.from("exam_papers").select(PSEL).eq("institution_id", inst).eq("invigilator_id", me).gte("paper_date", istDate()).order("paper_date").limit(300)) ?? []) as unknown as Paper[];
  const gids = [...new Set(rows.map((r) => r.grade_id))];
  const [secs, swaps] = await Promise.all([
    gids.length ? supabaseAdmin.from("sections").select("id, name, grade_id, grades:grade_id(name)").eq("institution_id", inst).in("grade_id", gids).eq("is_active", true) : Promise.resolve({ data: [], error: null }),
    rows.length ? supabaseAdmin.from("exam_duty_swaps").select("paper_id, status").eq("institution_id", inst).eq("requested_by", me).in("paper_id", rows.map((r) => r.id)) : Promise.resolve({ data: [], error: null }),
  ]);
  const S = (check(secs as never) ?? []) as unknown as { id: string; name: string; grade_id: string; grades: { name: string } | { name: string }[] | null }[];
  const kids = S.length ? (check(await supabaseAdmin.from("student_enrollments").select("section_id").eq("institution_id", inst).eq("status", "Active").in("section_id", S.map((s) => s.id)).limit(20000)) ?? []) as { section_id: string }[] : [];
  const W = new Map(((check(swaps as never) ?? []) as { paper_id: string; status: string }[]).map((s) => [s.paper_id, s.status]));
  return { items: rows.map((r) => { const ss = S.filter((s) => s.grade_id === r.grade_id); return { id: r.id, date: r.paper_date, paper: one(r.subjects)?.name ?? "", exam: one(r.exams)?.name ?? "", room: r.hall ?? "", students: kids.filter((k) => ss.some((s) => s.id === k.section_id)).length, classes: ss.map((s) => secLabel(s as never)).sort().join(", "), swap: W.get(r.id) ?? "" }; }) };
}

export async function requestSwap(inst: string, me: string, id: string, input: unknown) {
  const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).strict().parse(input);
  const p = check(await supabaseAdmin.from("exam_papers").select("id, paper_date").eq("id", uid.parse(id)).eq("institution_id", inst).eq("invigilator_id", me).maybeSingle()) as { id: string; paper_date: string } | null;
  if (!p) throw new HttpError(404, "That is not your duty.");
  if (p.paper_date < istDate()) throw new HttpError(409, "That paper has already been held.");
  check(await supabaseAdmin.from("exam_duty_swaps").upsert({ institution_id: inst, paper_id: id, requested_by: me, reason: reason ?? "", status: "Pending" }, { onConflict: "paper_id,requested_by" }).select("id"));
  return { ok: true };
}

// ═════════════ marks entry ═════════════
async function sectionGradeName(inst: string, sectionId: string) {
  const s = check(await supabaseAdmin.from("sections").select("id, grades:grade_id(name)").eq("id", sectionId).eq("institution_id", inst).maybeSingle()) as unknown as { id: string; grades: { name: string } | { name: string }[] | null } | null;
  return one(s?.grades ?? null)?.name ?? "";
}

export async function marksChoices(inst: string, me: string) {
  const { list } = await mySubjectSections(inst, me);
  const exams = (check(await supabaseAdmin.from("exams").select("id, name, classes, starts_on, ends_on, status").eq("institution_id", inst).neq("status", "Draft").order("starts_on", { ascending: false }).limit(200)) ?? []) as { id: string; name: string; classes: string; starts_on: string; ends_on: string; status: string }[];
  const out = [];
  for (const s of list) { const g = await sectionGradeName(inst, s.id); out.push({ id: s.id, label: s.label, subject: s.subject, exams: exams.filter((e) => gradeIn(g, classSet(e.classes))).map((e) => ({ id: e.id, name: e.name, starts_on: e.starts_on, ends_on: e.ends_on, status: e.status })) }); }
  return { sections: out };
}

export async function marksSheet(inst: string, me: string, q: { exam_id: string; section_id: string; component: string }) {
  const s = await subjectIn(inst, me, q.section_id);
  const sh = await sheet(inst, { exam_id: q.exam_id, section_id: q.section_id, subject_id: s.subject_id, component: q.component });
  return { ...sh, subject: s.subject, class_label: s.label };
}

export async function saveMarks(inst: string, me: string, input: unknown) {
  const sectionId = uid.parse((input as { section_id?: unknown })?.section_id);
  const s = await subjectIn(inst, me, sectionId);
  const body = { ...(input as Record<string, unknown>), subject_id: s.subject_id };
  return saveSheet(inst, body, me);
}

export async function coscholasticSheet(inst: string, me: string, sectionId: string, term: string) {
  await requireSection(inst, me, uid.parse(sectionId), true);
  const [r, sm] = await Promise.all([coscholastic(inst, { section_id: sectionId, term }), sectionMap(inst, [sectionId])]);
  return { ...r, class_label: secLabel(sm.get(sectionId) ?? null) };
}
export async function saveCoscholasticGrades(inst: string, me: string, input: unknown) {
  await requireSection(inst, me, uid.parse((input as { section_id?: unknown })?.section_id), true);
  return saveCoscholastic(inst, input);
}

// ═════════════ gradebook ═════════════
type Mk = { student_id: string; marks: number | null; absent: boolean; component: string; exam_id: string; exams: { name: string; starts_on: string; exam_types: { max_marks: number } | { max_marks: number }[] | null } | { name: string; starts_on: string; exam_types: { max_marks: number } | { max_marks: number }[] | null }[] | null };
export async function gradebookFor(inst: string, me: string, sectionId: string) {
  const s = await subjectIn(inst, me, sectionId);
  const [kids, rules, sm] = await Promise.all([pupils(inst, [sectionId]), getRules(inst), sectionMap(inst, [sectionId])]);
  const rows = kids.length ? (check(await supabaseAdmin.from("exam_marks").select("student_id, marks, absent, component, exam_id, exams:exam_id(name, starts_on, exam_types:exam_type_id(max_marks))").eq("institution_id", inst).eq("subject_id", s.subject_id).in("student_id", kids.map((k) => k.id)).in("status", ["Submitted", "Verified"]).limit(20000)) ?? []) as unknown as Mk[] : [];
  const exams = new Map<string, { id: string; name: string; max: number; starts_on: string }>();
  for (const r of rows) { const e = one(r.exams); const mx = r.component === "Theory" ? one(e?.exam_types ?? null)?.max_marks ?? 100 : MY_MAX[r.component] ?? 100; const cur = exams.get(r.exam_id); exams.set(r.exam_id, { id: r.exam_id, name: e?.name ?? "", starts_on: e?.starts_on ?? "", max: (cur?.max ?? 0) + (r.component === "Theory" || !cur ? mx : 0) }); }
  const cols = [...exams.values()].sort((a, b) => (a.starts_on < b.starts_on ? -1 : 1));
  // an exam's maximum is its theory paper (or the one component entered); other components are added in
  const maxOf = new Map<string, number>();
  for (const r of rows) { const e = one(r.exams); const mx = r.component === "Theory" ? one(e?.exam_types ?? null)?.max_marks ?? 100 : MY_MAX[r.component] ?? 100; maxOf.set(`${r.exam_id}:${r.component}`, mx); }
  const att = kids.length ? (check(await supabaseAdmin.from("attendance_records").select("student_id, status").eq("institution_id", inst).in("student_id", kids.map((k) => k.id)).limit(200000)) ?? []) as { student_id: string; status: string }[] : [];
  const bands = BANDS[rules.grading_scale] ?? [];
  const students = kids.map((k) => {
    const mine = rows.filter((r) => r.student_id === k.id && r.marks !== null && !r.absent);
    const scores = cols.map((c) => { const rs = mine.filter((r) => r.exam_id === c.id); return rs.length ? rs.reduce((a, r) => a + Number(r.marks), 0) : null; });
    const got = mine.reduce((a, r) => a + Number(r.marks), 0); const out = mine.reduce((a, r) => a + (maxOf.get(`${r.exam_id}:${r.component}`) ?? 100), 0);
    const pct = out ? Math.round((got / out) * 100) : null;
    const a = att.filter((x) => x.student_id === k.id);
    return { id: k.id, roll_no: k.roll_no, name: k.name, scores, percent: pct, grade: pct === null ? "" : bands.find((b) => pct >= b.min)?.grade ?? "", attendance: a.length ? Math.round((a.filter((x) => x.status === "P" || x.status === "L" || x.status === "H").length / a.length) * 100) : null };
  });
  return { section_id: sectionId, label: secLabel(sm.get(sectionId) ?? null), subject: s.subject, pass_mark: rules.pass_mark, exams: cols, students };
}

export async function gradebookStudents(inst: string, me: string, sectionId: string) {
  const g = await gradebookFor(inst, me, uid.parse(sectionId));
  const done = g.students.filter((s) => s.percent !== null) as { percent: number }[];
  const kids = (await mySections(inst, me)).classTeacherOf.includes(sectionId);
  return { ...g, is_class_teacher: kids, average: done.length ? Math.round((done.reduce((a, s) => a + s.percent, 0) / done.length) * 10) / 10 : null, highest: done.length ? Math.max(...done.map((s) => s.percent)) : null, pass_rate: done.length ? Math.round((done.filter((s) => s.percent >= g.pass_mark).length / done.length) * 100) : null, below_50: done.filter((s) => s.percent < 50).length };
}

export async function gradebookClasses(inst: string, me: string) {
  const { list } = await mySubjectSections(inst, me);
  const out = [];
  for (const s of list) {
    const g = await gradebookFor(inst, me, s.id); const done = g.students.filter((x) => x.percent !== null) as { percent: number; grade: string }[];
    out.push({ id: s.id, label: s.label, students: g.students.length, average: done.length ? Math.round((done.reduce((a, x) => a + x.percent, 0) / done.length) * 10) / 10 : null, highest: done.length ? Math.max(...done.map((x) => x.percent)) : null, lowest: done.length ? Math.min(...done.map((x) => x.percent)) : null, pass_rate: done.length ? Math.round((done.filter((x) => x.percent >= g.pass_mark).length / done.length) * 100) : null, top: done.filter((x) => x.grade === "A1" || x.grade === "A2").length });
  }
  return { subject: list[0]?.subject ?? "", items: out };
}

// ═════════════ holistic progress card ═════════════
export const DOMAINS = ["Physical development", "Socio-emotional", "Cognitive", "Language and literacy", "Creative and aesthetic", "Life skills"] as const;
const LEVELS = ["Beginner", "Proficient", "Advanced"] as const;
const termNow = () => (Number(istDate().slice(5, 7)) >= 4 && Number(istDate().slice(5, 7)) <= 9 ? "Term 1" : "Term 2");

export async function holisticCards(inst: string, me: string, sectionId: string) {
  await requireSection(inst, me, uid.parse(sectionId), true);
  const [kids, sm, yr] = await Promise.all([pupils(inst, [sectionId]), sectionMap(inst, [sectionId]), supabaseAdmin.from("academic_years").select("name").eq("institution_id", inst).eq("is_current", true).maybeSingle()]);
  const term = termNow();
  const cards = kids.length ? (check(await supabaseAdmin.from("holistic_cards").select("student_id, domains, comment").eq("institution_id", inst).eq("term", term).in("student_id", kids.map((k) => k.id))) ?? []) as { student_id: string; domains: Record<string, string>; comment: string }[] : [];
  return { term, year: ((check(yr) as { name: string } | null)?.name ?? "").replace(/^(\d{4})-\d{2}(\d{2})$/, "$1–$2"), class_label: secLabel(sm.get(sectionId) ?? null), domains: DOMAINS, levels: LEVELS, students: kids.map((k) => ({ id: k.id, roll_no: k.roll_no, name: k.name, domains: cards.find((c) => c.student_id === k.id)?.domains ?? {}, comment: cards.find((c) => c.student_id === k.id)?.comment ?? "", saved: cards.some((c) => c.student_id === k.id) })) };
}

export async function saveHolistic(inst: string, me: string, input: unknown) {
  const i = z.object({ section_id: uid, student_id: uid, domains: z.record(z.string(), z.enum(LEVELS)), comment: z.string().trim().max(1000) }).strict().parse(input);
  await requireSection(inst, me, i.section_id, true);
  if (!(await pupils(inst, [i.section_id])).some((k) => k.id === i.student_id)) throw new HttpError(403, "That student is not in your class.");
  const clean = Object.fromEntries(DOMAINS.map((d) => [d, i.domains[d]]));
  if (DOMAINS.some((d) => !clean[d])) throw new HttpError(400, "Choose a level for every domain.");
  check(await supabaseAdmin.from("holistic_cards").upsert({ institution_id: inst, student_id: i.student_id, term: termNow(), domains: clean, comment: i.comment, updated_by: me, updated_at: new Date().toISOString() }, { onConflict: "student_id,term" }).select("student_id"));
  return { ok: true };
}

// ═════════════ competitive prep ═════════════
const r1 = (n: number) => Math.round(n * 10) / 10;
const ready = (v: number | null) => (v === null ? "—" : v >= 70 ? "On track" : v >= 50 ? "Borderline" : "Needs support");

async function myProgrammes(inst: string, me: string) {
  const P = (check(await supabaseAdmin.from("comp_programmes").select("id, name, exams, who, schedule").eq("institution_id", inst).eq("mentor_id", me).order("name")) ?? []) as { id: string; name: string; exams: string; who: string; schedule: string }[];
  const ids = P.map((p) => p.id);
  const [M, T] = await Promise.all([
    ids.length ? supabaseAdmin.from("comp_members").select("programme_id, student_id").in("programme_id", ids).limit(20000) : Promise.resolve({ data: [], error: null }),
    ids.length ? supabaseAdmin.from("comp_tests").select("id, programme_id, name, test_date, questions, minutes, chapters").eq("institution_id", inst).in("programme_id", ids).order("test_date").limit(500) : Promise.resolve({ data: [], error: null }),
  ]);
  const Tt = (check(T as never) ?? []) as { id: string; programme_id: string; name: string; test_date: string; questions: number; minutes: number; chapters: string[] }[];
  const R = Tt.length ? (check(await supabaseAdmin.from("comp_results").select("test_id, student_id, score_pct").in("test_id", Tt.map((t) => t.id)).limit(50000)) ?? []) as { test_id: string; student_id: string; score_pct: number }[] : [];
  return { P, M: (check(M as never) ?? []) as { programme_id: string; student_id: string }[], T: Tt, R };
}

export async function compBatches(inst: string, me: string) {
  const { P, M, T, R } = await myProgrammes(inst, me);
  const today = istDate();
  const studentIds = [...new Set(M.map((m) => m.student_id))];
  const names = new Map<string, { name: string; label: string }>();
  if (studentIds.length) {
    const e = (check(await supabaseAdmin.from("student_enrollments").select("student_id, sections:section_id(name, grades:grade_id(name)), students:student_id(first_name, last_name)").eq("institution_id", inst).eq("status", "Active").in("student_id", studentIds).limit(5000)) ?? []) as unknown as { student_id: string; sections: { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null; students: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
    for (const x of e) { const s = one(x.students); const sec = one(x.sections); names.set(x.student_id, { name: s ? `${s.first_name} ${s.last_name}`.trim() : "", label: sec ? `${(one(sec.grades)?.name ?? "").replace(/^(Grade|Class)\s+/i, "")} ${sec.name}`.trim() : "" }); }
  }
  const sorted = [...T].sort((a, b) => (a.test_date < b.test_date ? -1 : 1));
  const held = sorted.filter((t) => R.some((r) => r.test_id === t.id));
  const lastT = held[held.length - 1]; const prevT = held[held.length - 2];
  const avgOf = (tid?: string) => { const v = R.filter((r) => r.test_id === tid).map((r) => Number(r.score_pct)); return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const last = avgOf(lastT?.id), prev = avgOf(prevT?.id);
  const top = lastT ? R.filter((r) => r.test_id === lastT.id).sort((a, b) => Number(b.score_pct) - Number(a.score_pct))[0] : null;
  const weak = new Map<string, string[]>();
  if (studentIds.length) { const cs = (check(await supabaseAdmin.from("comp_chapter_scores").select("student_id, chapter, accuracy").in("student_id", studentIds).limit(50000)) ?? []) as { student_id: string; chapter: string; accuracy: number }[]; for (const sid of studentIds) weak.set(sid, cs.filter((c) => c.student_id === sid).sort((a, b) => a.accuracy - b.accuracy).slice(0, 3).map((c) => c.chapter)); }
  const stu = studentIds.map((sid) => { const progs = M.filter((m) => m.student_id === sid).map((m) => m.programme_id); const mocks = sorted.filter((t) => progs.includes(t.programme_id)); const l3 = mocks.map((t) => R.find((r) => r.test_id === t.id && r.student_id === sid)).filter(Boolean).slice(-3).map((r) => Math.round(Number(r!.score_pct))); const est = l3.length ? r1(l3.reduce((a, b) => a + b, 0) / l3.length) : null; return { id: sid, name: names.get(sid)?.name ?? "", class_label: names.get(sid)?.label ?? "", last3: l3, est, readiness: ready(est), weak: weak.get(sid) ?? [] }; });
  const next = sorted.find((t) => t.test_date >= today);
  return {
    students: studentIds.length, classes: [...new Set(P.map((p) => p.who).filter(Boolean))].join(" · "),
    next_mock: next ? { date: next.test_date, name: next.name } : null, average_last: last, change: last !== null && prev !== null ? r1(last - prev) : null, last_name: lastT?.name ?? "",
    top: top ? { name: names.get(top.student_id)?.name ?? "", score: Number(top.score_pct) } : null,
    batches: P.map((p) => { const ts = T.filter((t) => t.programme_id === p.id); const res = R.filter((r) => ts.some((t) => t.id === r.test_id)); return { id: p.id, name: p.name, classes: p.who, when: p.schedule, students: M.filter((m) => m.programme_id === p.id).length, average: res.length ? r1(res.reduce((a, r) => a + Number(r.score_pct), 0) / res.length) : null }; }),
    watch: stu.filter((s) => s.est !== null).sort((a, b) => (a.est as number) - (b.est as number)).slice(0, 5),
  };
}

export async function compAnalysis(inst: string, me: string) {
  const { P, M, T } = await myProgrammes(inst, me);
  const withScores = T.length ? (check(await supabaseAdmin.from("comp_chapter_scores").select("test_id, student_id, chapter, accuracy").in("test_id", T.map((t) => t.id)).limit(100000)) ?? []) as { test_id: string; student_id: string; chapter: string; accuracy: number }[] : [];
  const tests = [...T].sort((a, b) => (a.test_date < b.test_date ? 1 : -1)).filter((t) => withScores.some((s) => s.test_id === t.id));
  const t = tests[0];
  if (!t) return { test: null, classes: [] as string[], chapters: [] as { chapter: string; by_class: Record<string, number | null> }[], students: 0 };
  const rows = withScores.filter((s) => s.test_id === t.id);
  const ids = [...new Set(rows.map((r) => r.student_id))];
  const e = (check(await supabaseAdmin.from("student_enrollments").select("student_id, sections:section_id(name, grades:grade_id(name))").eq("institution_id", inst).eq("status", "Active").in("student_id", ids)) ?? []) as unknown as { student_id: string; sections: { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null }[];
  const cls = new Map(e.map((x) => { const s = one(x.sections); return [x.student_id, s ? `${(one(s.grades)?.name ?? "").replace(/^(Grade|Class)\s+/i, "")}${s.name}` : ""] as const; }));
  const classes = [...new Set([...cls.values()].filter(Boolean))].sort();
  const chapters = [...new Set(rows.map((r) => r.chapter))];
  void P; void M;
  return { test: { name: t.name, students: ids.length }, classes, students: ids.length, chapters: chapters.map((c) => ({ chapter: c, by_class: Object.fromEntries(classes.map((k) => { const v = rows.filter((r) => r.chapter === c && cls.get(r.student_id) === k).map((r) => r.accuracy); return [k, v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null]; })) })) };
}

export async function compMockForm(inst: string, me: string) {
  const [{ P }, { list }, bank] = await Promise.all([myProgrammes(inst, me), mySubjectSections(inst, me), supabaseAdmin.from("comp_bank").select("subject, easy, medium, hard").eq("institution_id", inst)]);
  const subj = [...new Set(list.map((s) => s.subject_id))];
  const ch = subj.length ? (check(await supabaseAdmin.from("curriculum_chapters").select("chapter").eq("institution_id", inst).in("subject_id", subj).order("created_at").limit(300)) ?? []) as { chapter: string }[] : [];
  const B = (check(bank) ?? []) as { easy: number; medium: number; hard: number }[];
  return { programmes: P.map((p) => ({ id: p.id, name: p.name, who: p.who })), chapters: [...new Set(ch.map((c) => c.chapter))].slice(0, 40), bank: { easy: B.reduce((a, b) => a + b.easy, 0), medium: B.reduce((a, b) => a + b.medium, 0), hard: B.reduce((a, b) => a + b.hard, 0) } };
}

export async function createMock(inst: string, me: string, input: unknown) {
  const i = z.object({ programme_id: uid, name: z.string().trim().min(2, "Enter the test name.").max(120), test_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), minutes: z.number().int().min(5).max(600), chapters: z.array(z.string().trim().min(1).max(120)).min(1, "Choose at least one chapter.").max(40), easy: z.number().int().min(0).max(300), medium: z.number().int().min(0).max(300), hard: z.number().int().min(0).max(300), negative: z.enum(["None", "¼ mark", "⅓ mark"]) }).strict().parse(input);
  const { P } = await myProgrammes(inst, me);
  if (!P.some((p) => p.id === i.programme_id)) throw new HttpError(403, "That is not one of your batches.");
  if (i.test_date < istDate()) throw new HttpError(400, "A mock cannot be set in the past.");
  const q = i.easy + i.medium + i.hard;
  if (q < 1) throw new HttpError(400, "Add at least one question.");
  const f = await compMockForm(inst, me);
  if (i.easy > f.bank.easy || i.medium > f.bank.medium || i.hard > f.bank.hard) throw new HttpError(409, "The question bank does not have that many questions.");
  return check(await supabaseAdmin.from("comp_tests").insert({ institution_id: inst, programme_id: i.programme_id, name: i.name, test_date: i.test_date, questions: q, minutes: i.minutes, chapters: i.chapters, easy: i.easy, medium: i.medium, hard: i.hard, negative: i.negative, created_by: me }).select("id").single());
}
