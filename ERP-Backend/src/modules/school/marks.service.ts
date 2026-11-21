import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getRules } from "./attendance.service";
import { loadExam } from "./exam.service";
import { getMarksSettings } from "./exam-config.service";
import { roster } from "./student-mgmt.service";

/** Marks entry, bulk entry, co-scholastic grades and the question bank. */
const uid = z.string().uuid();
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const COMPONENTS = ["Theory", "Practical", "Internal"] as const;
type Comp = (typeof COMPONENTS)[number];
const FIXED: Record<string, number> = { Practical: 30, Internal: 20 };
export const BANDS: Record<string, { min: number; grade: string }[]> = {
  "CBSE 8-point (A1 – E)": [{ min: 91, grade: "A1" }, { min: 81, grade: "A2" }, { min: 71, grade: "B1" }, { min: 61, grade: "B2" }, { min: 51, grade: "C1" }, { min: 41, grade: "C2" }, { min: 33, grade: "D" }, { min: 0, grade: "E" }],
  "5-point (A – E)": [{ min: 81, grade: "A" }, { min: 61, grade: "B" }, { min: 41, grade: "C" }, { min: 33, grade: "D" }, { min: 0, grade: "E" }],
  "Percentage only": [],
};
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

async function maxFor(inst: string, exam: Awaited<ReturnType<typeof loadExam>>, comp: Comp) {
  if (comp !== "Theory") return FIXED[comp];
  return one(exam.exam_types)?.max_marks ?? 100;
}
async function sectionKids(inst: string, sectionId: string) {
  const ro = await roster(inst);
  const kids = ro.items.filter((r) => r.section_id === sectionId && r.status === "Enrolled").sort((a, b) => (parseInt(a.roll_no) || 9999) - (parseInt(b.roll_no) || 9999) || a.name.localeCompare(b.name));
  if (!kids.length) { const s = check(await supabaseAdmin.from("sections").select("id").eq("id", sectionId).eq("institution_id", inst).maybeSingle()); if (!s) throw new HttpError(404, "Section not found."); }
  return kids;
}
async function subjectOk(inst: string, id: string) {
  const s = check(await supabaseAdmin.from("subjects").select("id, name").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; name: string } | null;
  if (!s) throw new HttpError(404, "Subject not found.");
  return s;
}

export async function sheet(inst: string, q: { exam_id: string; section_id: string; subject_id: string; component: string }) {
  const i = z.object({ exam_id: uid, section_id: uid, subject_id: uid, component: z.enum(COMPONENTS) }).parse(q);
  const [exam, kids, rules, set] = await Promise.all([loadExam(inst, i.exam_id), sectionKids(inst, i.section_id), getRules(inst), getMarksSettings(inst)]);
  await subjectOk(inst, i.subject_id);
  const rows = kids.length ? (check(await supabaseAdmin.from("exam_marks").select("student_id, marks, absent, status").eq("exam_id", i.exam_id).eq("subject_id", i.subject_id).eq("component", i.component).in("student_id", kids.map((k) => k.id))) as { student_id: string; marks: number | null; absent: boolean; status: string }[]) : [];
  const by = new Map(rows.map((r) => [r.student_id, r]));
  const st = rows.some((r) => r.status === "Verified") ? "Verified" : rows.some((r) => r.status === "Returned") ? "Returned" : rows.length && rows.every((r) => r.status === "Submitted") && rows.length === kids.length ? "Submitted" : rows.length ? "Draft" : "New";
  const ends = new Date(exam.ends_on + "T00:00:00Z").getTime() + (({ "Same day": 0, "2 days": 2, "5 days": 5, "10 days": 10 } as Record<string, number>)[set.entry_days] ?? 5) * 86400000;
  return { exam: exam.name, max: await maxFor(inst, exam, i.component), bands: BANDS[rules.grading_scale] ?? [], status: st, open: st !== "Verified" && Date.parse(today() + "T00:00:00Z") <= ends, closes: new Date(ends).toISOString().slice(0, 10), students: kids.map((k) => { const r = by.get(k.id); return { id: k.id, name: k.name, roll_no: k.roll_no, marks: r?.marks ?? null, absent: r?.absent ?? false }; }) };
}

