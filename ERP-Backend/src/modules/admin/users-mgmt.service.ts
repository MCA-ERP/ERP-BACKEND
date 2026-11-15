import { randomBytes } from "crypto";
import { supabaseAdmin, supabasePublic } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { checkPassword } from "../../lib/password-policy";
import { parsePage, safeSearch } from "../../lib/query";
import { endSessions } from "../../lib/sessions";
import { assertRoomFor } from "../../lib/plan-limits";
import { getSetting } from "./settings.service";
import { createUser } from "./admin.service";
import { logEvent, type Actor } from "./school-mgmt.service";

// ═════════════ groups ═════════════
export const GROUPS = {
  super_admin: { label: "Super Admin", roles: ["SuperAdmin"], platform: true },
  support_staff: { label: "Support staff", roles: ["PlatformManager", "Finance", "SupportAgent", "ContentEditor"], platform: true },
  school_admin: { label: "School admins", roles: ["InstitutionAdmin"], platform: false },
  principal: { label: "Principals", roles: ["Principal"], platform: false },
  teachers: { label: "Teachers", roles: ["Faculty"], platform: false },
  accountants: { label: "Accountants", roles: ["Accountant"], platform: false },
  other_staff: { label: "Other staff", roles: ["Registrar", "HR", "Librarian"], platform: false },
  students: { label: "Students", roles: ["Student"], platform: false },
  parents: { label: "Parents", roles: ["Parent"], platform: false },
} as const;
export type GroupKey = keyof typeof GROUPS;

const SELECT =
  "id, auth_user_id, email, first_name, last_name, phone, status, last_login_at, created_at, failed_login_count, locked_until, must_change_password, " +
  "institution_id, campus_id, role_id, roles:role_id(name, display_name), institutions:institution_id(name, code)";

async function roleIds(names: readonly string[]): Promise<string[]> {
  const rows = check(await supabaseAdmin.from("roles").select("id").in("name", [...names])) as { id: string }[];
  return rows.map((r) => r.id);
}

const nowIso = () => new Date().toISOString();

