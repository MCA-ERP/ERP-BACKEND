import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { istDate, one, secLabel } from "../teacher/teacher.service";

/**
 * Who a parent is and which children are theirs. Everything in the Parent portal starts here: the guardian record is found
 * from the signed-in account and the school (never from the request), and a child is only ever one that is linked to that
 * record. A student id sent by the browser is checked against this list before anything is read or written.
 */
export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
export const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "");
const uid = z.string().uuid("Invalid id.");

export interface Guardian {
  id: string; full_name: string; phone: string; email: string | null; occupation: string | null; parent_code: string | null; login_status: string;
  emergency_name: string | null; emergency_phone: string | null; address: string | null; city: string | null; pincode: string | null; income_band: string | null;
}
export const GUARDIAN_COLS = "id, full_name, phone, email, occupation, parent_code, login_status, emergency_name, emergency_phone, address, city, pincode, income_band";

export interface Child {
  id: string; name: string; first_name: string; registration_no: string; gender: string; date_of_birth: string | null; blood_group: string; house: string;
  roll_no: string; grade_id: string; grade_name: string; section_id: string; section_name: string; class_label: string; class_teacher_id: string | null; class_teacher: string; relation: string;
}
export interface Family { guardian: Guardian; guardianIds: string[]; children: Child[] }

type Person = { first_name: string; last_name: string };
const personName = (p: Person | null) => (p ? `${p.first_name} ${p.last_name}`.trim() : "");

export async function family(inst: string, me: string): Promise<Family> {
  const guardians = (check(await supabaseAdmin.from("guardians").select(GUARDIAN_COLS).eq("institution_id", inst).eq("user_profile_id", me).order("created_at").limit(20)) ?? []) as unknown as Guardian[];
  const active = guardians.filter((g) => g.login_status !== "Inactive");
  if (!active.length) throw new HttpError(403, guardians.length ? "Your parent app access is switched off. Please contact the school office." : "This account is not linked to a parent record yet. Please contact the school office.");
  const guardianIds = active.map((g) => g.id);

  const links = (check(await supabaseAdmin.from("student_guardians").select("student_id, relation").in("guardian_id", guardianIds).limit(100)) ?? []) as { student_id: string; relation: string }[];
  const ids = [...new Set(links.map((l) => l.student_id))];
  if (!ids.length) return { guardian: active[0], guardianIds, children: [] };

  // the school filter is repeated on the students: a link can never reach into another school
  const students = (check(await supabaseAdmin.from("students").select("id, registration_no, roll_no, first_name, last_name, gender, date_of_birth, status").eq("institution_id", inst).in("id", ids).is("deleted_at", null)) ?? []) as { id: string; registration_no: string; roll_no: string | null; first_name: string; last_name: string; gender: string | null; date_of_birth: string | null; status: string }[];
  if (!students.length) return { guardian: active[0], guardianIds, children: [] };
  const own = students.map((s) => s.id);

  const year = check(await supabaseAdmin.from("academic_years").select("id").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { id: string } | null;
  const [enr, prof] = await Promise.all([
    year ? supabaseAdmin.from("student_enrollments").select("student_id, grade_id, section_id, roll_no").eq("academic_year_id", year.id).in("student_id", own) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("student_profiles").select("student_id, blood_group, house, gender, date_of_birth").in("student_id", own),
  ]);
  const E = new Map(((check(enr) ?? []) as { student_id: string; grade_id: string; section_id: string | null; roll_no: string | null }[]).map((e) => [e.student_id, e]));
  const P = new Map(((check(prof) ?? []) as { student_id: string; blood_group: string | null; house: string | null; gender: string | null; date_of_birth: string | null }[]).map((p) => [p.student_id, p]));
  const secIds = [...new Set(students.map((s) => E.get(s.id)?.section_id).filter((x): x is string => !!x))];
  const secs = (secIds.length ? check(await supabaseAdmin.from("sections").select("id, name, grade_id, class_teacher_id, grades:grade_id(name), teacher:class_teacher_id(first_name, last_name)").eq("institution_id", inst).in("id", secIds)) : []) as unknown as { id: string; name: string; grade_id: string; class_teacher_id: string | null; grades: { name: string } | { name: string }[] | null; teacher: Person | Person[] | null }[];
  const S = new Map(secs.map((s) => [s.id, s]));

  const children = students.map((s): Child => {
    const e = E.get(s.id); const p = P.get(s.id); const sec = S.get(e?.section_id ?? "");
    return {
      id: s.id, name: `${s.first_name} ${s.last_name}`.trim(), first_name: s.first_name, registration_no: s.registration_no, gender: s.gender ?? p?.gender ?? "", date_of_birth: s.date_of_birth ?? p?.date_of_birth ?? null,
      blood_group: p?.blood_group ?? "", house: p?.house ?? "", roll_no: e?.roll_no ?? s.roll_no ?? "", grade_id: e?.grade_id ?? sec?.grade_id ?? "", grade_name: one(sec?.grades ?? null)?.name ?? "",
      section_id: sec?.id ?? "", section_name: sec?.name ?? "", class_label: sec ? secLabel(sec) : "", class_teacher_id: sec?.class_teacher_id ?? null, class_teacher: personName(one(sec?.teacher ?? null)),
      relation: links.find((l) => l.student_id === s.id)?.relation ?? "Parent",
    };
  });
  // the elder child first, as families list them
  children.sort((a, b) => (a.date_of_birth ?? "9999").localeCompare(b.date_of_birth ?? "9999") || a.name.localeCompare(b.name));
  return { guardian: active[0], guardianIds, children };
}

/** The family and one of its children. Without an id the first child is used; an id that is not this family's is not found. */
export async function childOf(inst: string, me: string, studentId?: unknown): Promise<{ fam: Family; child: Child }> {
  const fam = await family(inst, me);
  if (studentId === undefined || studentId === "" || studentId === null) {
    if (!fam.children.length) throw new HttpError(409, "No child is linked to your account yet. Please contact the school office.");
    return { fam, child: fam.children[0] };
  }
  const id = uid.parse(studentId);
  const child = fam.children.find((c) => c.id === id);
  if (!child) throw new HttpError(404, "Student not found.");
  return { fam, child };
}

/** "Aarav and Diya" */
export const andList = (names: string[]) => (names.length < 2 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** Whether a calendar or announcement audience is meant for this family. */
export function forFamily(audience: string, children: Pick<Child, "grade_name" | "section_name">[]): boolean {
  const a = (audience ?? "").trim().toLowerCase();
  if (!a || /^(everyone|all|whole school)$/.test(a)) return true;
  const named = [...a.matchAll(/(?:class|classes|grade|grades)\s*(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/g)];
  if (named.length) {
    const nums = children.map((c) => Number(/(\d+)\s*$/.exec(c.grade_name)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n));
    return named.some((m) => nums.some((n) => (m[2] ? n >= Number(m[1]) && n <= Number(m[2]) : n === Number(m[1]))));
  }
  if (/(staff|teacher|faculty|employee)/.test(a)) return false;
  return true;
}

export const today = () => istDate();