export async function saveSheet(inst: string, input: unknown, actor?: string) {
  const i = z.object({ exam_id: uid, section_id: uid, subject_id: uid, component: z.enum(COMPONENTS), submit: z.boolean().optional(), marks: z.array(z.object({ student_id: uid, marks: z.number().min(0).max(1000).nullable(), absent: z.boolean() })).min(1).max(400) }).strict().parse(input);
  const cur = await sheet(inst, i);
  if (cur.status === "Verified") throw new HttpError(409, "These marks are verified and locked. Changes need the principal's approval.");
  if (!cur.open) throw new HttpError(409, `The marks entry window closed on ${cur.closes}.`);
  const kids = new Set((await sectionKids(inst, i.section_id)).map((k) => k.id));
  for (const m of i.marks) { if (!kids.has(m.student_id)) throw new HttpError(400, "A student is not in this section."); if (!m.absent && m.marks !== null && m.marks > cur.max) throw new HttpError(400, `Marks can't be above ${cur.max}.`); }
  if (i.submit && i.marks.some((m) => !m.absent && m.marks === null)) throw new HttpError(400, "Enter marks for everyone, or mark them absent, before you submit.");
  const rows = i.marks.map((m) => ({ institution_id: inst, exam_id: i.exam_id, student_id: m.student_id, subject_id: i.subject_id, component: i.component, marks: m.absent ? null : m.marks, absent: m.absent, status: i.submit ? "Submitted" : "Draft", submitted_at: i.submit ? new Date().toISOString() : null, entered_by: actor ?? null, updated_at: new Date().toISOString() }));
  check(await supabaseAdmin.from("exam_marks").upsert(rows, { onConflict: "exam_id,student_id,subject_id,component" }).select("id"));
  return { saved: rows.length, submitted: !!i.submit };
}

export async function bulk(inst: string, input: unknown, actor?: string) {
  const rows = z.array(z.object({ admission_no: z.string(), subject: z.string(), exam: z.string(), marks: z.number().nullable() })).max(1000).parse((input as { rows?: unknown })?.rows ?? []);
  const [ro, exams, subs, types] = await Promise.all([roster(inst), supabaseAdmin.from("exams").select("id, name, exam_type_id, ends_on").eq("institution_id", inst), supabaseAdmin.from("subjects").select("id, name").eq("institution_id", inst), supabaseAdmin.from("exam_types").select("id, max_marks").eq("institution_id", inst)]);
  const kids = new Map(ro.items.map((r) => [r.registration_no.toLowerCase(), r]));
  const E = (check(exams) as { id: string; name: string; exam_type_id: string | null }[]);
  const S = (check(subs) as { id: string; name: string }[]);
  const T = new Map((check(types) as { id: string; max_marks: number }[]).map((t) => [t.id, t.max_marks]));
  const problems: { row: number; message: string }[] = []; const out = [];
  for (const [n, r] of rows.entries()) {
    const k = kids.get(r.admission_no.trim().toLowerCase()); const e = E.find((x) => x.name.toLowerCase() === r.exam.trim().toLowerCase()); const s = S.find((x) => x.name.toLowerCase() === r.subject.trim().toLowerCase());
    if (!k) { problems.push({ row: n + 2, message: "Admission number not found" }); continue; }
    if (!e) { problems.push({ row: n + 2, message: "Exam not found" }); continue; }
    if (!s) { problems.push({ row: n + 2, message: "Subject not found" }); continue; }
    if (r.marks === null) { problems.push({ row: n + 2, message: "Marks are missing" }); continue; }
    const max = (e.exam_type_id ? T.get(e.exam_type_id) : null) ?? 100;
    if (r.marks < 0 || r.marks > max) { problems.push({ row: n + 2, message: `Marks must be between 0 and ${max}` }); continue; }
    out.push({ institution_id: inst, exam_id: e.id, student_id: k.id, subject_id: s.id, component: "Theory", marks: r.marks, absent: false, status: "Draft", entered_by: actor ?? null, updated_at: new Date().toISOString() });
  }
  if (out.length) {
    const ids = [...new Set(out.map((o) => o.student_id))];
    const locked = (check(await supabaseAdmin.from("exam_marks").select("student_id, exam_id, subject_id").eq("component", "Theory").eq("status", "Verified").in("student_id", ids)) as { student_id: string; exam_id: string; subject_id: string }[]);
    const lk = new Set(locked.map((l) => `${l.student_id}|${l.exam_id}|${l.subject_id}`));
    const ok = out.filter((o) => !lk.has(`${o.student_id}|${o.exam_id}|${o.subject_id}`));
    if (ok.length) check(await supabaseAdmin.from("exam_marks").upsert(ok, { onConflict: "exam_id,student_id,subject_id,component" }).select("id"));
    return { saved: ok.length, skipped_locked: out.length - ok.length, problems };
  }
  return { saved: 0, skipped_locked: 0, problems };
}

