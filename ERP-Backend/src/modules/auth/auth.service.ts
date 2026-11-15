import { supabaseAdmin, supabasePublic } from "../../../db/client";
import { HttpError } from "../../lib/http-error";
import { getEntitlements } from "../../lib/entitlements";
import { endOtherSessions, endSessions, recordSession, sessionIdOf } from "../../lib/sessions";
import { isIpBlocked } from "../admin/security.service";
import { maintenanceState } from "../../lib/maintenance";
import { getSetting } from "../admin/settings.service";
import { CODE_TTL_MS, MAX_ATTEMPTS, TRUST_DAYS, deliverCode, hashCode, hashToken, newCode, newDeviceToken, safeEqualHex } from "./otp";

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────
export interface LoginPayload {
  email: string;
  password: string;
  /** A token from a device the person chose to trust: skips the code. */
  deviceToken?: string;
}

/** Returned instead of a session when the person must now enter the code that was just sent. */
export interface CodeRequired {
  code_required: true;
  challenge_id: string;
  channel: "sms" | "email" | "console";
  sent_to: string;
  expires_in_seconds: number;
}

export interface AuthSession {
  token: string;
  refreshToken: string;
  expiresAt: number | undefined;
  user: {
    id: string;
    email: string | undefined;
    profileId: string | undefined;
    fullName: string;
    role: string;
    roleDisplayName: string;
    institutionId: string | undefined;
    campusId: string | undefined;
  };
}

export interface RoleItem {
  name: string;
  display_name: string;
  description?: string;
}

// ─────────────────────────────────────────────
//  Service Methods
// ─────────────────────────────────────────────

export interface LoginContext {
  ip: string | null;
  userAgent: string | null;
}

async function logEvent(email: string, success: boolean, reason: string, ctx: LoginContext, profile?: { id: string; institution_id: string | null } | null) {
  const res = await supabaseAdmin.from("login_events").insert({
    email: email.slice(0, 320), user_profile_id: profile?.id ?? null, institution_id: profile?.institution_id ?? null,
    success, reason, ip_address: ctx.ip, user_agent: ctx.userAgent?.slice(0, 300) ?? null,
  });
  if (res.error) console.error("Login event not recorded:", res.error.message);
}

/** A student can type just their registration number; it maps to the account created for them. */
export async function loginEmailFor(input: string): Promise<string> {
  const id = input.trim().toLowerCase();
  if (id.includes("@")) return id;
  const domain = await getSetting<string>("accounts.student_login_domain", "students.myclassassist.in");
  return `${id}@${domain}`;
}

/**
 * Authenticate with email (or student registration number) and password.
 * Records every attempt, locks an account after too many wrong passwords, and starts a tracked session.
 */
