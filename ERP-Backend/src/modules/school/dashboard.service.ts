import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/**
 * The School Admin dashboard. Everything is counted from the school's own records. Attendance, fees and admissions have no
 * records yet (those modules are not built), so they are reported as "not recorded" instead of invented.
 */
const NOT_STAFF = ["Parent", "Student"];
const TEACHING = ["Faculty", "ClassTeacher"];

interface Year { id: string; name: string; start_date: string; end_date: string; is_current: boolean }

export async function listYears(inst: string): Promise<Year[]> {
  return check(await supabaseAdmin.from("academic_years").select("id, name, start_date, end_date, is_current").eq("institution_id", inst).order("start_date", { ascending: false })) as Year[];
}

async function pickYear(inst: string, id?: string): Promise<{ years: Year[]; year: Year | null }> {
  const years = await listYears(inst);
  const year = years.find((y) => y.id === id) ?? years.find((y) => y.is_current) ?? years[0] ?? null;
  return { years, year };
}

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const fullName = (p: { first_name?: string; last_name?: string } | null) => (p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : "");

interface Enrol {
  id: string; status: string; enrolled_on: string;
  grades: { id: string; name: string; sort_order: number } | { id: string; name: string; sort_order: number }[] | null;
  sections: { name: string } | { name: string }[] | null;
  students: {
    id: string; registration_no: string; admission_date: string | null;
    user_profiles: { first_name: string; last_name: string; phone: string | null } | { first_name: string; last_name: string; phone: string | null }[] | null;
    student_profiles: { gender: string; category: string | null } | { gender: string; category: string | null }[] | null;
    student_guardians: { relation: string; is_primary_contact: boolean | null; guardians: { full_name: string; phone: string } | { full_name: string; phone: string }[] | null }[] | null;
  } | null;
}

async function enrolments(inst: string, yearId: string): Promise<Enrol[]> {
  return check(
    await supabaseAdmin
      .from("student_enrollments")
      .select("id, status, enrolled_on, grades:grade_id(id, name, sort_order), sections:section_id(name), students:student_id(id, registration_no, admission_date, user_profiles:user_profile_id(first_name, last_name, phone), student_profiles(gender, category), student_guardians(relation, is_primary_contact, guardians:guardian_id(full_name, phone)))")
      .eq("institution_id", inst)
      .eq("academic_year_id", yearId)
      .limit(10000)
  ) as unknown as Enrol[];
}

const INACTIVE = ["Left", "Transferred"];
const flat = (e: Enrol) => {
  const s = e.students;
  const g = one(e.grades);
  const sec = one(e.sections);
  const prof = one(s?.student_profiles);
  const user = one(s?.user_profiles);
  const father = (s?.student_guardians ?? []).find((x) => x.relation === "Father") ?? (s?.student_guardians ?? []).find((x) => x.is_primary_contact) ?? (s?.student_guardians ?? [])[0];
  return {
    id: s?.id ?? e.id,
    name: fullName(user) || s?.registration_no || "Student",
    registration_no: s?.registration_no ?? "",
    class: g?.name ?? "—",
    class_id: g?.id ?? null,
    sort: g?.sort_order ?? 0,
    class_section: g ? `${g.name}${sec ? ` ${sec.name}` : ""}` : "—",
    gender: prof?.gender ?? "—",
    category: prof?.category ?? "General",
    father: one(father?.guardians)?.full_name ?? "—",
    mobile: one(father?.guardians)?.phone ?? user?.phone ?? "—",
    status: INACTIVE.includes(e.status) ? "Inactive" : e.status === "Active" ? "Active" : e.status,
    raw_status: e.status,
    admission_date: s?.admission_date ?? e.enrolled_on,
  };
};

// ═════════════ student statistics ═════════════
export async function studentStats(inst: string, q: { year?: string; tab?: string; search?: string; grade?: string; gender?: string }) {
  const { years, year } = await pickYear(inst, q.year);
  if (!year) return { years, year: null, stats: { total: 0, active: 0, inactive: 0, new_admissions: 0, boys: 0, girls: 0 }, by_class: [], by_gender: [], list: [], grades: [] };
  const [rows, gradeRows] = await Promise.all([
    enrolments(inst, year.id),
    supabaseAdmin.from("grades").select("id, name, sort_order").eq("institution_id", inst).eq("is_active", true).order("sort_order"),
  ]);
  const all = rows.map(flat);
  const isNew = (r: ReturnType<typeof flat>) => !!r.admission_date && r.admission_date >= year.start_date && r.admission_date <= year.end_date;
  const gender = (r: ReturnType<typeof flat>) => r.gender.toLowerCase();
  const stats = {
    total: all.length,
    active: all.filter((r) => r.raw_status === "Active").length,
    inactive: all.filter((r) => INACTIVE.includes(r.raw_status)).length,
    new_admissions: all.filter(isNew).length,
    boys: all.filter((r) => ["male", "boy", "m"].includes(gender(r))).length,
    girls: all.filter((r) => ["female", "girl", "f"].includes(gender(r))).length,
  };
  const tab = q.tab ?? "total";
  const inTab = all.filter((r) => (tab === "active" ? r.raw_status === "Active" : tab === "inactive" ? INACTIVE.includes(r.raw_status) : tab === "new" ? isNew(r) : true));

  const grades = (gradeRows.data ?? []) as { id: string; name: string; sort_order: number }[];
  const by_class = grades.map((g) => ({ label: g.name, value: inTab.filter((r) => r.class_id === g.id).length }));
  const cats = new Map<string, number>();
  for (const r of all) cats.set(r.category, (cats.get(r.category) ?? 0) + 1);
  const by_gender = [{ label: "Boys", value: stats.boys }, { label: "Girls", value: stats.girls }, ...[...cats.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }))];

  const term = (q.search ?? "").trim().toLowerCase();
  const list = inTab
    .filter((r) => (!q.grade || r.class_id === q.grade) && (!q.gender || gender(r) === q.gender.toLowerCase()) && (!term || `${r.name} ${r.registration_no} ${r.father}`.toLowerCase().includes(term)))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .slice(0, 500);
  return { years, year, stats, by_class, by_gender, list, grades, tab_total: inTab.length };
}

