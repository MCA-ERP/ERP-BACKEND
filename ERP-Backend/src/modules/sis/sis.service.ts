import { supabaseAdmin } from "../../../db/client";
import { HttpError } from "../../lib/http-error";
import { safeSearch } from "../../lib/query";
import { loadSchoolAccess } from "../../lib/entitlements";

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────
export interface EnrollStudentInput {
  first_name: string;
  last_name: string;
  gender?: string;
  date_of_birth?: string;
  grade: string;
  section?: string;
  roll_no?: string;
  guardian_name?: string;
  guardian_phone?: string;
  guardian_relation?: string;
  address?: string;
}

/** Shape consumed by the current dashboard UI. */
export interface StudentRecord {
  id: string;
  registration_no: string;
  student_id: string;
  roll_no: string;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  gender: string;
  date_of_birth: string;
  program: string;
  department: string;
  semester: number;
  status: string;
  cgpa: string;
  attendance: string;
  guardian: { name: string; phone: string; relation: string };
  address: string;
  school_name: string;
  school_code: string;
  created_at: string;
}

const STUDENT_SELECT = `
  id, registration_no, roll_no, first_name, last_name, gender, date_of_birth, status, created_at,
  institutions:institution_id(name, code),
  student_enrollments(roll_no, enrolled_on, grades:grade_id(name, sort_order), sections:section_id(name)),
  student_guardians(relation, is_primary_contact, guardians:guardian_id(full_name, phone))`;

function toRecord(s: any): StudentRecord {
  const enrollments: any[] = [...(s.student_enrollments ?? [])].sort((a, b) =>
    String(b.enrolled_on).localeCompare(String(a.enrolled_on))
  );
  const current = enrollments[0];
  const links: any[] = s.student_guardians ?? [];
  const link = links.find((l) => l.is_primary_contact) ?? links[0];

  return {
    id: s.id,
    registration_no: s.registration_no,
    student_id: s.registration_no,
    roll_no: current?.roll_no ?? s.roll_no ?? "",
    name: `${s.first_name} ${s.last_name}`.trim(),
    first_name: s.first_name,
    last_name: s.last_name,
    email: "",
    phone: "",
    gender: s.gender ?? "",
    date_of_birth: s.date_of_birth ?? "",
    program: current
      ? `${current.grades?.name ?? "Unassigned"}${current.sections?.name ? ` (Section ${current.sections.name})` : ""}`
      : "Unassigned",
    department: s.institutions?.name ?? "",
    semester: current?.grades?.sort_order ?? 0,
    status: s.status,
    cgpa: "—",
    attendance: "—",
    guardian: {
      name: link?.guardians?.full_name ?? "",
      phone: link?.guardians?.phone ?? "",
      relation: link?.relation ?? "",
    },
    address: "",
    school_name: s.institutions?.name ?? "",
    school_code: s.institutions?.code ?? "",
    created_at: s.created_at,
  };
}

// ─────────────────────────────────────────────
//  Stats
// ─────────────────────────────────────────────
export async function getSisStats(institutionId: string | null) {
  const count = async (table: string, apply?: (q: any) => any) => {
    let q = supabaseAdmin.from(table).select("*", { count: "exact", head: true });
    if (institutionId) q = q.eq("institution_id", institutionId);
    if (apply) q = apply(q);
    const { count: n, error } = await q;
    if (error) throw new HttpError(500, error.message);
    return n ?? 0;
  };

  const [students, grades, sections, faculty] = await Promise.all([
    count("students", (q) => q.is("deleted_at", null).eq("status", "Enrolled")),
    count("grades", (q) => q.eq("is_active", true)),
    count("sections"),
    // user_profiles reference roles by id; resolve Faculty role first
    (async () => {
      const { data: role } = await supabaseAdmin.from("roles").select("id").eq("name", "Faculty").maybeSingle();
      if (!role) return 0;
      return count("user_profiles", (q) => q.eq("role_id", role.id).eq("status", "active"));
    })(),
  ]);

  return {
    totalStudents: students,
    totalFaculty: faculty,
    totalGrades: grades,
    totalSections: sections,
    // legacy keys still read by the current dashboard
    totalDepartments: grades,
    totalPrograms: sections,
    activeBatches: sections,
    attendanceRate: "N/A",
  };
}

