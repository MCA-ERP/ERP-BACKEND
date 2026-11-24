import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { createUser } from "../admin/admin.service";
import { generatePassword } from "../admin/users-mgmt.service";
import { directory } from "./hr.service";

/** HR, part 2: the workflow strip, departments, designations, registration, profiles and recruitment. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// ═════════════ workflow strip ═════════════
export async function flow(inst: string) {
  const d = await directory(inst); const ms = today().slice(0, 7) + "-01";
  const [a, l] = await Promise.all([supabaseAdmin.from("staff_attendance").select("id", { count: "exact", head: true }).eq("institution_id", inst).gte("att_date", ms), supabaseAdmin.from("leave_requests").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("status", "Pending")]);
  const run = check(await supabaseAdmin.from("pay_runs").select("status").eq("institution_id", inst).eq("month", today().slice(0, 7)).maybeSingle()) as { status: string } | null; const rs = run?.status ?? "Draft"; const idx = ["Calculated", "Verified", "Approved", "Paid"].indexOf(rs);
  const steps = [d.items.length > 0, d.items.length > 0 && d.items.every((x) => x.department && x.designation), (a.count ?? 0) > 0, (l.count ?? 0) === 0 && d.items.length > 0, idx >= 0, idx >= 1, idx >= 2, idx >= 3];
  return { month: d.month, steps, payroll: rs };
}

// ═════════════ departments and designations ═════════════
export async function departments(inst: string) {
  const [d, s, c, st] = await Promise.all([supabaseAdmin.from("hr_departments").select("id, name, head_id, campus_id, status, head:head_id(first_name, last_name), campus:campus_id(name)").eq("institution_id", inst).order("name"), supabaseAdmin.from("hr_staff").select("department").eq("institution_id", inst).limit(5000), supabaseAdmin.from("campuses").select("id, name").eq("institution_id", inst).order("name"), directory(inst)]);
  const S = check(s) as { department: string }[];
  type R = { id: string; name: string; head_id: string | null; campus_id: string | null; status: string; head: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null; campus: { name: string } | { name: string }[] | null };
  return { campuses: check(c) as { id: string; name: string }[], staff: st.items.map((x) => ({ id: x.id, name: x.name })), items: (check(d) as unknown as R[]).map((x) => { const h = one(x.head); return { id: x.id, name: x.name, head_id: x.head_id, head: h ? `${h.first_name} ${h.last_name}`.trim() : "", campus_id: x.campus_id, campus: one(x.campus)?.name ?? "Both", status: x.status, staff: S.filter((y) => y.department.toLowerCase() === x.name.toLowerCase()).length }; }) };
}
export async function addDepartment(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the department.").max(60), head_id: uid.nullable().optional(), campus_id: uid.nullable().optional() }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("hr_departments").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That department exists.");
  if (i.head_id && !check(await supabaseAdmin.from("user_profiles").select("id").eq("id", i.head_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Head not found.");
  if (i.campus_id && !check(await supabaseAdmin.from("campuses").select("id").eq("id", i.campus_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Campus not found.");
  return check(await supabaseAdmin.from("hr_departments").insert({ institution_id: inst, name: i.name, head_id: i.head_id ?? null, campus_id: i.campus_id ?? null }).select("id").single());
}
export async function setDepartment(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hr_departments").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function departmentsFromStaff(inst: string) {
  const [have, st] = await Promise.all([supabaseAdmin.from("hr_departments").select("name").eq("institution_id", inst), directory(inst)]);
  const H = new Set((check(have) as { name: string }[]).map((x) => x.name.toLowerCase()));
  const names = [...new Set(st.items.map((x) => x.department).filter((n) => n && !H.has(n.toLowerCase())))];
  if (names.length) check(await supabaseAdmin.from("hr_departments").insert(names.map((name) => ({ institution_id: inst, name }))).select("id"));
  return { added: names.length };
}
export async function designations(inst: string) {
  const [d, p] = await Promise.all([supabaseAdmin.from("hr_designations").select("id, name, level, pay_band, status").eq("institution_id", inst).order("level").order("name"), supabaseAdmin.from("user_profiles").select("designation").eq("institution_id", inst).limit(5000)]);
  const P = check(p) as { designation: string | null }[];
  return { items: (check(d) as { id: string; name: string; level: string; pay_band: string; status: string }[]).map((x) => ({ ...x, staff: P.filter((y) => (y.designation ?? "").toLowerCase() === x.name.toLowerCase()).length })) };
}
export async function addDesignation(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the designation.").max(100), level: z.enum(["L1", "L2", "L3", "L4", "L5", "L6"]), pay_band: z.string().trim().max(40).optional() }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("hr_designations").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That designation exists.");
  return check(await supabaseAdmin.from("hr_designations").insert({ institution_id: inst, name: i.name, level: i.level, pay_band: i.pay_band ?? "" }).select("id").single());
}
export async function setDesignation(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hr_designations").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function designationsFromStaff(inst: string) {
  const [have, st] = await Promise.all([supabaseAdmin.from("hr_designations").select("name").eq("institution_id", inst), directory(inst)]);
  const H = new Set((check(have) as { name: string }[]).map((x) => x.name.toLowerCase()));
  const names = [...new Set(st.items.map((x) => x.designation).filter((n) => n && !H.has(n.toLowerCase())))];
  if (names.length) check(await supabaseAdmin.from("hr_designations").insert(names.map((name) => ({ institution_id: inst, name }))).select("id"));
  return { added: names.length };
}

// ═════════════ registration ═════════════
const ROLES = ["Faculty", "ClassTeacher", "Accountant", "Librarian", "Receptionist", "SchoolNurse", "Counsellor", "TransportManager", "MessManager", "StoreIncharge", "ExamCoordinator", "HR", "Registrar", "AdmissionsHead", "FrontOfficeSecurity"] as const;
const roleFor = (type: string, designation: string) => (type === "Teaching" ? "Faculty" : /accountant/i.test(designation) ? "Accountant" : /librarian/i.test(designation) ? "Librarian" : /nurse/i.test(designation) ? "SchoolNurse" : /counsel/i.test(designation) ? "Counsellor" : /admission/i.test(designation) ? "AdmissionsHead" : /registrar/i.test(designation) ? "Registrar" : "Receptionist");
const typeFor = (designation: string) => (/teacher|pgt|tgt|prt|faculty|lecturer|professor/i.test(designation) ? "Teaching" : "Non-teaching");
const empInput = z.object({ name: z.string().trim().min(2, "Enter the name.").max(120), email: z.string().trim().toLowerCase().email("Enter a valid email."), mobile: z.string().trim().max(30).optional(), department: z.string().trim().max(60).optional(), designation: z.string().trim().max(100).optional(), staff_type: z.enum(["Teaching", "Non-teaching"]), role: z.string().trim().min(2).max(50).optional(), joined_on: date.nullable().optional(), gender: z.enum(["Male", "Female", "Other"]).nullable().optional(), date_of_birth: date.nullable().optional(), monthly_salary: z.number().int().min(0).max(10_000_000).nullable().optional(), qualification: z.string().trim().max(120).optional(), pan: z.string().trim().toUpperCase().regex(/^([A-Z]{5}[0-9]{4}[A-Z])?$/, "PAN looks like ABCDE1234F.").optional(), emp_code: z.string().trim().max(20).optional() }).strict();
/** Roles added for this school (or by the platform team) that staff can be given a login with. */
async function customRoleNames(inst: string) {
  const r = check(await supabaseAdmin.from("roles").select("name, is_system_default, institution_id").eq("scope", "school")) as { name: string; is_system_default: boolean; institution_id: string | null }[];
  return r.filter((x) => !x.is_system_default && (x.institution_id === null || x.institution_id === inst)).map((x) => x.name);
}
async function makeEmployee(inst: string, i: z.infer<typeof empInput>, actorRole: string) {
  const [first, ...rest] = i.name.split(/\s+/); const role = i.role ?? roleFor(i.staff_type, i.designation ?? "");
  const password = generatePassword();
  const u = (await createUser({ email: i.email, password, first_name: first, last_name: rest.join(" ") || "-", phone: i.mobile, role, institution_id: inst, must_change_password: true }, actorRole)) as unknown as { id: string };
  check(await supabaseAdmin.from("user_profiles").update({ designation: i.designation || null }).eq("id", u.id).eq("institution_id", inst).select("id"));
  const row = { profile_id: u.id, institution_id: inst, department: i.department ?? "", staff_type: i.staff_type, mobile: i.mobile || null, joined_on: i.joined_on ?? today(), gender: i.gender ?? null, date_of_birth: i.date_of_birth ?? null, monthly_salary: i.monthly_salary ?? null, qualification: i.qualification || null, pan: i.pan || null, ...(i.emp_code ? { emp_code: i.emp_code } : {}) };
  check(await supabaseAdmin.from("hr_staff").insert(row).select("profile_id"));
  const code = (check(await supabaseAdmin.from("hr_staff").select("emp_code").eq("profile_id", u.id).single()) as { emp_code: string }).emp_code;
  return { id: u.id, emp_code: code, name: i.name, email: i.email, role, temporary_password: password };
}
export async function addEmployee(inst: string, input: unknown, actorRole: string) {
  const i = empInput.parse(input);
  if (i.emp_code && (check(await supabaseAdmin.from("hr_staff").select("profile_id").eq("institution_id", inst).eq("emp_code", i.emp_code)) as unknown[]).length) throw new HttpError(409, "That employee ID is used.");
  return makeEmployee(inst, i, actorRole);
}
export async function bulkImport(inst: string, input: unknown, actorRole: string) {
  const { rows, dry } = z.object({ dry: z.boolean(), rows: z.array(z.object({ name: z.string().max(120), emp_code: z.string().max(20).optional(), designation: z.string().max(100).optional(), department: z.string().max(60).optional(), joined_on: z.string().max(10).optional(), mobile: z.string().max(30).optional(), email: z.string().max(200) }).strict()).min(1, "The file has no rows.").max(500) }).strict().parse(input);
  const [em, co] = await Promise.all([supabaseAdmin.from("user_profiles").select("email").limit(100000), supabaseAdmin.from("hr_staff").select("emp_code").eq("institution_id", inst)]);
  const emails = new Set((check(em) as { email: string }[]).map((x) => x.email.toLowerCase())); const codes = new Set((check(co) as { emp_code: string }[]).map((x) => x.emp_code));
  const out: { row: number; name: string; ok: boolean; error?: string; emp_code?: string; email?: string; temporary_password?: string }[] = [];
  for (const [n, r] of rows.entries()) {
    const parsed = empInput.safeParse({ name: r.name, email: r.email, mobile: r.mobile || undefined, department: r.department || undefined, designation: r.designation || undefined, staff_type: typeFor(r.designation ?? ""), joined_on: r.joined_on || null, emp_code: r.emp_code || undefined });
    const fail = (error: string) => out.push({ row: n + 2, name: r.name, ok: false, error });
    if (!parsed.success) { fail(parsed.error.issues[0]?.message ?? "Invalid row."); continue; }
    const i = parsed.data;
    if (emails.has(i.email)) { fail("That email already has an account."); continue; }
    if (i.emp_code && codes.has(i.emp_code)) { fail("That employee ID is used."); continue; }
    emails.add(i.email); if (i.emp_code) codes.add(i.emp_code);
    if (dry) { out.push({ row: n + 2, name: i.name, ok: true, emp_code: i.emp_code, email: i.email }); continue; }
    try { const c = await makeEmployee(inst, i, actorRole); out.push({ row: n + 2, name: c.name, ok: true, emp_code: c.emp_code, email: c.email, temporary_password: c.temporary_password }); } catch (e) { fail(e instanceof Error ? e.message : "Could not create the account."); }
  }
  return { dry, valid: out.filter((x) => x.ok).length, invalid: out.filter((x) => !x.ok).length, rows: out };
}
export async function registrationLists(inst: string) {
  const [d, g] = await Promise.all([departments(inst), designations(inst)]);
  return { departments: d.items.filter((x) => x.status === "Active").map((x) => x.name), designations: g.items.filter((x) => x.status === "Active").map((x) => x.name), roles: [...new Set<string>([...ROLES, ...(await customRoleNames(inst))])] };
}