// ═════════════ staff statistics ═════════════
export async function staffStats(inst: string, q: { tab?: string; search?: string; type?: string }) {
  const rows = check(
    await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, email, phone, status, created_at, roles:role_id(name, display_name)").eq("institution_id", inst).order("first_name").limit(2000)
  ) as unknown as { id: string; first_name: string; last_name: string; email: string; phone: string | null; status: string | null; created_at: string; roles: { name: string; display_name: string } | { name: string; display_name: string }[] | null }[];
  const staff = rows
    .map((r) => ({ ...r, role: one(r.roles) }))
    .filter((r) => r.role && !NOT_STAFF.includes(r.role.name))
    .map((r) => ({ id: r.id, name: fullName(r), email: r.email, designation: r.role!.display_name, type: TEACHING.includes(r.role!.name) ? "Teaching" : "Non-teaching", mobile: r.phone ?? "—", joined: r.created_at, status: r.status === "active" || !r.status ? "Active" : "Inactive" }));
  const teaching = staff.filter((s) => s.type === "Teaching").length;
  const { count: students } = await supabaseAdmin.from("student_enrollments").select("*", { count: "exact", head: true }).eq("institution_id", inst).eq("status", "Active");
  const tab = q.tab ?? "total";
  const inTab = staff.filter((s) => (tab === "teaching" ? s.type === "Teaching" : tab === "non" ? s.type === "Non-teaching" : true));
  const byRole = new Map<string, number>();
  for (const s of inTab) byRole.set(s.designation, (byRole.get(s.designation) ?? 0) + 1);
  const term = (q.search ?? "").trim().toLowerCase();
  return {
    stats: { total: staff.length, teaching, non_teaching: staff.length - teaching, ratio: teaching ? Math.round((students ?? 0) / teaching) : null },
    by_role: [...byRole.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })),
    list: inTab.filter((s) => (!q.type || s.type === q.type) && (!term || `${s.name} ${s.designation} ${s.email}`.toLowerCase().includes(term))),
    sample_of: inTab.length,
  };
}

// ═════════════ attendance and admissions: nothing recorded yet ═════════════
export async function attendanceOverview(inst: string, yearId?: string) {
  const { years, year } = await pickYear(inst, yearId);
  const [grades, sections] = await Promise.all([
    supabaseAdmin.from("grades").select("id, name, sort_order").eq("institution_id", inst).eq("is_active", true).order("sort_order"),
    year ? supabaseAdmin.from("sections").select("id, name, capacity, grade_id, class_teacher_id").eq("institution_id", inst).eq("academic_year_id", year.id) : Promise.resolve({ data: [] }),
  ]);
  const enrol = year ? await enrolments(inst, year.id) : [];
  const gradeList = (grades.data ?? []) as { id: string; name: string }[];
  const sectionList = (sections.data ?? []) as { id: string; name: string; grade_id: string }[];
  const strength = new Map<string, number>();
  for (const e of enrol) { const sec = one(e.sections)?.name; const g = one(e.grades); if (g) strength.set(`${g.id}|${sec ?? ""}`, (strength.get(`${g.id}|${sec ?? ""}`) ?? 0) + 1); }
  return {
    years, year, recorded: false,
    classes: gradeList.map((g) => ({ label: g.name })),
    sections: sectionList.map((s) => { const g = gradeList.find((x) => x.id === s.grade_id); return { section: `${g?.name ?? ""} ${s.name}`.trim(), students: strength.get(`${s.grade_id}|${s.name}`) ?? 0 }; }),
  };
}

export async function admissionOverview(inst: string, yearId?: string) {
  const { years, year } = await pickYear(inst, yearId);
  const admitted = year ? (await enrolments(inst, year.id)).filter((e) => { const d = e.students?.admission_date ?? e.enrolled_on; return d >= year.start_date && d <= year.end_date; }).length : 0;
  return { years, year, recorded: false, funnel: { enquiries: 0, applications: 0, tested: 0, approved: 0, admitted: admitted } };
}

// ═════════════ main dashboard ═════════════
export async function overview(inst: string, yearId?: string) {
  const { years, year } = await pickYear(inst, yearId);
  if (!year) return { years, year: null, students: { total: 0, active: 0 }, staff: { total: 0 }, attention: [{ key: "year", title: "No academic year yet", sub: "Create one under Academic setup", href: "/school/setup" }] };
  const [st, sf, setup] = await Promise.all([studentStats(inst, { year: year.id }), staffStats(inst, {}), import("./school.service").then((m) => m.getSetupStatus(inst))]);
  const attention = setup.steps.filter((s) => !s.done).map((s) => ({ key: s.key, title: s.label, sub: "Setup step", href: "/school/setup" }));
  return {
    years, year,
    students: { total: st.stats.total, active: st.stats.active, boys: st.stats.boys, girls: st.stats.girls },
    staff: { total: sf.stats.total },
    by_class: st.by_class,
    attention,
  };
}

/** Only so a typo in a tab or year is a 404, not a crash. */
export function assertTab(tab: string | undefined, allowed: string[]) {
  if (tab && !allowed.includes(tab)) throw new HttpError(404, "Unknown tab.");
}
