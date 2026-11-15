import { supabaseAdmin, supabasePublic } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { checkPassword } from "../../lib/password-policy";
import { normalizePhone } from "../../lib/sms";
import { endSessions, sessionIdOf } from "../../lib/sessions";
import { getSetting } from "../admin/settings.service";
import { deliveryAvailable } from "./otp";

interface Me { profileId?: string; email: string; role: string }

async function profileRow(profileId: string) {
  return check(
    await supabaseAdmin.from("user_profiles").select("id, email, first_name, last_name, phone, otp_enabled, institution_id, status, created_at, last_login_at, roles:role_id(name, display_name)").eq("id", profileId).maybeSingle()
  ) as unknown as { id: string; email: string; first_name: string; last_name: string; phone: string | null; otp_enabled: boolean; institution_id: string | null; status: string; created_at: string; last_login_at: string | null; roles: { name: string; display_name: string } | null } | null;
}

function bootstrapList(): string[] {
  return (process.env.SUPER_ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** Everything the account page shows. */
/** Whether the platform makes this person enter a sign-in code: platform staff, and school administrators when that is switched on. */
async function twoFactorRequired(p: { institution_id: string | null; roles: { name: string } | null }): Promise<boolean> {
  if (!p.institution_id) return getSetting<boolean>("security.require_2fa_staff", false);
  if (p.roles?.name === "InstitutionAdmin") return getSetting<boolean>("security.require_2fa_school_admins", false);
  return false;
}

export async function getAccount(me: Me) {
  const d = await deliveryAvailable();
  if (!me.profileId) {
    return { has_profile: false, can_create_profile: bootstrapList().includes(me.email.toLowerCase()), email: me.email, role: me.role };
  }
  const p = (await profileRow(me.profileId))!;
  const required = await twoFactorRequired(p);
  return {
    has_profile: true,
    profile: { id: p.id, email: p.email, first_name: p.first_name, last_name: p.last_name, phone: p.phone, role: p.roles?.display_name ?? me.role, created_at: p.created_at, last_login_at: p.last_login_at },
    two_factor: {
      enabled: p.otp_enabled || required,
      own_setting: p.otp_enabled,
      required_by_platform: required,
      sms_ready: d.sms,
      email_ready: d.email,
      sent_by: d.sms && p.phone && normalizePhone(p.phone) ? "sms" : d.email ? "email" : process.env.NODE_ENV !== "production" ? "console" : "none",
    },
  };
}

function cleanPhone(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const n = normalizePhone(raw);
  if (!n) throw new HttpError(400, "Enter a valid mobile number, for example 98765 43210.");
  return n.length === 12 && n.startsWith("91") ? n.slice(2) : `+${n}`;
}

export async function updateProfile(me: Me, input: { first_name?: string; last_name?: string; phone?: string | null }) {
  if (!me.profileId) throw new HttpError(409, "Create your profile first.");
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.first_name !== undefined) patch.first_name = input.first_name;
  if (input.last_name !== undefined) patch.last_name = input.last_name;
  if (input.phone !== undefined) patch.phone = cleanPhone(input.phone);
  check(await supabaseAdmin.from("user_profiles").update(patch).eq("id", me.profileId).select("id"));
  return getAccount(me);
}

/** The first administrator signs in through an email listed in SUPER_ADMIN_EMAILS and has no profile yet. This makes the real one. */
export async function createBootstrapProfile(authUserId: string, me: Me, input: { first_name: string; last_name: string; phone?: string | null }) {
  if (me.profileId) throw new HttpError(409, "You already have a profile.");
  if (!bootstrapList().includes(me.email.toLowerCase())) throw new HttpError(403, "Only the first administrator can do this.");
  const role = check(await supabaseAdmin.from("roles").select("id").eq("name", "SuperAdmin").maybeSingle()) as { id: string } | null;
  if (!role) throw new HttpError(500, "The Super Administrator role is missing.");
  check(
    await supabaseAdmin.from("user_profiles").insert({
      auth_user_id: authUserId, email: me.email.toLowerCase(), first_name: input.first_name, last_name: input.last_name, phone: cleanPhone(input.phone),
      role_id: role.id, institution_id: null, status: "active", must_change_password: false,
    }).select("id")
  );
  return { created: true };
}

export async function changePassword(me: Me, accessToken: string, input: { current_password: string; new_password: string }) {
  await checkPassword(input.new_password, [me.email, me.email.split("@")[0]]);
  if (input.new_password === input.current_password) throw new HttpError(400, "Choose a password you have not used just now.");

  // the current password must be right (checked on its own, not counted as a failed sign-in)
  const probe = await supabasePublic.auth.signInWithPassword({ email: me.email, password: input.current_password });
  if (probe.error || !probe.data.session) throw new HttpError(400, "Your current password is not right.");
  const authId = probe.data.user.id;
  await supabaseAdmin.auth.admin.signOut(probe.data.session.access_token, "local").catch(() => undefined);

  const { error } = await supabaseAdmin.auth.admin.updateUserById(authId, { password: input.new_password });
  if (error) throw new HttpError(400, error.message);
  if (me.profileId) {
    await supabaseAdmin.from("user_profiles").update({ must_change_password: false }).eq("id", me.profileId);
    // every other place they were signed in ends; this one stays
    const keep = sessionIdOf(accessToken);
    const rows = (await supabaseAdmin.from("user_sessions").select("session_id").eq("user_profile_id", me.profileId).is("revoked_at", null)).data as { session_id: string }[] | null;
    for (const r of rows ?? []) if (r.session_id !== keep) await endSessions({ sessionId: r.session_id }, me.profileId);
  }
  return { success: true };
}

/** Turns the code step on or off for yourself. Platform staff cannot turn it off while the platform requires it. */
export async function setTwoFactor(me: Me, enabled: boolean) {
  if (!me.profileId) throw new HttpError(409, "Create your profile first.");
  const p = (await profileRow(me.profileId))!;
  const required = await twoFactorRequired(p);
  if (!enabled && required) throw new HttpError(400, "Your platform requires a sign-in code for your role, so it cannot be turned off.");
  if (enabled) {
    const d = await deliveryAvailable();
    if (!d.ok) throw new HttpError(400, "Codes cannot be sent yet: SMS and email are not set up. Ask the platform team.");
  }
  await supabaseAdmin.from("user_profiles").update({ otp_enabled: enabled }).eq("id", me.profileId);
  if (!enabled) await supabaseAdmin.from("trusted_devices").delete().eq("profile_id", me.profileId);
  return getAccount(me);
}

export async function listTrustedDevices(me: Me) {
  if (!me.profileId) return { devices: [] };
  return { devices: check(await supabaseAdmin.from("trusted_devices").select("id, label, created_at, last_used_at, expires_at").eq("profile_id", me.profileId).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false })) };
}
export async function removeTrustedDevice(me: Me, id: string) {
  if (!me.profileId) throw new HttpError(409, "Create your profile first.");
  check(await supabaseAdmin.from("trusted_devices").delete().eq("id", id).eq("profile_id", me.profileId).select("id"));
  return { success: true };
}

/** Your own recent sign-ins and where you are signed in now. */
export async function myActivity(me: Me, currentSessionId: string | null) {
  const events = check(await supabaseAdmin.from("login_events").select("id, success, reason, ip_address, user_agent, created_at").eq("email", me.email.toLowerCase()).order("created_at", { ascending: false }).limit(30));
  const sessions = me.profileId
    ? check(await supabaseAdmin.from("user_sessions").select("session_id, ip_address, user_agent, created_at, last_seen_at").eq("user_profile_id", me.profileId).is("revoked_at", null).order("last_seen_at", { ascending: false }).limit(20))
    : [];
  return { events, sessions, current_session_id: currentSessionId };
}

export async function endMySession(me: Me, sessionId: string) {
  if (!me.profileId) throw new HttpError(409, "Create your profile first.");
  // only your own sessions can be ended here; check before touching anything
  const row = (await supabaseAdmin.from("user_sessions").select("user_profile_id").eq("session_id", sessionId).maybeSingle()).data as { user_profile_id: string } | null;
  if (!row || row.user_profile_id !== me.profileId) throw new HttpError(404, "Session not found.");
  return { ended: await endSessions({ sessionId }, me.profileId) };
}
