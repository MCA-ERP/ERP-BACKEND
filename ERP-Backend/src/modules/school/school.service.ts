import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

// ─────────────────────────────────────────────
//  Setup progress
// ─────────────────────────────────────────────
export async function getSetupStatus(institutionId: string) {
  const count = async (table: string, apply?: (q: any) => any) => {
    let q = supabaseAdmin.from(table).select("*", { count: "exact", head: true }).eq("institution_id", institutionId);
    if (apply) q = apply(q);
    const { count: n, error } = await q;
    if (error) throw new HttpError(500, error.message);
    return n ?? 0;
  };

  const [years, current, grades, sections, subjects, students] = await Promise.all([
    count("academic_years"),
    count("academic_years", (q) => q.eq("is_current", true)),
    count("grades", (q) => q.eq("is_active", true)),
    count("sections"),
    count("subjects", (q) => q.eq("is_active", true)),
    count("students", (q) => q.is("deleted_at", null)),
  ]);

  const steps = [
    { key: "year", label: "Create an academic year and mark it current", done: current > 0, count: years },
    { key: "grades", label: "Add grades (classes)", done: grades > 0, count: grades },
    { key: "sections", label: "Add sections for the current year", done: sections > 0, count: sections },
    { key: "subjects", label: "Add subjects", done: subjects > 0, count: subjects },
    { key: "students", label: "Enrol your first student", done: students > 0, count: students },
  ];
  return { steps, complete: steps.every((s) => s.done) };
}

// ─────────────────────────────────────────────
//  Academic years
// ─────────────────────────────────────────────
export async function listYears(institutionId: string) {
  return check(
    await supabaseAdmin.from("academic_years").select("*").eq("institution_id", institutionId).order("start_date", { ascending: false })
  );
}

export async function createYear(
  institutionId: string,
  input: { name: string; start_date: string; end_date: string; is_current?: boolean }
) {
  if (input.end_date <= input.start_date) throw new HttpError(400, "The end date must be after the start date.");
  const { is_current, ...fields } = input;
  const year = check(
    await supabaseAdmin.from("academic_years").insert({ ...fields, institution_id: institutionId, is_current: false }).select().single()
  ) as { id: string };

  // the first year of a school becomes current automatically
  const existing = await supabaseAdmin
    .from("academic_years")
    .select("*", { count: "exact", head: true })
    .eq("institution_id", institutionId)
    .eq("is_current", true);
  if (is_current || (existing.count ?? 0) === 0) return setCurrentYear(institutionId, year.id);
  return year;
}

export async function setCurrentYear(institutionId: string, yearId: string) {
  const year = check(
    await supabaseAdmin.from("academic_years").select("id").eq("id", yearId).eq("institution_id", institutionId).maybeSingle()
  );
  if (!year) throw new HttpError(404, "Academic year not found.");

  check(await supabaseAdmin.from("academic_years").update({ is_current: false }).eq("institution_id", institutionId).eq("is_current", true));
  return check(
    await supabaseAdmin.from("academic_years").update({ is_current: true }).eq("id", yearId).select().single()
  );
}

export async function updateYear(institutionId: string, yearId: string, patch: { name?: string; start_date?: string; end_date?: string; is_locked?: boolean }) {
  const data = check(
    await supabaseAdmin.from("academic_years").update(patch).eq("id", yearId).eq("institution_id", institutionId).select().maybeSingle()
  );
  if (!data) throw new HttpError(404, "Academic year not found.");
  return data;
}

// ─────────────────────────────────────────────
//  Grades
// ─────────────────────────────────────────────
export async function listGrades(institutionId: string) {
  return check(
    await supabaseAdmin.from("grades").select("*").eq("institution_id", institutionId).order("sort_order")
  );
}

export async function createGrade(institutionId: string, input: { code: string; name: string; sort_order?: number }) {
  let sort = input.sort_order;
  if (sort === undefined) {
    const last = check(
      await supabaseAdmin.from("grades").select("sort_order").eq("institution_id", institutionId).order("sort_order", { ascending: false }).limit(1)
    ) as { sort_order: number }[];
    sort = (last[0]?.sort_order ?? 0) + 1;
  }
  return check(await supabaseAdmin.from("grades").insert({ ...input, sort_order: sort, institution_id: institutionId }).select().single());
}

export async function updateGrade(institutionId: string, id: string, patch: { name?: string; sort_order?: number; is_active?: boolean }) {
  const data = check(
    await supabaseAdmin.from("grades").update(patch).eq("id", id).eq("institution_id", institutionId).select().maybeSingle()
  );
  if (!data) throw new HttpError(404, "Grade not found.");
  return data;
}

/** LKG, UKG and Class 1-12; existing grades are left untouched. */
export async function addDefaultGrades(institutionId: string) {
  const rows = [
    { code: "LKG", name: "LKG", sort_order: 1 },
    { code: "UKG", name: "UKG", sort_order: 2 },
    ...Array.from({ length: 12 }, (_, i) => ({ code: `G${i + 1}`, name: `Class ${i + 1}`, sort_order: i + 3 })),
  ].map((r) => ({ ...r, institution_id: institutionId }));
  check(await supabaseAdmin.from("grades").upsert(rows, { onConflict: "institution_id,code", ignoreDuplicates: true }).select("id"));
  return listGrades(institutionId);
}