/** The directory: filter by group (who they are) and state (can they sign in). */
export async function listDirectory(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin.from("user_profiles").select(SELECT, { count: "exact" }).order("created_at", { ascending: false }).range(p.from, p.to);

  const group = String(query.group ?? "");
  if (group in GROUPS) {
    const ids = await roleIds(GROUPS[group as GroupKey].roles);
    if (!ids.length) return { items: [], total: 0, page: p.page, pageSize: p.pageSize };
    q = q.in("role_id", ids);
    if (GROUPS[group as GroupKey].platform) q = q.is("institution_id", null);
  }
  if (typeof query.role === "string" && query.role) {
    const ids = await roleIds([query.role]);
    if (!ids.length) return { items: [], total: 0, page: p.page, pageSize: p.pageSize };
    q = q.in("role_id", ids);
  }
  if (typeof query.school === "string" && /^[0-9a-f-]{36}$/i.test(query.school)) q = q.eq("institution_id", query.school);

  const state = String(query.state ?? "");
  if (state === "active") q = q.eq("status", "active").or(`locked_until.is.null,locked_until.lte.${nowIso()}`);
  else if (state === "inactive") q = q.neq("status", "active");
  else if (state === "locked") q = q.gt("locked_until", nowIso());

  const search = safeSearch(query.search);
  if (search) q = q.or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%,phone.ilike.%${search}%`);

  const res = await q;
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

/** How many accounts are in each group and each state, for the tabs. */
export async function directoryCounts() {
  const rows = check(
    await supabaseAdmin.from("user_profiles").select("status, locked_until, institution_id, roles:role_id(name)").limit(20000)
  ) as unknown as { status: string | null; locked_until: string | null; institution_id: string | null; roles: { name: string } | null }[];
  const groups: Record<string, number> = {};
  for (const [key, g] of Object.entries(GROUPS)) {
    groups[key] = rows.filter((r) => g.roles.some((n) => n === r.roles?.name) && (!g.platform || !r.institution_id)).length;
  }
  const now = Date.now();
  const locked = rows.filter((r) => r.locked_until && new Date(r.locked_until).getTime() > now).length;
  const inactive = rows.filter((r) => r.status !== "active").length;
  return { groups, all: rows.length, locked, inactive, active: rows.length - inactive - rows.filter((r) => r.status === "active" && r.locked_until && new Date(r.locked_until).getTime() > now).length };
}

// ═════════════ account actions ═════════════
export function generatePassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const pick = (set: string, n: number) => Array.from(randomBytes(n), (b) => set[b % set.length]).join("");
  // 8 letters + 3 digits + a symbol, shuffled by position so the shape is not guessable
  const chars = (pick(letters, 8) + pick(digits, 3) + "#").split("");
  const order = randomBytes(chars.length);
  return chars.map((c, i) => [c, order[i]] as const).sort((a, b) => a[1] - b[1]).map((x) => x[0]).join("");
}

async function target(id: string) {
  const row = check(await supabaseAdmin.from("user_profiles").select(SELECT).eq("id", id).maybeSingle()) as unknown as
    | { id: string; auth_user_id: string | null; email: string; first_name: string; last_name: string; status: string; institution_id: string | null; roles: { name: string } | null }
    | null;
  if (!row) throw new HttpError(404, "User not found.");
  return row;
}

function guardSelf(id: string, actor: Actor, what: string) {
  if (id === actor.profileId) throw new HttpError(400, `You cannot ${what} your own account.`);
}

/** Staff cannot touch Super Administrators. */
function guardSuper(row: { roles: { name: string } | null }, actorRole?: string) {
  if (row.roles?.name === "SuperAdmin" && actorRole !== "SuperAdmin") throw new HttpError(403, "Only a Super Administrator can change another Super Administrator's account.");
}

async function log(row: { institution_id: string | null; first_name: string; last_name: string }, type: string, summary: string, actor: Actor) {
  if (row.institution_id) await logEvent(row.institution_id, type, `${summary} (${row.first_name} ${row.last_name})`, actor);
}

export async function resetPassword(id: string, input: { mode: "temporary" | "link"; password?: string }, actor: Actor, actorRole?: string) {
  const row = await target(id);
  guardSuper(row, actorRole);
  if (!row.auth_user_id) throw new HttpError(409, "This account has no sign-in to reset.");

  if (input.mode === "link") {
    if (row.email.endsWith(".myclassassist.in") && /^(students|parents)\./.test(row.email.split("@")[1] ?? "")) {
      throw new HttpError(400, "Student and parent accounts have no real mailbox. Set a temporary password instead.");
    }
    const { error } = await supabasePublic.auth.resetPasswordForEmail(row.email, { redirectTo: `${process.env.APP_URL ?? ""}/change-password` });
    if (error) throw new HttpError(502, `The reset email could not be sent: ${error.message}`);
    await log(row, "password_reset_link", "Password reset link sent", actor);
    return { mode: "link" as const, sent_to: row.email };
  }

  guardSelf(id, actor, "set a temporary password for");
  const password = input.password ?? generatePassword();
  await checkPassword(password, [row.email, row.email.split("@")[0]]);
  const { error } = await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, { password });
  if (error) throw new HttpError(502, error.message);
  check(await supabaseAdmin.from("user_profiles").update({ must_change_password: true, failed_login_count: 0, locked_until: null }).eq("id", id).select("id"));
  await endSessions({ profileId: id }, actor.profileId);
  await log(row, "password_reset", "Temporary password set", actor);
  // shown once to the administrator; never stored
  return { mode: "temporary" as const, temporary_password: password };
}

export async function setAccountState(id: string, state: "disable" | "enable" | "unlock", actor: Actor, actorRole?: string) {
  const row = await target(id);
  guardSuper(row, actorRole);
  if (state === "disable") {
    guardSelf(id, actor, "disable");
    check(await supabaseAdmin.from("user_profiles").update({ status: "suspended", updated_at: nowIso() }).eq("id", id).select("id"));
    if (row.auth_user_id) await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, { ban_duration: "876000h" });
    await endSessions({ profileId: id }, actor.profileId);
    await log(row, "user_disabled", "Account turned off", actor);
  } else if (state === "enable") {
    check(await supabaseAdmin.from("user_profiles").update({ status: "active", failed_login_count: 0, locked_until: null, updated_at: nowIso() }).eq("id", id).select("id"));
    if (row.auth_user_id) await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, { ban_duration: "none" });
    await log(row, "user_enabled", "Account turned on", actor);
  } else {
    check(await supabaseAdmin.from("user_profiles").update({ failed_login_count: 0, locked_until: null }).eq("id", id).select("id"));
    await log(row, "user_unlocked", "Account unlocked", actor);
  }
  return { success: true };
}

// ═════════════ login activity ═════════════
export async function loginHistory(query: Record<string, unknown>, successOnly: boolean | null) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("login_events")
    .select("id, email, success, reason, ip_address, user_agent, created_at, institutions:institution_id(name, code), user_profiles:user_profile_id(first_name, last_name, roles:role_id(display_name))", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (successOnly === true) q = q.eq("success", true);
  if (successOnly === false) q = q.eq("success", false);
  const search = safeSearch(query.search);
  if (search) q = q.or(`email.ilike.%${search}%,ip_address.ilike.%${search}%`);
  if (typeof query.reason === "string" && /^[a-z_]{1,30}$/.test(query.reason)) q = q.eq("reason", query.reason);
  const res = await q;
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const [ok, bad] = await Promise.all([
    supabaseAdmin.from("login_events").select("*", { count: "exact", head: true }).eq("success", true).eq("reason", "ok").gte("created_at", since),
    supabaseAdmin.from("login_events").select("*", { count: "exact", head: true }).eq("success", false).gte("created_at", since),
  ]);
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize, last24h: { signed_in: ok.count ?? 0, failed: bad.count ?? 0 } };
}

export async function lockedAccounts() {
  return check(
    await supabaseAdmin
      .from("user_profiles")
      .select("id, email, first_name, last_name, locked_until, last_failed_at, institutions:institution_id(name)")
      .gt("locked_until", nowIso())
      .order("locked_until", { ascending: false })
      .limit(100)
  );
}

export async function activeSessions(query: Record<string, unknown>) {
  const p = parsePage(query);
  const timeout = await getSetting<number>("security.session_timeout_minutes", 480);
  const fresh = new Date(Date.now() - timeout * 60_000).toISOString();
  let q = supabaseAdmin
    .from("user_sessions")
    .select("session_id, ip_address, user_agent, created_at, last_seen_at, user_profile_id, user_profiles:user_profile_id(email, first_name, last_name, institution_id, roles:role_id(display_name), institutions:institution_id(name))", { count: "exact" })
    .is("revoked_at", null)
    .gte("last_seen_at", fresh)
    .order("last_seen_at", { ascending: false })
    .range(p.from, p.to);
  const res = await q;
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize, timeout_minutes: timeout };
}

export async function endSession(sessionId: string, actor: Actor) {
  const n = await endSessions({ sessionId }, actor.profileId);
  if (!n) throw new HttpError(404, "That session is already over.");
  return { ended: n };
}
export async function endAllSessions(profileId: string, actor: Actor) {
  return { ended: await endSessions({ profileId }, actor.profileId) };
}

// ═════════════ student accounts ═════════════
export async function listStudentAccounts(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("students")
    .select("id, registration_no, first_name, last_name, status, institution_id, user_profile_id, institutions:institution_id(name, code), user_profiles:user_profile_id(status, last_login_at, locked_until)", { count: "exact" })
    .is("deleted_at", null)
    .order("registration_no")
    .range(p.from, p.to);
  if (typeof query.school === "string" && /^[0-9a-f-]{36}$/i.test(query.school)) q = q.eq("institution_id", query.school);
  if (query.account === "with") q = q.not("user_profile_id", "is", null);
  if (query.account === "without") q = q.is("user_profile_id", null);
  const search = safeSearch(query.search);
  if (search) q = q.or(`registration_no.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);
  const res = await q;
  const domain = await getSetting<string>("accounts.student_login_domain", "students.myclassassist.in");
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize, login_domain: domain };
}

