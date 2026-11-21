import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** HR: the staff directory of one school. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const SKIP = ["Parent", "Student", "SuperAdmin", "PlatformManager", "SupportAgent", "ContentEditor"];
const TEACHING = ["Faculty", "ClassTeacher"];
const DEPT: Record<string, string> = { Principal: "Administration", VicePrincipal: "Administration", InstitutionAdmin: "Administration", Registrar: "Administration", AdmissionsHead: "Administration", Receptionist: "Administration", FrontOfficeSecurity: "Administration", HR: "Administration", Accountant: "Accounts", Finance: "Accounts", TransportManager: "Transport", Librarian: "Library", SchoolNurse: "Health", Counsellor: "Counselling", MessManager: "Mess", StoreIncharge: "Stores", ExamCoordinator: "Examinations" };

interface P { id: string; first_name: string; last_name: string; email: string; phone: string | null; status: string; designation: string | null; created_at: string; roles: { name: string; display_name: string } | { name: string; display_name: string }[] | null }
async function profiles(inst: string) {
  const r = check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, email, phone, status, designation, created_at, roles:role_id(name, display_name)").eq("institution_id", inst).order("created_at").limit(3000)) as unknown as P[];
  return r.filter((p) => !SKIP.includes(one(p.roles)?.name ?? ""));
}
/** Every staff member gets a staff record the first time the directory is opened. */
async function ensure(inst: string, list: P[]) {
  const have = new Set((check(await supabaseAdmin.from("hr_staff").select("profile_id").eq("institution_id", inst).limit(5000)) as { profile_id: string }[]).map((x) => x.profile_id));
  for (const p of list.filter((x) => !have.has(x.id))) {
    const role = one(p.roles)?.name ?? "";
    check(await supabaseAdmin.from("hr_staff").insert({ profile_id: p.id, institution_id: inst, department: DEPT[role] ?? "", staff_type: TEACHING.includes(role) ? "Teaching" : "Non-teaching", mobile: p.phone, joined_on: p.created_at.slice(0, 10) }).select("profile_id"));
  }
}
export async function directory(inst: string) {
  const list = await profiles(inst); await ensure(inst, list);
  const rows = check(await supabaseAdmin.from("hr_staff").select("profile_id, emp_code, department, staff_type, mobile, joined_on").eq("institution_id", inst).limit(5000)) as { profile_id: string; emp_code: string; department: string; staff_type: string; mobile: string | null; joined_on: string | null }[];
  const H = new Map(rows.map((x) => [x.profile_id, x]));
  const items = list.map((p) => { const h = H.get(p.id)!; return { id: p.id, emp_code: h.emp_code, name: `${p.first_name} ${p.last_name}`.trim(), email: p.email, department: h.department, designation: p.designation || one(p.roles)?.display_name || "", role: one(p.roles)?.display_name ?? "", type: h.staff_type, mobile: h.mobile ?? "", joined_on: h.joined_on, status: p.status === "Active" || p.status === "active" ? "Active" : p.status }; }).sort((a, b) => a.emp_code.localeCompare(b.emp_code, undefined, { numeric: true }));
  const ms = today().slice(0, 7) + "-01";
  const att = check(await supabaseAdmin.from("staff_attendance").select("id", { count: "exact", head: true }).eq("institution_id", inst).gte("att_date", ms)) as unknown;
  void att;
  const a = await supabaseAdmin.from("staff_attendance").select("id", { count: "exact", head: true }).eq("institution_id", inst).gte("att_date", ms);
  const steps = [items.length > 0, items.length > 0 && items.every((x) => x.department && x.designation), (a.count ?? 0) > 0, false, false, false, false, false];
  return { month: new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }), steps, items };
}
export async function updateStaff(inst: string, id: string, input: unknown) {
  const i = z.object({ department: z.string().trim().max(60), designation: z.string().trim().max(100), staff_type: z.enum(["Teaching", "Non-teaching"]), mobile: z.string().trim().max(30), joined_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }).strict().parse(input);
  const p = check(await supabaseAdmin.from("user_profiles").select("id").eq("id", id).eq("institution_id", inst).maybeSingle());
  if (!p) throw new HttpError(404, "Staff member not found.");
  await ensure(inst, (await profiles(inst)).filter((x) => x.id === id));
  check(await supabaseAdmin.from("hr_staff").update({ department: i.department, staff_type: i.staff_type, mobile: i.mobile || null, joined_on: i.joined_on }).eq("profile_id", id).eq("institution_id", inst).select("profile_id"));
  check(await supabaseAdmin.from("user_profiles").update({ designation: i.designation || null }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}