export async function loginUser(payload: LoginPayload, ctx: LoginContext = { ip: null, userAgent: null }, opts: { skipCode?: boolean } = {}): Promise<AuthSession | CodeRequired> {
  if (ctx.ip && (await isIpBlocked(ctx.ip))) throw new HttpError(403, "Sign-ins from this network address are blocked. Contact your administrator if you think this is a mistake.");
  const email = await loginEmailFor(payload.email);
  const { password } = payload;

  const profile = (await supabaseAdmin
    .from("user_profiles")
    .select("id, status, institution_id, failed_login_count, locked_until, role_id, campus_id, first_name, last_name, phone, otp_enabled, roles:role_id(name, display_name)")
    .eq("email", email)
    .maybeSingle()).data as
    | { id: string; status: string | null; institution_id: string | null; failed_login_count: number; locked_until: string | null; role_id: string; campus_id: string | null; first_name: string; last_name: string; phone: string | null; otp_enabled: boolean; roles: { name?: string; display_name?: string } | null }
    | null;

  if (profile?.locked_until && new Date(profile.locked_until).getTime() > Date.now()) {
    await logEvent(email, false, "locked", ctx, profile);
    const mins = Math.max(1, Math.ceil((new Date(profile.locked_until).getTime() - Date.now()) / 60_000));
    throw new HttpError(423, `Too many wrong passwords. This account is locked for ${mins} more minute${mins === 1 ? "" : "s"}, or until an administrator unlocks it.`);
  }

  const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    const credentials = !error || /invalid login credentials/i.test(error.message);
    if (!credentials) throw new HttpError(401, error!.message);
    if (!profile) {
      await logEvent(email, false, "unknown_email", ctx);
    } else {
      const [maxFails, lockMinutes] = await Promise.all([getSetting<number>("security.max_failed_logins", 5), getSetting<number>("security.lockout_minutes", 15)]);
      const count = (profile.failed_login_count ?? 0) + 1;
      const lock = count >= maxFails;
      await supabaseAdmin
        .from("user_profiles")
        .update({ failed_login_count: lock ? 0 : count, last_failed_at: new Date().toISOString(), locked_until: lock ? new Date(Date.now() + lockMinutes * 60_000).toISOString() : null })
        .eq("id", profile.id);
      await logEvent(email, false, lock ? "locked" : "bad_password", ctx, profile);
    }
    throw new HttpError(401, "Invalid email or password.");
  }

  const roleData = profile?.roles ?? {};
  const blocked = async (reason: "suspended" | "school_inactive" | "no_profile", message: string): Promise<never> => {
    await logEvent(email, false, reason, ctx, profile);
    await supabasePublic.auth.signOut().catch(() => undefined);
    throw new HttpError(403, message);
  };

  // planned work: school users cannot sign in, the platform team can
  if (profile?.institution_id && roleData.name !== "SuperAdmin") {
    const m = await maintenanceState();
    if (m.active) throw new HttpError(503, m.message);
  }

  if (profile && profile.status && profile.status !== "active") return blocked("suspended", "This account is turned off. Contact your administrator.");
  if (profile?.institution_id && roleData.name !== "SuperAdmin") {
    const ent = await getEntitlements(profile.institution_id);
    if (["Pending", "Suspended", "Inactive"].includes(ent.status)) return blocked("school_inactive", `This school is ${ent.status.toLowerCase()}. Contact My Class Assist support.`);
  }

  // second step: platform staff (when required) and anyone who turned it on enter a code sent to their phone
  if (profile && !opts.skipCode && (await codeRequiredFor(profile, roleData.name)) && !(await deviceTrusted(profile.id, payload.deviceToken))) {
    // the password was right, but no session is handed out until the code is entered
    await supabaseAdmin.auth.admin.signOut(data.session.access_token, "local").catch(() => undefined);
    return startChallenge(email, profile, ctx);
  }

  if (profile) {
    await supabaseAdmin.from("user_profiles").update({ failed_login_count: 0, locked_until: null, last_login_at: new Date().toISOString() }).eq("id", profile.id);
    const sid = sessionIdOf(data.session.access_token);
    if (sid) {
      await recordSession(sid, profile.id, ctx.ip, ctx.userAgent);
      if (!profile.institution_id && (await getSetting<boolean>("security.single_session_staff", false))) await endOtherSessions(profile.id, sid);
    }
  }
  await logEvent(email, true, "ok", ctx, profile);

  return {
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: {
      id: data.user.id,
      email: data.user.email,
      profileId: profile?.id,
      fullName: profile ? `${profile.first_name} ${profile.last_name}` : email.split("@")[0],
      role: roleData.name ?? "SuperAdmin",
      roleDisplayName: roleData.display_name ?? "Super Administrator",
      institutionId: profile?.institution_id ?? undefined,
      campusId: profile?.campus_id ?? undefined,
    },
  };
}

/** Ends the caller's own tracked session and notes the sign-out. */
export async function logoutUser(token: string, profile: { id: string; email: string; institution_id: string | null } | null, ctx: LoginContext) {
  const sid = sessionIdOf(token);
  if (sid) await endSessions({ sessionId: sid }, profile?.id);
  if (profile) await logEvent(profile.email, true, "sign_out", ctx, profile);
}

/**
 * Fetch role + permissions for the currently logged-in user.
 */
export async function getUserProfile(roleName: string) {
  const { data: rolePermissions } = await supabaseAdmin
    .from("roles")
    .select("id, name, display_name, role_permissions(permissions(code, module))")
    .eq("name", roleName)
    .single();

  return rolePermissions ?? null;
}