export interface Credential { student_id?: string; guardian_id?: string; name: string; login_id: string; temporary_password: string }

/** Creates sign-in accounts for students. The student signs in with their registration number. */
export async function createStudentAccounts(studentIds: string[], actor: Actor, actorRole?: string): Promise<{ created: Credential[]; skipped: { id: string; reason: string }[] }> {
  const rows = check(
    await supabaseAdmin.from("students").select("id, registration_no, first_name, last_name, institution_id, user_profile_id, status").in("id", studentIds).is("deleted_at", null)
  ) as { id: string; registration_no: string; first_name: string; last_name: string; institution_id: string; user_profile_id: string | null; status: string }[];
  const domain = await getSetting<string>("accounts.student_login_domain", "students.myclassassist.in");
  const created: Credential[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of studentIds) if (!rows.some((r) => r.id === id)) skipped.push({ id, reason: "Student not found." });

  for (const s of rows) {
    if (s.user_profile_id) { skipped.push({ id: s.id, reason: "Already has an account." }); continue; }
    const password = generatePassword();
    try {
      const user = (await createUser(
        { email: `${s.registration_no.toLowerCase()}@${domain}`, password, first_name: s.first_name, last_name: s.last_name, role: "Student", institution_id: s.institution_id, must_change_password: true },
        actorRole
      )) as unknown as { id: string };
      check(await supabaseAdmin.from("students").update({ user_profile_id: user.id }).eq("id", s.id).select("id"));
      created.push({ student_id: s.id, name: `${s.first_name} ${s.last_name}`.trim(), login_id: s.registration_no, temporary_password: password });
    } catch (err) {
      skipped.push({ id: s.id, reason: err instanceof Error ? err.message : "Could not create the account." });
    }
  }
  if (created.length) {
    const school = rows[0]?.institution_id;
    if (school) await logEvent(school, "student_accounts", `Created ${created.length} student sign-in account(s)`, actor);
  }
  return { created, skipped };
}