// ═════════════ co-scholastic ═════════════
export const AREAS = [["Art education", "Drawing, craft and colour work"], ["Work education", "Gardening and craft projects"], ["Health & physical education", "Sports, yoga and fitness"], ["Music and dance", "Participation and performance"], ["Discipline", "Punctuality and conduct"], ["Values and attitude", "Respect, honesty, teamwork"]] as const;
export async function coscholastic(inst: string, q: { section_id: string; term: string }) {
  const i = z.object({ section_id: uid, term: z.enum(["Term 1", "Term 2"]) }).parse(q);
  const kids = await sectionKids(inst, i.section_id);
  const rows = kids.length ? (check(await supabaseAdmin.from("coscholastic_grades").select("student_id, area, grade").eq("term", i.term).in("student_id", kids.map((k) => k.id))) as { student_id: string; area: string; grade: string }[]) : [];
  return { areas: AREAS.map(([name, about]) => ({ name, about })), students: kids.map((k) => ({ id: k.id, name: k.name, roll_no: k.roll_no, grades: Object.fromEntries(AREAS.map(([a]) => [a, rows.find((r) => r.student_id === k.id && r.area === a)?.grade ?? ""])) })) };
}
export async function saveCoscholastic(inst: string, input: unknown) {
  const i = z.object({ section_id: uid, term: z.enum(["Term 1", "Term 2"]), grades: z.array(z.object({ student_id: uid, area: z.string(), grade: z.enum(["A", "B", "C"]) })).min(1).max(3000) }).strict().parse(input);
  const kids = new Set((await sectionKids(inst, i.section_id)).map((k) => k.id));
  const areas = new Set(AREAS.map(([a]) => a as string));
  for (const g of i.grades) if (!kids.has(g.student_id) || !areas.has(g.area)) throw new HttpError(400, "A grade doesn't match this section.");
  check(await supabaseAdmin.from("coscholastic_grades").upsert(i.grades.map((g) => ({ institution_id: inst, student_id: g.student_id, term: i.term, area: g.area, grade: g.grade })), { onConflict: "student_id,term,area" }).select("id"));
  return { saved: i.grades.length };
}

// ═════════════ question bank ═════════════
export async function listQuestions(inst: string) {
  const rows = check(await supabaseAdmin.from("question_bank").select("id, code, chapter, qtype, marks, difficulty, source, status, grades:grade_id(name), subjects:subject_id(name), who:added_by(first_name, last_name)").eq("institution_id", inst).order("created_at", { ascending: false }).limit(3000)) as unknown as { id: string; code: string; chapter: string; qtype: string; marks: number; difficulty: string; source: string; status: string; grades: { name: string } | { name: string }[] | null; subjects: { name: string } | { name: string }[] | null; who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  return { items: rows.map((r) => { const w = one(r.who); return { id: r.id, code: r.code, class_label: one(r.grades)?.name ?? "", subject: one(r.subjects)?.name ?? "", chapter: r.chapter, qtype: r.qtype, marks: r.marks, difficulty: r.difficulty, source: r.source, added_by: w ? `${w.first_name} ${w.last_name}`.trim() : "", status: r.status }; }) };
}
export async function addQuestion(inst: string, input: unknown, actor?: string) {
  const i = z.object({ grade_id: uid, subject_id: uid, chapter: z.string().trim().max(200).optional(), qtype: z.enum(["MCQ", "Short answer", "Long answer", "Case-based"]), marks: z.number().int().min(1).max(20), difficulty: z.enum(["Easy", "Medium", "Hard"]), added_by: uid.nullable().optional(), source: z.enum(["Created", "Uploaded"]) }).strict().parse(input);
  const g = check(await supabaseAdmin.from("grades").select("id").eq("id", i.grade_id).eq("institution_id", inst).maybeSingle());
  if (!g) throw new HttpError(404, "Class not found.");
  await subjectOk(inst, i.subject_id);
  if (i.added_by) { const t = check(await supabaseAdmin.from("user_profiles").select("id").eq("id", i.added_by).eq("institution_id", inst).maybeSingle()); if (!t) throw new HttpError(404, "Teacher not found."); }
  return check(await supabaseAdmin.from("question_bank").insert({ institution_id: inst, grade_id: i.grade_id, subject_id: i.subject_id, chapter: i.chapter ?? "", qtype: i.qtype, marks: i.marks, difficulty: i.difficulty, added_by: i.added_by ?? actor ?? null, source: i.source }).select("id, code").single());
}
export async function setQuestionStatus(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Draft", "Under review", "Approved"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("question_bank").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Question not found.");
  return { ok: true };
}