/**
 * List all ERP roles from the DB; falls back to static defaults.
 */
export async function listRoles(): Promise<RoleItem[]> {
  const { data: roles, error } = await supabaseAdmin
    .from("roles")
    .select("id, name, display_name, description")
    .order("name", { ascending: true });

  if (error || !roles?.length) {
    return [
      { name: "SuperAdmin", display_name: "Super Administrator" },
      { name: "InstitutionAdmin", display_name: "Institution Administrator" },
      { name: "Principal", display_name: "Principal / Director" },
      { name: "Registrar", display_name: "Registrar / Academic Office" },
      { name: "Faculty", display_name: "Faculty / Teacher" },
      { name: "Student", display_name: "Student" },
      { name: "Parent", display_name: "Parent / Guardian" },
      { name: "Accountant", display_name: "Accountant" },
    ];
  }

  return roles;
}

// ═════════════ sign-in codes ═════════════
async function codeRequiredFor(profile: { id: string; institution_id: string | null; otp_enabled: boolean }, roleName?: string): Promise<boolean> {
  if (profile.otp_enabled) return true;
  if (profile.institution_id) return roleName === "InstitutionAdmin" && getSetting<boolean>("security.require_2fa_school_admins", false);
  return getSetting<boolean>("security.require_2fa_staff", false);
}

async function deviceTrusted(profileId: string, token?: string): Promise<boolean> {
  if (!token || token.length < 20 || token.length > 100) return false;
  const row = (await supabaseAdmin.from("trusted_devices").select("id").eq("profile_id", profileId).eq("token_hash", hashToken(token)).gt("expires_at", new Date().toISOString()).maybeSingle()).data as { id: string } | null;
  if (!row) return false;
  await supabaseAdmin.from("trusted_devices").update({ last_used_at: new Date().toISOString() }).eq("id", row.id);
  return true;
}

async function startChallenge(
  email: string,
  profile: { id: string; first_name: string; phone: string | null; institution_id: string | null },
  ctx: LoginContext
): Promise<CodeRequired> {
  // a new code replaces any earlier one; asking again too quickly is refused
  const last = (await supabaseAdmin.from("login_challenges").select("created_at").eq("profile_id", profile.id).is("used_at", null).order("created_at", { ascending: false }).limit(1)).data as { created_at: string }[] | null;
  if (last?.[0] && Date.now() - new Date(last[0].created_at).getTime() < 30_000) {
    throw new HttpError(429, "A code was sent a moment ago. Wait 30 seconds before asking for another.");
  }
  await supabaseAdmin.from("login_challenges").update({ used_at: new Date().toISOString() }).eq("profile_id", profile.id).is("used_at", null);

  const code = newCode();
  const ins = await supabaseAdmin
    .from("login_challenges")
    .insert({ profile_id: profile.id, code_hash: "pending", channel: "console", expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(), ip_address: ctx.ip })
    .select("id")
    .single();
  if (ins.error) throw new HttpError(500, ins.error.message);
  const id = (ins.data as { id: string }).id;

  let delivery;
  try {
    delivery = await deliverCode({ email, first_name: profile.first_name, phone: profile.phone }, code);
  } catch (err) {
    await supabaseAdmin.from("login_challenges").delete().eq("id", id);
    throw err;
  }
  await supabaseAdmin.from("login_challenges").update({ code_hash: hashCode(code, id), channel: delivery.channel, sent_to: delivery.sent_to }).eq("id", id);
  await logEvent(email, false, "code_sent", ctx, profile);
  return { code_required: true, challenge_id: id, channel: delivery.channel, sent_to: delivery.sent_to, expires_in_seconds: CODE_TTL_MS / 1000 };
}

/** Sends the code again for a sign-in that is waiting for it. Needs the password again, so it cannot be used to spam someone. */
export async function resendCode(payload: LoginPayload, ctx: LoginContext) {
  return loginUser({ ...payload, deviceToken: undefined }, ctx);
}