// ─────────────────────────────────────────────
//  Sections
// ─────────────────────────────────────────────
export async function listSections(institutionId: string, yearId?: string) {
  let q = supabaseAdmin
    .from("sections")
    .select("*, grades:grade_id(name, sort_order), student_enrollments(count)")
    .eq("institution_id", institutionId);
  if (yearId) q = q.eq("academic_year_id", yearId);
  const rows = check(await q) as any[];
  return rows
    .map((r) => ({
      id: r.id,
      grade_id: r.grade_id,
      grade_name: r.grades?.name ?? "",
      grade_order: r.grades?.sort_order ?? 0,
      academic_year_id: r.academic_year_id,
      name: r.name,
      capacity: r.capacity,
      enrolled: r.student_enrollments?.[0]?.count ?? 0,
    }))
    .sort((a, b) => a.grade_order - b.grade_order || a.name.localeCompare(b.name));
}

async function ownedGradeAndYear(institutionId: string, gradeId: string, yearId: string) {
  const [g, y] = await Promise.all([
    supabaseAdmin.from("grades").select("id").eq("id", gradeId).eq("institution_id", institutionId).maybeSingle(),
    supabaseAdmin.from("academic_years").select("id").eq("id", yearId).eq("institution_id", institutionId).maybeSingle(),
  ]);
  if (!check(g)) throw new HttpError(400, "Grade not found for this school.");
  if (!check(y)) throw new HttpError(400, "Academic year not found for this school.");
}

export async function createSection(
  institutionId: string,
  input: { grade_id: string; academic_year_id: string; name: string; capacity?: number }
) {
  await ownedGradeAndYear(institutionId, input.grade_id, input.academic_year_id);
  return check(await supabaseAdmin.from("sections").insert({ ...input, institution_id: institutionId }).select().single());
}

export async function updateSection(institutionId: string, id: string, patch: { name?: string; capacity?: number }) {
  const data = check(
    await supabaseAdmin.from("sections").update(patch).eq("id", id).eq("institution_id", institutionId).select().maybeSingle()
  );
  if (!data) throw new HttpError(404, "Section not found.");
  return data;
}

export async function deleteSection(institutionId: string, id: string) {
  const { count } = await supabaseAdmin
    .from("student_enrollments")
    .select("*", { count: "exact", head: true })
    .eq("section_id", id)
    .eq("institution_id", institutionId);
  if ((count ?? 0) > 0) throw new HttpError(409, "This section has students enrolled. Move them first.");
  check(await supabaseAdmin.from("sections").delete().eq("id", id).eq("institution_id", institutionId).select("id"));
  return { success: true };
}

/** Add the given section names (e.g. A, B) to every active grade for a year. */
export async function addDefaultSections(institutionId: string, yearId: string, names: string[]) {
  const [grades] = await Promise.all([listGrades(institutionId) as Promise<{ id: string; is_active: boolean }[]>]);
  const year = check(
    await supabaseAdmin.from("academic_years").select("id").eq("id", yearId).eq("institution_id", institutionId).maybeSingle()
  );
  if (!year) throw new HttpError(400, "Academic year not found for this school.");
  if (!grades.length) throw new HttpError(400, "Add grades first.");

  const rows = grades
    .filter((g) => g.is_active)
    .flatMap((g) => names.map((name) => ({ institution_id: institutionId, grade_id: g.id, academic_year_id: yearId, name })));
  check(await supabaseAdmin.from("sections").upsert(rows, { onConflict: "grade_id,academic_year_id,name", ignoreDuplicates: true }).select("id"));
  return listSections(institutionId, yearId);
}

// ─────────────────────────────────────────────
//  Subjects
// ─────────────────────────────────────────────
export async function listSubjects(institutionId: string) {
  return check(await supabaseAdmin.from("subjects").select("*").eq("institution_id", institutionId).order("name"));
}

export async function createSubject(institutionId: string, input: { code: string; name: string }) {
  return check(await supabaseAdmin.from("subjects").insert({ ...input, institution_id: institutionId }).select().single());
}

export async function updateSubject(institutionId: string, id: string, patch: { name?: string; is_active?: boolean }) {
  const data = check(
    await supabaseAdmin.from("subjects").update(patch).eq("id", id).eq("institution_id", institutionId).select().maybeSingle()
  );
  if (!data) throw new HttpError(404, "Subject not found.");
  return data;
}

export async function addDefaultSubjects(institutionId: string) {
  const rows = [
    ["ENG", "English"], ["HIN", "Hindi"], ["KAN", "Kannada"], ["MAT", "Mathematics"], ["SCI", "Science"],
    ["SOC", "Social Science"], ["CMP", "Computer Science"], ["PED", "Physical Education"],
  ].map(([code, name]) => ({ institution_id: institutionId, code, name }));
  check(await supabaseAdmin.from("subjects").upsert(rows, { onConflict: "institution_id,code", ignoreDuplicates: true }).select("id"));
  return listSubjects(institutionId);
}