// ═════════════ parent accounts ═════════════
export async function listParentAccounts(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("guardians")
    .select("id, full_name, phone, email, institution_id, user_profile_id, institutions:institution_id(name, code), user_profiles:user_profile_id(status, last_login_at, locked_until), student_guardians(students:student_id(first_name, last_name))", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (typeof query.school === "string" && /^[0-9a-f-]{36}$/i.test(query.school)) q = q.eq("institution_id", query.school);
  if (query.account === "with") q = q.not("user_profile_id", "is", null);
  if (query.account === "without") q = q.is("user_profile_id", null);
  const search = safeSearch(query.search);
  if (search) q = q.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%`);
  const res = await q;
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

export async function createParentAccount(guardianId: string, actor: Actor, actorRole?: string): Promise<Credential> {
  const g = check(await supabaseAdmin.from("guardians").select("id, full_name, phone, institution_id, user_profile_id").eq("id", guardianId).maybeSingle()) as
    | { id: string; full_name: string; phone: string; institution_id: string; user_profile_id: string | null } | null;
  if (!g) throw new HttpError(404, "Guardian not found.");
  if (g.user_profile_id) throw new HttpError(409, "This parent already has an account.");
  const digits = g.phone.replace(/\D/g, "").slice(-10);
  if (digits.length < 10) throw new HttpError(400, "This guardian has no valid 10-digit mobile number.");
  const domain = await getSetting<string>("accounts.parent_login_domain", "parents.myclassassist.in");
  const [first, ...rest] = g.full_name.trim().split(/\s+/);
  const password = generatePassword();
  const user = (await createUser(
    { email: `${digits}@${domain}`, password, first_name: first || "Parent", last_name: rest.join(" ") || "-", phone: digits, role: "Parent", institution_id: g.institution_id, must_change_password: true },
    actorRole
  )) as unknown as { id: string };
  check(await supabaseAdmin.from("guardians").update({ user_profile_id: user.id }).eq("id", g.id).select("id"));
  await logEvent(g.institution_id, "parent_account", `Created a parent sign-in account (${g.full_name})`, actor);
  return { guardian_id: g.id, name: g.full_name, login_id: digits, temporary_password: password };
}

/** For the Create dialog: which roles can be created, and whether the school's plan has room for staff. */
export async function assertCanCreateStaff(institutionId: string | null | undefined, role: string) {
  if (institutionId && !["SuperAdmin", "Student", "Parent"].includes(role)) await assertRoomFor(institutionId, "staff");
}
