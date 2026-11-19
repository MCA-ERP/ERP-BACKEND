import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** Classes, sections, subjects, subject allocation, curriculum, lesson plans and the academic calendar. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const txt = (n: number) => z.string().trim().max(n);
const blank = <T>(v: T | "" | undefined) => (v === "" || v === undefined ? null : v);
const uid = z.string().uuid();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const STAGES = ["Pre-primary", "Primary", "Middle", "Secondary", "Senior secondary"];

async function currentYear(inst: string) {
  const y = check(await supabaseAdmin.from("academic_years").select("id, name, start_date, end_date, working_days").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { id: string; name: string; start_date: string; end_date: string; working_days: number | null } | null;
  return y;
}
const short = (name: string) => name.replace(/^Class\s+/i, "");

// ═════════════ classes ═════════════
export async function listClasses(inst: string) {
  const y = await currentYear(inst);
  const [g, s, e, c] = await Promise.all([
    supabaseAdmin.from("grades").select("id, code, name, sort_order, stage, campus_id, is_active").eq("institution_id", inst).order("sort_order"),
    y ? supabaseAdmin.from("sections").select("id, grade_id").eq("institution_id", inst).eq("academic_year_id", y.id) : Promise.resolve({ data: [], error: null }),
    y ? supabaseAdmin.from("student_enrollments").select("grade_id").eq("institution_id", inst).eq("academic_year_id", y.id).limit(100000) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("campuses").select("id, name").eq("institution_id", inst),
  ]);
  const secs = (check(s) ?? []) as { grade_id: string }[];
  const enr = (check(e) ?? []) as { grade_id: string }[];
  const camps = new Map(((check(c) ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  return {
    items: (check(g) as unknown as { id: string; name: string; stage: string | null; campus_id: string | null; is_active: boolean }[]).map((r) => ({ id: r.id, name: r.name, stage: r.stage ?? "", campus_id: r.campus_id, campus: r.campus_id ? camps.get(r.campus_id) ?? "" : "", sections: secs.filter((x) => x.grade_id === r.id).length, students: enr.filter((x) => x.grade_id === r.id).length, status: r.is_active ? "Active" : "Inactive" })),
    campuses: [...camps.entries()].map(([id, name]) => ({ id, name })),
    stages: STAGES,
  };
}

const letters = (n: number, from = 0) => Array.from({ length: n }, (_, i) => String.fromCharCode(65 + from + i));
async function addSections(inst: string, gradeId: string, yearId: string, names: string[], capacity: number, campus: string | null) {
  if (!names.length) return;
  check(await supabaseAdmin.from("sections").insert(names.map((name) => ({ institution_id: inst, grade_id: gradeId, academic_year_id: yearId, name, capacity, campus_id: campus }))).select("id"));
}

export async function addClass(inst: string, input: unknown) {
  const i = z.object({ name: txt(100).min(1, "Enter the class name."), stage: z.enum(["Pre-primary", "Primary", "Middle", "Secondary", "Senior secondary"]), sections: z.number().int().min(0).max(12), students: z.number().int().min(0).max(5000).optional(), campus_id: uid.nullable().optional() }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("grades").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "A class with that name already exists.");
  const last = check(await supabaseAdmin.from("grades").select("sort_order").eq("institution_id", inst).order("sort_order", { ascending: false }).limit(1)) as { sort_order: number }[];
  const code = i.name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 16) || "CLS";
  const g = check(await supabaseAdmin.from("grades").insert({ institution_id: inst, code: `${code}-${Date.now() % 10000}`, name: i.name, sort_order: (last[0]?.sort_order ?? 0) + 1, stage: i.stage, campus_id: i.campus_id ?? null }).select("id").single()) as { id: string };
  const y = await currentYear(inst);
  if (y && i.sections) await addSections(inst, g.id, y.id, letters(i.sections), i.students && i.sections ? Math.max(1, Math.ceil(i.students / i.sections)) : 40, i.campus_id ?? null);
  return { id: g.id };
}

export async function updateClass(inst: string, id: string, input: unknown) {
  const i = z.object({ name: txt(100).min(1), stage: z.enum(["Pre-primary", "Primary", "Middle", "Secondary", "Senior secondary"]), sections: z.number().int().min(0).max(12).optional(), campus_id: uid.nullable().optional(), status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const g = check(await supabaseAdmin.from("grades").select("id").eq("id", id).eq("institution_id", inst).maybeSingle());
  if (!g) throw new HttpError(404, "Class not found.");
  const dup = check(await supabaseAdmin.from("grades").select("id").eq("institution_id", inst).ilike("name", i.name).neq("id", id)) as unknown[];
  if (dup.length) throw new HttpError(409, "A class with that name already exists.");
  check(await supabaseAdmin.from("grades").update({ name: i.name, stage: i.stage, campus_id: i.campus_id ?? null, is_active: i.status === "Active" }).eq("id", id).select("id"));
  const y = await currentYear(inst);
  if (y && i.sections !== undefined) {
    const have = (check(await supabaseAdmin.from("sections").select("name").eq("institution_id", inst).eq("grade_id", id).eq("academic_year_id", y.id)) as { name: string }[]).length;
    if (i.sections < have) throw new HttpError(409, "To remove a section, open Section Management.");
    await addSections(inst, id, y.id, letters(i.sections - have, have), 40, i.campus_id ?? null);
  }
  return { ok: true };
}

// ═════════════ sections ═════════════
export async function listSectionRows(inst: string) {
  const y = await currentYear(inst);
  if (!y) return { items: [] };
  const [s, e] = await Promise.all([
    supabaseAdmin.from("sections").select("id, name, room, is_active, capacity, grade_id, class_teacher_id, grades:grade_id(name, sort_order), teacher:class_teacher_id(first_name, last_name)").eq("institution_id", inst).eq("academic_year_id", y.id),
    supabaseAdmin.from("student_enrollments").select("section_id").eq("institution_id", inst).eq("academic_year_id", y.id).limit(100000),
  ]);
  const enr = (check(e) ?? []) as { section_id: string | null }[];
  type R = { id: string; name: string; room: string | null; is_active: boolean; capacity: number; grade_id: string; class_teacher_id: string | null; grades: { name: string; sort_order: number } | { name: string; sort_order: number }[] | null; teacher: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null };
  const rows = (check(s) as unknown as R[]).map((r) => { const g = one(r.grades); const t = one(r.teacher); return { id: r.id, grade_id: r.grade_id, label: `${g?.name ?? ""} ${r.name}`.trim(), name: r.name, order: g?.sort_order ?? 0, teacher_id: r.class_teacher_id, teacher: t ? `${t.first_name} ${t.last_name}`.trim() : "", room: r.room ?? "", capacity: r.capacity, students: enr.filter((x) => x.section_id === r.id).length, status: r.is_active ? "Active" : "Inactive" }; });
  return { items: rows.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)) };
}

export async function addSectionRow(inst: string, input: unknown) {
  const i = z.object({ grade_id: uid, name: txt(50).min(1, "Enter the section name."), class_teacher_id: uid.nullable().optional(), room: txt(30).optional(), capacity: z.number().int().min(1).max(500).optional() }).strict().parse(input);
  const y = await currentYear(inst);
  if (!y) throw new HttpError(409, "Activate an academic year first.");
  const g = check(await supabaseAdmin.from("grades").select("id").eq("id", i.grade_id).eq("institution_id", inst).maybeSingle());
  if (!g) throw new HttpError(404, "Class not found.");
  const dup = check(await supabaseAdmin.from("sections").select("id").eq("grade_id", i.grade_id).eq("academic_year_id", y.id).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That class already has a section with this name.");
  if (i.class_teacher_id) await teacherOk(inst, i.class_teacher_id);
  return check(await supabaseAdmin.from("sections").insert({ institution_id: inst, grade_id: i.grade_id, academic_year_id: y.id, name: i.name, class_teacher_id: i.class_teacher_id ?? null, room: blank(i.room), capacity: i.capacity ?? 40 }).select("id").single());
}

async function teacherOk(inst: string, id: string) {
  const t = check(await supabaseAdmin.from("user_profiles").select("id").eq("id", id).eq("institution_id", inst).maybeSingle());
  if (!t) throw new HttpError(404, "Teacher not found.");
}

export async function updateSectionRow(inst: string, id: string, input: unknown) {
  const i = z.object({ class_teacher_id: uid.nullable().optional(), room: txt(30).optional(), status: z.enum(["Active", "Inactive"]).optional() }).strict().parse(input);
  const s = check(await supabaseAdmin.from("sections").select("id").eq("id", id).eq("institution_id", inst).maybeSingle());
  if (!s) throw new HttpError(404, "Section not found.");
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (i.class_teacher_id !== undefined) { if (i.class_teacher_id) await teacherOk(inst, i.class_teacher_id); patch.class_teacher_id = i.class_teacher_id; }
  if (i.room !== undefined) patch.room = blank(i.room);
  if (i.status) patch.is_active = i.status === "Active";
  check(await supabaseAdmin.from("sections").update(patch).eq("id", id).select("id"));
  return { ok: true };
}

// ═════════════ subjects ═════════════
export async function listSubjectRows(inst: string) {
  const [s, gs, g] = await Promise.all([
    supabaseAdmin.from("subjects").select("id, code, name, category, subject_type, is_active").eq("institution_id", inst).order("name"),
    supabaseAdmin.from("grade_subjects").select("grade_id, subject_id, grades:grade_id!inner(institution_id)").eq("grades.institution_id", inst).limit(20000),
    supabaseAdmin.from("grades").select("id, name, sort_order").eq("institution_id", inst).order("sort_order"),
  ]);
  const links = (check(gs) ?? []) as { grade_id: string; subject_id: string }[];
  const grades = (check(g) ?? []) as { id: string; name: string; sort_order: number }[];
  return {
    grades: grades.map((x) => ({ id: x.id, name: x.name })),
    items: (check(s) as unknown as { id: string; code: string; name: string; category: string | null; subject_type: string; is_active: boolean }[]).map((r) => {
      const mine = grades.filter((x) => links.some((l) => l.subject_id === r.id && l.grade_id === x.id));
      const classes = mine.length ? (mine.length === 1 ? short(mine[0].name) : `${short(mine[0].name)} – ${short(mine[mine.length - 1].name)}`) : "";
      return { id: r.id, name: r.name, code: r.code, category: r.category ?? "", subject_type: r.subject_type, classes, status: r.is_active ? "Active" : "Inactive" };
    }),
  };
}

export async function addSubjectRow(inst: string, input: unknown) {
  const i = z.object({ name: txt(150).min(2, "Enter the subject."), code: txt(30).min(2, "Enter the code.").transform((v) => v.toUpperCase()), category: txt(30).optional(), subject_type: z.enum(["Theory", "Practical", "Theory + practical"]).default("Theory"), grade_ids: z.array(uid).max(60).optional() }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("subjects").select("id").eq("institution_id", inst).eq("code", i.code)) as unknown[];
  if (dup.length) throw new HttpError(409, "A subject with that code already exists.");
  const s = check(await supabaseAdmin.from("subjects").insert({ institution_id: inst, code: i.code, name: i.name, category: blank(i.category), subject_type: i.subject_type }).select("id").single()) as { id: string };
  if (i.grade_ids?.length) {
    const ok = (check(await supabaseAdmin.from("grades").select("id").eq("institution_id", inst).in("id", i.grade_ids)) as { id: string }[]).map((x) => x.id);
    if (ok.length) check(await supabaseAdmin.from("grade_subjects").insert(ok.map((grade_id) => ({ grade_id, subject_id: s.id }))).select("grade_id"));
  }
  return { id: s.id };
}

export async function subjectGrid(inst: string) {
  const [g, s, gs] = await Promise.all([
    supabaseAdmin.from("grades").select("id, name").eq("institution_id", inst).eq("is_active", true).order("sort_order"),
    supabaseAdmin.from("subjects").select("id, name").eq("institution_id", inst).eq("is_active", true).order("name"),
    supabaseAdmin.from("grade_subjects").select("grade_id, subject_id, grades:grade_id!inner(institution_id)").eq("grades.institution_id", inst).limit(20000),
  ]);
  return { grades: check(g) as unknown[], subjects: check(s) as unknown[], pairs: ((check(gs) ?? []) as { grade_id: string; subject_id: string }[]).map((p) => `${p.grade_id}:${p.subject_id}`) };
}

export async function saveSubjectGrid(inst: string, input: unknown) {
  const { pairs } = z.object({ pairs: z.array(z.string().regex(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/)).max(5000) }).strict().parse(input);
  const grid = await subjectGrid(inst);
  const gset = new Set((grid.grades as { id: string }[]).map((x) => x.id));
  const sset = new Set((grid.subjects as { id: string }[]).map((x) => x.id));
  const want = new Set(pairs.filter((p) => { const [a, b] = p.split(":"); return gset.has(a) && sset.has(b); }));
  const have = new Set(grid.pairs);
  const add = [...want].filter((p) => !have.has(p)).map((p) => { const [grade_id, subject_id] = p.split(":"); return { grade_id, subject_id }; });
  const del = [...have].filter((p) => !want.has(p) && gset.has(p.split(":")[0]) && sset.has(p.split(":")[1]));
  if (add.length) check(await supabaseAdmin.from("grade_subjects").insert(add).select("grade_id"));
  for (const p of del) { const [g, s] = p.split(":"); check(await supabaseAdmin.from("grade_subjects").delete().eq("grade_id", g).eq("subject_id", s).select("grade_id")); }
  return { added: add.length, removed: del.length };
}

// ═════════════ teacher-wise subjects ═════════════
export async function teacherSubjects(inst: string) {
  const rows = check(await supabaseAdmin.from("teacher_subjects").select("id, teacher_id, periods, section_id, subjects:subject_id(name), sections:section_id(name, grades:grade_id(name)), teacher:teacher_id(first_name, last_name, designation)").eq("institution_id", inst).limit(5000)) as unknown as { id: string; teacher_id: string; periods: number; section_id: string | null; subjects: { name: string } | { name: string }[] | null; sections: { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null; teacher: { first_name: string; last_name: string; designation: string | null } | { first_name: string; last_name: string; designation: string | null }[] | null }[];
  const by = new Map<string, { teacher_id: string; name: string; designation: string; subjects: string[]; classes: string[]; periods: number; assignments: { id: string; subject: string; section: string; periods: number }[] }>();
  for (const r of rows) {
    const t = one(r.teacher); const sec = one(r.sections);
    const label = sec ? `${one(sec.grades)?.name ?? ""} ${sec.name}`.trim() : "";
    const cur = by.get(r.teacher_id) ?? { teacher_id: r.teacher_id, name: t ? `${t.first_name} ${t.last_name}`.trim() : "", designation: t?.designation ?? "", subjects: [], classes: [], periods: 0, assignments: [] };
    const sub = one(r.subjects)?.name ?? "";
    if (sub && !cur.subjects.includes(sub)) cur.subjects.push(sub);
    if (label && !cur.classes.includes(label)) cur.classes.push(label);
    cur.periods += r.periods;
    cur.assignments.push({ id: r.id, subject: sub, section: label, periods: r.periods });
    by.set(r.teacher_id, cur);
  }
  return { items: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
export async function assignTeacher(inst: string, input: unknown) {
  const i = z.object({ teacher_id: uid, subject_id: uid, section_id: uid.nullable().optional(), periods: z.number().int().min(1).max(60) }).strict().parse(input);
  await teacherOk(inst, i.teacher_id);
  const s = check(await supabaseAdmin.from("subjects").select("id").eq("id", i.subject_id).eq("institution_id", inst).maybeSingle());
  if (!s) throw new HttpError(404, "Subject not found.");
  if (i.section_id) { const c = check(await supabaseAdmin.from("sections").select("id").eq("id", i.section_id).eq("institution_id", inst).maybeSingle()); if (!c) throw new HttpError(404, "Section not found."); }
  const dup = check(await supabaseAdmin.from("teacher_subjects").select("id").eq("teacher_id", i.teacher_id).eq("subject_id", i.subject_id).filter("section_id", i.section_id ? "eq" : "is", i.section_id ?? null)) as unknown[];
  if (dup.length) throw new HttpError(409, "That teacher already has this subject for this class.");
  return check(await supabaseAdmin.from("teacher_subjects").insert({ institution_id: inst, teacher_id: i.teacher_id, subject_id: i.subject_id, section_id: i.section_id ?? null, periods: i.periods }).select("id").single());
}
export async function removeTeacherSubject(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("teacher_subjects").delete().eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found.");
  return { ok: true };
}

// ═════════════ curriculum ═════════════
const CST = ["Not started", "In progress", "Completed"];
export async function listCurriculum(inst: string) {
  const rows = check(await supabaseAdmin.from("curriculum_chapters").select("id, chapter, periods, objective, planned_month, status, grade_id, subject_id, grades:grade_id(name, sort_order), subjects:subject_id(name)").eq("institution_id", inst).order("created_at", { ascending: false }).limit(3000)) as unknown as { id: string; chapter: string; periods: number; objective: string | null; planned_month: string | null; status: string; grade_id: string; subject_id: string; grades: { name: string; sort_order: number } | { name: string; sort_order: number }[] | null; subjects: { name: string } | { name: string }[] | null }[];
  return { statuses: CST, items: rows.map((r) => ({ id: r.id, class_label: one(r.grades)?.name ?? "", subject: one(r.subjects)?.name ?? "", chapter: r.chapter, periods: r.periods, objective: r.objective ?? "", month: r.planned_month ?? "", status: r.status })) };
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export async function addChapter(inst: string, input: unknown) {
  const i = z.object({ grade_id: uid, subject_id: uid, chapter: txt(200).min(2, "Enter the chapter."), periods: z.number().int().min(1).max(200), objective: txt(300).optional(), planned_month: z.enum(MONTHS as [string, ...string[]]).optional() }).strict().parse(input);
  const [g, s] = await Promise.all([supabaseAdmin.from("grades").select("id").eq("id", i.grade_id).eq("institution_id", inst).maybeSingle(), supabaseAdmin.from("subjects").select("id").eq("id", i.subject_id).eq("institution_id", inst).maybeSingle()]);
  if (!check(g) || !check(s)) throw new HttpError(404, "Class or subject not found.");
  return check(await supabaseAdmin.from("curriculum_chapters").insert({ institution_id: inst, grade_id: i.grade_id, subject_id: i.subject_id, chapter: i.chapter, periods: i.periods, objective: blank(i.objective), planned_month: i.planned_month ?? null }).select("id").single());
}
export async function setChapterStatus(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Not started", "In progress", "Completed"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("curriculum_chapters").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found.");
  return { ok: true };
}

// ═════════════ lesson plans ═════════════
const LST = ["Draft", "Submitted", "Approved", "Returned"];
const weekLabel = (d: string) => { const x = new Date(d + "T00:00:00Z"); return `Week ${Math.ceil(x.getUTCDate() / 7)}, ${MONTHS[x.getUTCMonth()]}`; };
export async function listLessonPlans(inst: string) {
  const rows = check(await supabaseAdmin.from("lesson_plans").select("id, topic, week_of, periods, progress, status, teacher:teacher_id(first_name, last_name), subjects:subject_id(name), sections:section_id(name, grades:grade_id(name))").eq("institution_id", inst).order("week_of", { ascending: false }).order("created_at", { ascending: false }).limit(3000)) as unknown as { id: string; topic: string; week_of: string; periods: number; progress: number; status: string; teacher: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null; subjects: { name: string } | { name: string }[] | null; sections: { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null }[];
  return { statuses: LST, items: rows.map((r) => { const t = one(r.teacher); const s = one(r.sections); return { id: r.id, teacher: t ? `${t.first_name} ${t.last_name}`.trim() : "", class_label: s ? `${one(s.grades)?.name ?? ""} ${s.name}`.trim() : "", subject: one(r.subjects)?.name ?? "", topic: r.topic, week: weekLabel(r.week_of), week_of: r.week_of, periods: r.periods, progress: r.progress, status: r.status }; }) };
}
export async function addLessonPlan(inst: string, input: unknown) {
  const i = z.object({ teacher_id: uid, section_id: uid, subject_id: uid, topic: txt(200).min(2, "Enter the topic."), week_of: iso, periods: z.number().int().min(1).max(60) }).strict().parse(input);
  await teacherOk(inst, i.teacher_id);
  const [s, b] = await Promise.all([supabaseAdmin.from("sections").select("id").eq("id", i.section_id).eq("institution_id", inst).maybeSingle(), supabaseAdmin.from("subjects").select("id").eq("id", i.subject_id).eq("institution_id", inst).maybeSingle()]);
  if (!check(s) || !check(b)) throw new HttpError(404, "Section or subject not found.");
  return check(await supabaseAdmin.from("lesson_plans").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function updateLessonPlan(inst: string, id: string, input: unknown) {
  const i = z.object({ status: z.enum(["Draft", "Submitted", "Approved", "Returned"]).optional(), progress: z.number().int().min(0).max(100).optional() }).strict().parse(input);
  if (i.status === undefined && i.progress === undefined) throw new HttpError(400, "Nothing to change.");
  const r = check(await supabaseAdmin.from("lesson_plans").update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found.");
  return { ok: true };
}

// ═════════════ calendar ═════════════
export async function listCalendar(inst: string) {
  const [e, s] = await Promise.all([
    supabaseAdmin.from("calendar_events").select("id, title, event_date, end_date, kind, audience, note, published").eq("institution_id", inst).order("event_date").limit(2000),
    getCalendarSettings(inst),
  ]);
  return { items: check(e) as unknown[], settings: s };
}
export async function addCalendarEvent(inst: string, input: unknown) {
  const i = z.object({ title: txt(200).min(2, "Enter the name."), event_date: iso, end_date: iso.nullable().optional(), kind: z.enum(["Holiday", "Exam", "PTM", "Event", "Sports", "Fee due", "Staff"]), audience: txt(60).optional(), note: txt(300).optional(), published: z.boolean().optional() }).strict().parse(input);
  if (i.end_date && i.end_date < i.event_date) throw new HttpError(400, "The end date is before the start.");
  return check(await supabaseAdmin.from("calendar_events").insert({ institution_id: inst, title: i.title, event_date: i.event_date, end_date: i.end_date || null, kind: i.kind, audience: i.audience || "Everyone", note: blank(i.note), published: i.published ?? true }).select("id").single());
}
export async function setEventPublished(inst: string, id: string, input: unknown) {
  const { published } = z.object({ published: z.boolean() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("calendar_events").update({ published }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found.");
  return { ok: true };
}
export async function deleteCalendarEvent(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("calendar_events").delete().eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found.");
  return { ok: true };
}

export async function getCalendarSettings(inst: string) {
  const s = check(await supabaseAdmin.from("calendar_settings").select("school_week, saturday_hours, show_holidays_in_app").eq("institution_id", inst).maybeSingle()) as { school_week: string; saturday_hours: string; show_holidays_in_app: boolean } | null;
  const set = s ?? { school_week: "Monday – Saturday", saturday_hours: "Full day", show_holidays_in_app: true };
  const y = await currentYear(inst);
  const hol = (check(await supabaseAdmin.from("calendar_events").select("event_date, end_date").eq("institution_id", inst).eq("kind", "Holiday")) ?? []) as { event_date: string; end_date: string | null }[];
  const off = new Set<string>();
  for (const h of hol) { for (let d = new Date(h.event_date + "T00:00:00Z"), e = new Date((h.end_date ?? h.event_date) + "T00:00:00Z"); d <= e; d = new Date(d.getTime() + 86400000)) off.add(d.toISOString().slice(0, 10)); }
  let done = 0;
  if (y) {
    const today = new Date().toISOString().slice(0, 10);
    const stop = today < y.end_date ? today : y.end_date;
    for (let d = new Date(y.start_date + "T00:00:00Z"); d.toISOString().slice(0, 10) <= stop; d = new Date(d.getTime() + 86400000)) {
      const wd = d.getUTCDay();
      if (wd === 0 || (wd === 6 && (set.school_week === "Monday – Friday" || set.saturday_hours === "Off")) || off.has(d.toISOString().slice(0, 10))) continue;
      done++;
    }
  }
  return { ...set, planned: y?.working_days ?? null, done, year: y?.name ?? "" };
}
export async function saveCalendarSettings(inst: string, input: unknown) {
  const i = z.object({ school_week: z.enum(["Monday – Saturday", "Monday – Friday"]), saturday_hours: z.enum(["Full day", "Half day (till 12:30)", "Off"]), show_holidays_in_app: z.boolean(), working_days: z.number().int().min(1).max(366).nullable().optional() }).strict().parse(input);
  check(await supabaseAdmin.from("calendar_settings").upsert({ institution_id: inst, school_week: i.school_week, saturday_hours: i.saturday_hours, show_holidays_in_app: i.show_holidays_in_app }, { onConflict: "institution_id" }).select("institution_id"));
  if (i.working_days !== undefined) { const y = await currentYear(inst); if (y) check(await supabaseAdmin.from("academic_years").update({ working_days: i.working_days }).eq("id", y.id).select("id")); }
  return getCalendarSettings(inst);
}
