import { supabaseAdmin } from "../../db/client";
import { check } from "./db";
import { HttpError } from "./http-error";

interface Limits {
  student_limit: number | null;
  staff_limit: number | null;
  campus_limit: number | null;
  name: string;
}

const NOT_STAFF = ["Student", "Parent"];

export async function currentLimits(institutionId: string): Promise<Limits | null> {
  const row = check(
    await supabaseAdmin
      .from("subscriptions")
      .select("plans:plan_id(name, student_limit, staff_limit, campus_limit)")
      .eq("institution_id", institutionId)
      .eq("is_current", true)
      .maybeSingle()
  ) as unknown as { plans: Limits | null } | null;
  return row?.plans ?? null;
}

export async function usage(institutionId: string) {
  const [students, campuses, staff] = await Promise.all([
    supabaseAdmin.from("students").select("*", { count: "exact", head: true }).eq("institution_id", institutionId).eq("status", "Enrolled").is("deleted_at", null),
    supabaseAdmin.from("campuses").select("*", { count: "exact", head: true }).eq("institution_id", institutionId),
    supabaseAdmin.from("user_profiles").select("id, roles:role_id(name)").eq("institution_id", institutionId).eq("status", "active").limit(5000),
  ]);
  const people = check(staff) as unknown as { roles: { name: string } | null }[];
  return {
    students: students.count ?? 0,
    campuses: campuses.count ?? 0,
    staff: people.filter((p) => !NOT_STAFF.includes(p.roles?.name ?? "")).length,
  };
}

/** Refuses to add one more campus or staff account beyond what the school's plan allows. */
export async function assertRoomFor(institutionId: string, what: "campus" | "staff"): Promise<void> {
  const limits = await currentLimits(institutionId);
  if (!limits) return;
  const cap = what === "campus" ? limits.campus_limit : limits.staff_limit;
  if (cap === null) return;
  const u = await usage(institutionId);
  const used = what === "campus" ? u.campuses : u.staff;
  if (used >= cap) {
    throw new HttpError(409, `The ${limits.name} plan allows ${cap} ${what === "campus" ? "campus(es)" : "staff accounts"} and this school already has ${used}. Move the school to a bigger plan first.`);
  }
}

/** Refuses a move to a plan the school's current size does not fit in. */
export async function assertFitsPlan(institutionId: string, plan: { name: string; student_limit: number | null; staff_limit: number | null; campus_limit: number | null }): Promise<void> {
  const u = await usage(institutionId);
  const over: string[] = [];
  if (plan.student_limit !== null && u.students > plan.student_limit) over.push(`${u.students} students (limit ${plan.student_limit})`);
  if (plan.staff_limit !== null && u.staff > plan.staff_limit) over.push(`${u.staff} staff accounts (limit ${plan.staff_limit})`);
  if (plan.campus_limit !== null && u.campuses > plan.campus_limit) over.push(`${u.campuses} campuses (limit ${plan.campus_limit})`);
  if (over.length) throw new HttpError(409, `The school is too big for the ${plan.name} plan: ${over.join(", ")}.`);
}