// ─────────────────────────────────────────────
//  Directory
// ─────────────────────────────────────────────
export async function listStudents(
  institutionId: string | null,
  opts: { search?: string; status?: string; limit?: number; offset?: number }
) {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);

  let q = supabaseAdmin
    .from("students")
    .select(STUDENT_SELECT, { count: "exact" })
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (institutionId) q = q.eq("institution_id", institutionId);
  if (opts.status) q = q.eq("status", opts.status);
  const search = safeSearch(opts.search);
  if (search) {
    q = q.or(`registration_no.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);
  }

  const { data, count, error } = await q;
  if (error) throw new HttpError(500, error.message);

  return { students: (data ?? []).map(toRecord), total: count ?? 0 };
}

// ─────────────────────────────────────────────
//  Enrollment
// ─────────────────────────────────────────────
async function findGrade(institutionId: string, input: string) {
  const text = input.trim();
  const digits = text.replace(/\D/g, "");
  const candidates = [text, digits ? `G${digits}` : "", digits ? `Class ${digits}` : ""].filter(Boolean);

  for (const c of candidates) {
    const { data } = await supabaseAdmin
      .from("grades")
      .select("id, name")
      .eq("institution_id", institutionId)
      .eq("is_active", true)
      .or(`code.ilike.${c.replace(/[,()%*\\]/g, " ")},name.ilike.${c.replace(/[,()%*\\]/g, " ")}`)
      .limit(1);
    if (data?.length) return data[0];
  }
  throw new HttpError(400, `Grade '${input}' is not configured for this school. Create it under academic setup first.`);
}

/**
 * Enroll a new student into the current academic year.
 * The registration number is generated server-side from an atomic per-school
 * counter: [SchoolCode]ST[3-digit sequence], e.g. RAVST001. Client-supplied IDs are ignored.
 */
export async function enrollStudent(institutionId: string, input: EnrollStudentInput, actorProfileId?: string) {
  const { data: institution, error: instError } = await supabaseAdmin
    .from("institutions")
    .select("id, code, name, is_active")
    .eq("id", institutionId)
    .maybeSingle();
  if (instError) throw new HttpError(500, instError.message);
  if (!institution || !institution.is_active) throw new HttpError(404, "School not found or inactive.");

  const { data: year } = await supabaseAdmin
    .from("academic_years")
    .select("id, is_locked")
    .eq("institution_id", institutionId)
    .eq("is_current", true)
    .maybeSingle();
  if (!year) throw new HttpError(400, "No current academic year is configured for this school.");
  if (year.is_locked) throw new HttpError(409, "The current academic year is locked.");

  // plan gating: the student limit comes from the school's current plan
  const access = await loadSchoolAccess(institutionId);
  if (access.studentLimit !== null) {
    const { count: enrolled } = await supabaseAdmin
      .from("students")
      .select("*", { count: "exact", head: true })
      .eq("institution_id", institutionId)
      .eq("status", "Enrolled")
      .is("deleted_at", null);
    if ((enrolled ?? 0) >= access.studentLimit) {
      throw new HttpError(409, `The ${access.planCode} plan allows ${access.studentLimit} students and this school has reached the limit. Upgrade the plan to enrol more.`);
    }
  }

  const grade = await findGrade(institutionId, input.grade);

  let sectionId: string | null = null;
  let campusId: string | null = null;
  let sectionCount = 0;
  if (input.section?.trim()) {
    const { data: section } = await supabaseAdmin
      .from("sections")
      .select("id, capacity, campus_id")
      .eq("institution_id", institutionId)
      .eq("grade_id", grade.id)
      .eq("academic_year_id", year.id)
      .ilike("name", input.section.trim())
      .maybeSingle();
    if (!section) throw new HttpError(400, `Section '${input.section}' does not exist for ${grade.name}.`);

    const { count } = await supabaseAdmin
      .from("student_enrollments")
      .select("*", { count: "exact", head: true })
      .eq("section_id", section.id)
      .eq("status", "Active");
    sectionCount = count ?? 0;
    if (sectionCount >= section.capacity) throw new HttpError(409, `Section ${input.section} is full (${section.capacity}).`);

    sectionId = section.id;
    campusId = section.campus_id;
  }

  const { data: seq, error: seqError } = await supabaseAdmin.rpc("next_sequence", {
    p_institution: institutionId,
    p_kind: "student",
    p_scope: "",
  });
  if (seqError || seq == null) throw new HttpError(500, seqError?.message ?? "Could not allocate a student number.");

  const registrationNo = `${institution.code.toUpperCase()}ST${String(seq).padStart(3, "0")}`;
  const rollNo = input.roll_no?.trim() || String(sectionCount + 1);

  const { data: student, error: studentError } = await supabaseAdmin
    .from("students")
    .insert({
      institution_id: institutionId,
      campus_id: campusId,
      registration_no: registrationNo,
      roll_no: rollNo,
      first_name: input.first_name.trim(),
      last_name: input.last_name.trim(),
      gender: input.gender || null,
      date_of_birth: input.date_of_birth || null,
      status: "Enrolled",
    })
    .select("id")
    .single();
  if (studentError || !student) throw new HttpError(500, studentError?.message ?? "Failed to create student.");

  // Everything below is part of the same logical write; undo the student if any step fails.
  try {
    const { error: enrollError } = await supabaseAdmin.from("student_enrollments").insert({
      institution_id: institutionId,
      student_id: student.id,
      academic_year_id: year.id,
      grade_id: grade.id,
      section_id: sectionId,
      roll_no: rollNo,
    });
    if (enrollError) throw new Error(enrollError.message);

    if (input.address || input.gender || input.date_of_birth) {
      const { error } = await supabaseAdmin.from("student_profiles").insert({
        student_id: student.id,
        date_of_birth: input.date_of_birth || null,
        gender: input.gender || "Not Specified",
        permanent_address: input.address || null,
      });
      if (error) throw new Error(error.message);
    }

    if (input.guardian_name?.trim() && input.guardian_phone?.trim()) {
      const { data: guardian, error: gError } = await supabaseAdmin
        .from("guardians")
        .insert({
          institution_id: institutionId,
          full_name: input.guardian_name.trim(),
          phone: input.guardian_phone.trim(),
        })
        .select("id")
        .single();
      if (gError || !guardian) throw new Error(gError?.message ?? "Failed to create guardian.");

      const { error: linkError } = await supabaseAdmin.from("student_guardians").insert({
        student_id: student.id,
        guardian_id: guardian.id,
        relation: input.guardian_relation || "Parent",
        is_primary_contact: true,
      });
      if (linkError) throw new Error(linkError.message);
    }
  } catch (err) {
    await supabaseAdmin.from("students").delete().eq("id", student.id);
    throw new HttpError(500, err instanceof Error ? err.message : "Enrollment failed.");
  }

  const { data: created, error: readError } = await supabaseAdmin
    .from("students")
    .select(STUDENT_SELECT)
    .eq("id", student.id)
    .single();
  if (readError || !created) throw new HttpError(500, readError?.message ?? "Enrolled, but could not reload the record.");

  void actorProfileId; // recorded by the global audit logger
  return toRecord(created);
}