/**
 * Step two: the code. The password is checked again at the same time, so the code alone is never enough.
 * Wrong codes count against the same limit as wrong passwords.
 */
export async function verifyLoginCode(
  payload: LoginPayload & { challengeId: string; code: string; trustDevice?: boolean },
  ctx: LoginContext
): Promise<AuthSession & { deviceToken?: string }> {
  const email = await loginEmailFor(payload.email);
  const profile = (await supabaseAdmin.from("user_profiles").select("id, institution_id, failed_login_count, locked_until, first_name, last_name").eq("email", email).maybeSingle()).data as
    | { id: string; institution_id: string | null; failed_login_count: number; locked_until: string | null; first_name: string; last_name: string } | null;
  const bad = () => new HttpError(401, "That code is not right. Check the latest message and try again.");
  if (!profile) throw bad();
  if (profile.locked_until && new Date(profile.locked_until).getTime() > Date.now()) {
    throw new HttpError(423, "Too many wrong attempts. This account is locked for a while, or until an administrator unlocks it.");
  }

  const ch = (await supabaseAdmin.from("login_challenges").select("id, code_hash, attempts, expires_at, used_at").eq("id", payload.challengeId).eq("profile_id", profile.id).maybeSingle()).data as
    | { id: string; code_hash: string; attempts: number; expires_at: string; used_at: string | null } | null;
  if (!ch || ch.used_at) throw new HttpError(401, "This code is no longer valid. Sign in again to get a new one.");
  if (new Date(ch.expires_at).getTime() < Date.now()) throw new HttpError(401, "This code has expired. Sign in again to get a new one.");

  const ok = /^\d{6}$/.test(payload.code) && ch.attempts < MAX_ATTEMPTS && safeEqualHex(hashCode(payload.code, ch.id), ch.code_hash);
  if (!ok) {
    const attempts = ch.attempts + 1;
    await supabaseAdmin.from("login_challenges").update(attempts >= MAX_ATTEMPTS ? { attempts, used_at: new Date().toISOString() } : { attempts }).eq("id", ch.id);
    const [maxFails, lockMinutes] = await Promise.all([getSetting<number>("security.max_failed_logins", 5), getSetting<number>("security.lockout_minutes", 15)]);
    const count = (profile.failed_login_count ?? 0) + 1;
    const lock = count >= maxFails;
    await supabaseAdmin.from("user_profiles").update({ failed_login_count: lock ? 0 : count, last_failed_at: new Date().toISOString(), locked_until: lock ? new Date(Date.now() + lockMinutes * 60_000).toISOString() : null }).eq("id", profile.id);
    await logEvent(email, false, lock ? "locked" : "code_failed", ctx, profile);
    if (attempts >= MAX_ATTEMPTS) throw new HttpError(401, "Too many wrong codes. Sign in again to get a new one.");
    throw bad();
  }

  // claim the code first so it can only ever be used once, even by two requests at the same moment
  const claimed = (await supabaseAdmin.from("login_challenges").update({ used_at: new Date().toISOString() }).eq("id", ch.id).is("used_at", null).select("id")).data as { id: string }[] | null;
  if (!claimed?.length) throw new HttpError(401, "This code was already used. Sign in again.");

  let session: AuthSession;
  try {
    session = (await loginUser({ email: payload.email, password: payload.password }, ctx, { skipCode: true })) as AuthSession;
  } catch (err) {
    // a wrong password must not burn a right code: give the code back (the wrong password already counted against the limit)
    await supabaseAdmin.from("login_challenges").update({ used_at: null }).eq("id", ch.id);
    throw err;
  }
  let deviceToken: string | undefined;
  const rememberDays = await getSetting<number>("security.remember_device_days", TRUST_DAYS);
  if (payload.trustDevice && rememberDays > 0) {
    deviceToken = newDeviceToken();
    await supabaseAdmin.from("trusted_devices").insert({
      profile_id: profile.id, token_hash: hashToken(deviceToken), label: (ctx.userAgent ?? "Unknown device").slice(0, 200),
      expires_at: new Date(Date.now() + rememberDays * 86_400_000).toISOString(),
    });
  }
  return { ...session, deviceToken };
}