// ═════════════ employee profile ═════════════
async function own(inst: string, id: string) {
  const p = check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, email, status, designation").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; first_name: string; last_name: string; email: string; status: string; designation: string | null } | null;
  if (!p) throw new HttpError(404, "Staff member not found.");
  return p;
}
export async function profile(inst: string, id: string) {
  const p = await own(inst, id); await directory(inst);
  const h = check(await supabaseAdmin.from("hr_staff").select("emp_code, department, staff_type, mobile, joined_on, gender, date_of_birth, blood_group, marital_status, pan, aadhaar_last4, address, emergency_contact, monthly_salary, qualification").eq("profile_id", id).maybeSingle()) as Record<string, string | number | null> | null;
  const [q, x] = await Promise.all([supabaseAdmin.from("hr_qualifications").select("id, title, place, year, result").eq("profile_id", id).order("year"), supabaseAdmin.from("hr_experience").select("id, organisation, role, from_on, to_on").eq("profile_id", id).order("from_on", { ascending: false })]);
  return { id, name: `${p.first_name} ${p.last_name}`.trim(), email: p.email, designation: p.designation ?? "", status: p.status.toLowerCase() === "active" ? "Active" : p.status, ...(h ?? {}), aadhaar: h?.aadhaar_last4 ? `XXXX XXXX ${h.aadhaar_last4}` : "", qualifications: check(q) as { id: string; title: string; place: string; year: number | null; result: string }[], experience: check(x) as { id: string; organisation: string; role: string; from_on: string; to_on: string | null }[] };
}
export async function saveProfile(inst: string, id: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2).max(120).optional(), gender: z.enum(["Male", "Female", "Other"]).nullable().optional(), date_of_birth: date.nullable().optional(), blood_group: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).nullable().optional(), marital_status: z.enum(["Single", "Married", "Other"]).nullable().optional(), pan: z.string().trim().toUpperCase().regex(/^([A-Z]{5}[0-9]{4}[A-Z])?$/, "PAN looks like ABCDE1234F.").optional(), aadhaar: z.string().trim().max(20).optional(), mobile: z.string().trim().max(30).optional(), address: z.string().trim().max(300).optional(), emergency_contact: z.string().trim().max(160).optional() }).strict().parse(input);
  await own(inst, id); await directory(inst);
  if (i.name) { const [f, ...r] = i.name.split(/\s+/); check(await supabaseAdmin.from("user_profiles").update({ first_name: f, last_name: r.join(" ") || "-" }).eq("id", id).eq("institution_id", inst).select("id")); }
  const digits = (i.aadhaar ?? "").replace(/\D/g, "");
  if (i.aadhaar !== undefined && digits && digits.length !== 12) throw new HttpError(400, "Aadhaar has 12 digits.");
  const row: Record<string, unknown> = {};
  for (const k of ["gender", "date_of_birth", "blood_group", "marital_status"] as const) if (i[k] !== undefined) row[k] = i[k];
  if (i.pan !== undefined) row.pan = i.pan || null; if (i.mobile !== undefined) row.mobile = i.mobile || null; if (i.address !== undefined) row.address = i.address || null; if (i.emergency_contact !== undefined) row.emergency_contact = i.emergency_contact || null;
  if (i.aadhaar !== undefined) row.aadhaar_last4 = digits ? digits.slice(-4) : null;
  if (Object.keys(row).length) check(await supabaseAdmin.from("hr_staff").update(row).eq("profile_id", id).eq("institution_id", inst).select("profile_id"));
  return { ok: true };
}
export async function addQualification(inst: string, id: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(2, "Enter the qualification.").max(100), place: z.string().trim().max(120).optional(), year: z.number().int().min(1950).max(2100).nullable().optional(), result: z.string().trim().max(60).optional() }).strict().parse(input);
  await own(inst, id);
  return check(await supabaseAdmin.from("hr_qualifications").insert({ institution_id: inst, profile_id: id, title: i.title, place: i.place ?? "", year: i.year ?? null, result: i.result ?? "" }).select("id").single());
}
export async function addExperience(inst: string, id: string, input: unknown) {
  const i = z.object({ organisation: z.string().trim().min(2, "Enter the organisation.").max(120), role: z.string().trim().min(2, "Enter the role.").max(100), from_on: date, to_on: date.nullable().optional() }).strict().parse(input);
  await own(inst, id);
  if (i.to_on && i.to_on < i.from_on) throw new HttpError(400, "The end date is before the start date.");
  return check(await supabaseAdmin.from("hr_experience").insert({ institution_id: inst, profile_id: id, ...i, to_on: i.to_on ?? null }).select("id").single());
}
export async function removeRecord(inst: string, kind: "qualification" | "experience", id: string) {
  const r = check(await supabaseAdmin.from(kind === "qualification" ? "hr_qualifications" : "hr_experience").delete().eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ recruitment ═════════════
export async function openings(inst: string) {
  const [o, c] = await Promise.all([supabaseAdmin.from("hr_openings").select("id, position, department, posted_on, closes_on, status, req_qualification, needs_bed, min_experience, budget_annual").eq("institution_id", inst).order("posted_on", { ascending: false }), supabaseAdmin.from("hr_candidates").select("opening_id").eq("institution_id", inst).limit(20000)]);
  const C = check(c) as { opening_id: string | null }[];
  return { items: (check(o) as { id: string; position: string; department: string; posted_on: string; closes_on: string | null; status: string; req_qualification: string; needs_bed: boolean; min_experience: number; budget_annual: number }[]).map((x) => ({ ...x, applications: C.filter((y) => y.opening_id === x.id).length })) };
}
export async function addOpening(inst: string, input: unknown) {
  const i = z.object({ position: z.string().trim().min(2, "Enter the position.").max(100), department: z.string().trim().max(60).optional(), closes_on: date.nullable().optional(), req_qualification: z.string().trim().max(120).optional(), needs_bed: z.boolean().optional(), min_experience: z.number().int().min(0).max(40).optional(), budget_annual: z.number().int().min(0).max(100_000_000).optional() }).strict().parse(input);
  return check(await supabaseAdmin.from("hr_openings").insert({ institution_id: inst, position: i.position, department: i.department ?? "", closes_on: i.closes_on ?? null, req_qualification: i.req_qualification ?? "", needs_bed: i.needs_bed ?? false, min_experience: i.min_experience ?? 0, budget_annual: i.budget_annual ?? 0 }).select("id").single());
}
export async function setOpening(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Open", "Interviewing", "Closed"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hr_openings").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
interface Cand { id: string; app_code: string; cv_code: string; opening_id: string | null; name: string; current_org: string; city: string; qualification: string; experience: number; expected_annual: number; source: string; stage: string; demo_score: number | null; applied_on: string; op: { position: string; req_qualification: string; needs_bed: boolean; min_experience: number; budget_annual: number } | { position: string; req_qualification: string; needs_bed: boolean; min_experience: number; budget_annual: number }[] | null }
const CAND = "id, app_code, cv_code, opening_id, name, current_org, city, qualification, experience, expected_annual, source, stage, demo_score, applied_on, op:opening_id(position, req_qualification, needs_bed, min_experience, budget_annual)";
function rules(c: Cand) {
  const o = one(c.op); if (!o) return [];
  const out: { label: string; ok: boolean }[] = []; const q = c.qualification.toLowerCase();
  if (o.req_qualification) out.push({ label: "Qualification", ok: o.req_qualification.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((k) => q.includes(k)) });
  if (o.needs_bed) out.push({ label: "B.Ed", ok: /b\.?\s?ed/i.test(c.qualification) });
  if (o.min_experience > 0) out.push({ label: `Experience ${o.min_experience}+ yrs`, ok: c.experience >= o.min_experience });
  if (o.budget_annual > 0) out.push({ label: "Within budget", ok: c.expected_annual <= o.budget_annual });
  return out;
}
const shape = (c: Cand) => { const r = rules(c); return { id: c.id, app_code: c.app_code, cv_code: c.cv_code, opening_id: c.opening_id, position: one(c.op)?.position ?? "", name: c.name, current_org: c.current_org, city: c.city, qualification: c.qualification, experience: c.experience, expected_annual: c.expected_annual, source: c.source, stage: c.stage, demo_score: c.demo_score, applied_on: c.applied_on, rules: r, rule_pct: r.length ? Math.round((r.filter((x) => x.ok).length / r.length) * 100) : 100 }; };
export async function candidates(inst: string) {
  const [c, i] = await Promise.all([supabaseAdmin.from("hr_candidates").select(CAND).eq("institution_id", inst).order("applied_on", { ascending: false }).order("app_code", { ascending: false }).limit(5000), supabaseAdmin.from("hr_interviews").select("candidate_id, score, status").eq("institution_id", inst).eq("status", "Completed")]);
  const I = check(i) as { candidate_id: string; score: number | null }[];
  return { items: (check(c) as unknown as Cand[]).map((x) => ({ ...shape(x), interview_score: I.find((y) => y.candidate_id === x.id)?.score ?? null })) };
}
export async function addCandidate(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the name.").max(120), opening_id: uid.nullable().optional(), current_org: z.string().trim().max(120).optional(), city: z.string().trim().max(60).optional(), qualification: z.string().trim().max(120).optional(), experience: z.number().int().min(0).max(50).optional(), expected_annual: z.number().int().min(0).max(100_000_000).optional(), source: z.enum(["Careers page", "Naukri", "LinkedIn", "Referral", "Walk-in", "Other"]).optional(), applied_on: date.optional() }).strict().parse(input);
  if (i.opening_id && !check(await supabaseAdmin.from("hr_openings").select("id").eq("id", i.opening_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Opening not found.");
  return check(await supabaseAdmin.from("hr_candidates").insert({ institution_id: inst, ...i, opening_id: i.opening_id ?? null }).select("id, app_code, cv_code").single());
}
async function cand(inst: string, id: string) {
  const c = check(await supabaseAdmin.from("hr_candidates").select("id, name, stage, opening_id, expected_annual, experience").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; name: string; stage: string; opening_id: string | null; expected_annual: number; experience: number } | null;
  if (!c) throw new HttpError(404, "Candidate not found."); return c;
}
export async function moveCandidate(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["shortlist", "reject", "hold", "select", "reopen"]) }).strict().parse(input);
  const c = await cand(inst, id);
  if (["Offered", "Accepted"].includes(c.stage)) throw new HttpError(409, "An offer has already been made.");
  const next = { shortlist: "Shortlisted", reject: "Rejected", hold: "On hold", select: "Selected", reopen: "New" }[action];
  if (action === "shortlist" && c.stage !== "New" && c.stage !== "On hold") throw new HttpError(409, "Only a new or held application can be shortlisted.");
  if (action === "select" && !["Shortlisted", "Interviewed", "Interview scheduled"].includes(c.stage)) throw new HttpError(409, "Shortlist or interview the candidate first.");
  check(await supabaseAdmin.from("hr_candidates").update({ stage: next }).eq("id", id).eq("institution_id", inst).select("id"));
  if (action === "select") check(await supabaseAdmin.from("hr_checks").upsert({ candidate_id: id, institution_id: inst }, { onConflict: "candidate_id", ignoreDuplicates: true }).select("candidate_id"));
  return { ok: true, stage: next };
}
export async function setDemo(inst: string, id: string, input: unknown) {
  const { score } = z.object({ score: z.number().min(0).max(10) }).strict().parse(input);
  await cand(inst, id);
  check(await supabaseAdmin.from("hr_candidates").update({ demo_score: score }).eq("id", id).eq("institution_id", inst).select("id")); return { ok: true };
}
export async function interviews(inst: string) {
  const [r, c] = await Promise.all([supabaseAdmin.from("hr_interviews").select("id, candidate_id, panel, on_date, at_time, mode, status, score, cand:candidate_id(name, stage, op:opening_id(position))").eq("institution_id", inst).order("on_date", { ascending: false }).order("at_time", { ascending: false }).limit(2000), candidates(inst)]);
  type R = { id: string; candidate_id: string; panel: string; on_date: string; at_time: string; mode: string; status: string; score: number | null; cand: { name: string; stage: string; op: { position: string } | { position: string }[] | null } | { name: string; stage: string; op: { position: string } | { position: string }[] | null }[] | null };
  return { candidates: c.items.filter((x) => ["Shortlisted", "New", "Interviewed", "Interview scheduled"].includes(x.stage)).map((x) => ({ id: x.id, name: x.name, position: x.position })), items: (check(r) as unknown as R[]).map((x) => { const k = one(x.cand); return { id: x.id, candidate_id: x.candidate_id, candidate: k?.name ?? "", position: one(k?.op ?? null)?.position ?? "", panel: x.panel, on_date: x.on_date, at_time: x.at_time.slice(0, 5), mode: x.mode, status: x.status === "Completed" && k?.stage === "Selected" ? "Selected" : x.status, score: x.score }; }) };
}
export async function scheduleInterview(inst: string, input: unknown) {
  const i = z.object({ candidate_id: uid, panel: z.string().trim().max(160).optional(), on_date: date, at_time: z.string().regex(/^\d{2}:\d{2}$/), mode: z.enum(["In person", "Video call", "Phone"]) }).strict().parse(input);
  const c = await cand(inst, i.candidate_id);
  if (["Rejected", "Offered", "Accepted"].includes(c.stage)) throw new HttpError(409, `That candidate is ${c.stage.toLowerCase()}.`);
  const r = check(await supabaseAdmin.from("hr_interviews").insert({ institution_id: inst, candidate_id: i.candidate_id, panel: i.panel ?? "", on_date: i.on_date, at_time: i.at_time, mode: i.mode }).select("id").single());
  check(await supabaseAdmin.from("hr_candidates").update({ stage: "Interview scheduled" }).eq("id", i.candidate_id).eq("institution_id", inst).select("id"));
  return r;
}
export async function finishInterview(inst: string, id: string, input: unknown) {
  const i = z.object({ status: z.enum(["Completed", "Cancelled"]), score: z.number().min(0).max(10).optional() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hr_interviews").select("id, candidate_id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; candidate_id: string; status: string } | null;
  if (!r) throw new HttpError(404, "Not found."); if (r.status !== "Scheduled") throw new HttpError(409, "That interview is already closed.");
  if (i.status === "Completed" && i.score === undefined) throw new HttpError(400, "Enter the panel score.");
  check(await supabaseAdmin.from("hr_interviews").update({ status: i.status, score: i.status === "Completed" ? i.score : null }).eq("id", id).eq("institution_id", inst).select("id"));
  check(await supabaseAdmin.from("hr_candidates").update({ stage: i.status === "Completed" ? "Interviewed" : "Shortlisted" }).eq("id", r.candidate_id).eq("institution_id", inst).select("id"));
  return { ok: true };
}
const CHECKS = ["employer", "refs", "police", "certificates", "id_address"] as const;
export async function backgroundChecks(inst: string) {
  const [r, c] = await Promise.all([supabaseAdmin.from("hr_checks").select("candidate_id, employer, refs, police, certificates, id_address").eq("institution_id", inst), candidates(inst)]);
  const K = new Map(c.items.map((x) => [x.id, x]));
  return { items: (check(r) as { candidate_id: string; employer: boolean; refs: boolean; police: boolean; certificates: boolean; id_address: boolean }[]).map((x) => ({ ...x, name: K.get(x.candidate_id)?.name ?? "", position: K.get(x.candidate_id)?.position ?? "", overall: CHECKS.every((k) => x[k]) ? "Verified" : "In progress" })) };
}
export async function verifyCheck(inst: string, id: string, input: unknown) {
  const { item } = z.object({ item: z.enum(CHECKS) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hr_checks").update({ [item]: true }).eq("candidate_id", id).eq("institution_id", inst).select("candidate_id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export const split = (annual: number) => { const m = Math.round(annual / 12); const basic = Math.round(m / 2); const hra = Math.round(basic * 0.4); const pf = Math.min(Math.round(basic * 0.12), 1800); return { basic, hra, special: m - basic - hra - pf, pf }; };
export async function offers(inst: string) {
  const [r, c, s] = await Promise.all([supabaseAdmin.from("hr_offers").select("id, code, candidate_id, annual_cost, joining_on, probation, valid_days, sent_on, status").eq("institution_id", inst).order("sent_on", { ascending: false }).order("code", { ascending: false }), candidates(inst), supabaseAdmin.from("institutions").select("name, address").eq("id", inst).maybeSingle()]);
  const K = new Map(c.items.map((x) => [x.id, x])); const sc = s.data as { name: string; address: string | null } | null;
  return { school: sc?.name ?? "", address: sc?.address ?? "", selected: c.items.filter((x) => x.stage === "Selected").map((x) => ({ id: x.id, name: x.name, position: x.position, expected: x.expected_annual })), items: (check(r) as { id: string; code: string; candidate_id: string; annual_cost: number; joining_on: string; probation: number; valid_days: number; sent_on: string; status: string }[]).map((x) => ({ ...x, candidate: K.get(x.candidate_id)?.name ?? "", position: K.get(x.candidate_id)?.position ?? "", split: split(x.annual_cost) })) };
}
export async function createOffer(inst: string, input: unknown, role: string, actor?: string) {
  const i = z.object({ candidate_id: uid, annual_cost: z.number().int().min(1).max(100_000_000), joining_on: date, probation: z.number().int().min(0).max(24), valid_days: z.number().int().min(1).max(60) }).strict().parse(input);
  const c = check(await supabaseAdmin.from("hr_candidates").select("id, stage, op:opening_id(budget_annual)").eq("id", i.candidate_id).eq("institution_id", inst).maybeSingle()) as unknown as { id: string; stage: string; op: { budget_annual: number } | { budget_annual: number }[] | null } | null;
  if (!c) throw new HttpError(404, "Candidate not found.");
  if (c.stage !== "Selected") throw new HttpError(409, "Offers go to selected candidates.");
  const budget = one(c.op)?.budget_annual ?? 0;
  if (budget > 0 && i.annual_cost > budget && !["Principal", "InstitutionAdmin"].includes(role)) throw new HttpError(403, `The post's budget is ${inr(budget)}. Offers above it need the Principal's approval.`);
  const checks = check(await supabaseAdmin.from("hr_checks").select("police").eq("candidate_id", i.candidate_id).maybeSingle()) as { police: boolean } | null;
  void checks;
  const r = check(await supabaseAdmin.from("hr_offers").insert({ institution_id: inst, ...i, sent_on: today(), created_by: actor ?? null }).select("id, code").single());
  check(await supabaseAdmin.from("hr_candidates").update({ stage: "Offered" }).eq("id", i.candidate_id).eq("institution_id", inst).select("id"));
  return r;
}
export async function answerOffer(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Accepted", "Declined"]) }).strict().parse(input);
  const o = check(await supabaseAdmin.from("hr_offers").select("id, status, candidate_id").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string; candidate_id: string } | null;
  if (!o) throw new HttpError(404, "Not found."); if (o.status !== "Sent") throw new HttpError(409, "That offer already has an answer.");
  check(await supabaseAdmin.from("hr_offers").update({ status }).eq("id", id).eq("institution_id", inst).select("id"));
  check(await supabaseAdmin.from("hr_candidates").update({ stage: status === "Accepted" ? "Accepted" : "On hold" }).eq("id", o.candidate_id).eq("institution_id", inst).select("id"));
  return { ok: true };
}
