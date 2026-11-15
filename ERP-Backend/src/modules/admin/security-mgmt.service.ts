import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { parsePage } from "../../lib/query";
import { endSessions } from "../../lib/sessions";
import { getSetting } from "./settings.service";
import { isIpBlocked } from "./security.service";

const DAY = 86_400_000;
const HOUR = 3_600_000;

// ═════════════ incidents ═════════════
export const SEVERITIES = ["Low", "Medium", "High"] as const;
export const INCIDENT_STATUSES = ["Open", "Investigating", "Mitigated", "Resolved"] as const;

export const incidentCode = (seq: number) => "INC-" + String(seq).padStart(3, "0");

export async function listIncidents() {
  const rows = check(
    await supabaseAdmin.from("security_incidents").select("id, seq, title, severity, status, notes, started_at, resolved_at, updated_at").order("started_at", { ascending: false }).limit(200)
  ) as { seq: number }[];
  return rows.map((r) => ({ ...r, code: incidentCode(r.seq) }));
}

export async function createIncident(input: { title: string; severity: (typeof SEVERITIES)[number]; notes?: string; started_at?: string }, actorProfileId?: string) {
  const row = check(
    await supabaseAdmin
      .from("security_incidents")
      .insert({ title: input.title, severity: input.severity, notes: input.notes ?? "", started_at: input.started_at ?? new Date().toISOString(), created_by: actorProfileId ?? null })
      .select("id, seq, title, severity, status, notes, started_at, resolved_at, updated_at")
      .single()
  ) as { seq: number };
  return { ...row, code: incidentCode(row.seq) };
}

export async function updateIncident(id: string, patch: { title?: string; severity?: (typeof SEVERITIES)[number]; status?: (typeof INCIDENT_STATUSES)[number]; notes?: string }) {
  const update: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  if (patch.status) update.resolved_at = patch.status === "Resolved" ? new Date().toISOString() : null;
  const row = check(
    await supabaseAdmin.from("security_incidents").update(update).eq("id", id).select("id, seq, title, severity, status, notes, started_at, resolved_at, updated_at").maybeSingle()
  ) as { seq: number } | null;
  if (!row) throw new HttpError(404, "Incident not found.");
  return { ...row, code: incidentCode(row.seq) };
}

// ═════════════ alerts ═════════════
export interface SecurityAlert {
  id: string;
  severity: "Low" | "Medium" | "High";
  title: string;
  detail: string;
  when: string;
  ip?: string;
  blocked?: boolean;
}

/** Counts per address, for the failed sign-ins in the window. */
export function burstsByIp(events: { ip_address: string | null }[], threshold: number): { ip: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) if (e.ip_address) counts.set(e.ip_address, (counts.get(e.ip_address) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= threshold).map(([ip, count]) => ({ ip, count })).sort((a, b) => b.count - a.count);
}

/**
 * Things that look wrong right now, worked out from the sign-in, lockout and access records.
 * They are not stored: an alert goes away when its cause does. To follow one up, open an incident.
 */
export async function listAlerts(): Promise<SecurityAlert[]> {
  const nowIso = new Date().toISOString();
  const hourAgo = new Date(Date.now() - HOUR).toISOString();
  const dayAgo = new Date(Date.now() - DAY).toISOString();
  const alerts: SecurityAlert[] = [];

  const [failed, locked, denied, staff, required] = await Promise.all([
    supabaseAdmin.from("login_events").select("ip_address, email, reason, created_at").eq("success", false).gte("created_at", hourAgo).limit(5000),
    supabaseAdmin.from("user_profiles").select("id, email, first_name, last_name, locked_until, last_failed_at").gt("locked_until", nowIso).limit(50),
    supabaseAdmin.from("access_denied_events").select("*", { count: "exact", head: true }).gte("created_at", dayAgo),
    supabaseAdmin.from("user_profiles").select("id, first_name, last_name, email, otp_enabled, roles:role_id!inner(name)").is("institution_id", null).eq("status", "active").eq("otp_enabled", false).limit(100),
    getSetting<boolean>("security.require_2fa_staff", false),
  ]);

  const events = (failed.data ?? []) as { ip_address: string | null; email: string; reason: string; created_at: string }[];
  for (const b of burstsByIp(events, 5)) {
    alerts.push({
      id: "burst:" + b.ip, severity: b.count >= 15 ? "High" : "Medium", title: `${b.count} failed sign-ins from one address in the last hour`,
      detail: `Address ${b.ip}. Could be someone guessing passwords.`, when: events.filter((e) => e.ip_address === b.ip)[0].created_at, ip: b.ip, blocked: await isIpBlocked(b.ip),
    });
  }
  const unknown = events.filter((e) => e.reason === "unknown_email");
  if (unknown.length >= 5) alerts.push({ id: "unknown-email", severity: "Low", title: `${unknown.length} sign-in attempts for emails that have no account`, detail: "In the last hour. Often a sign of someone trying addresses at random.", when: unknown[0].created_at });
  for (const u of (locked.data ?? []) as { id: string; email: string; first_name: string; last_name: string; locked_until: string; last_failed_at: string | null }[]) {
    alerts.push({ id: "locked:" + u.id, severity: "Medium", title: `${u.first_name} ${u.last_name} is locked out`, detail: `${u.email} was locked after too many wrong passwords, until ${new Date(u.locked_until).toLocaleString("en-IN")}.`, when: u.last_failed_at ?? u.locked_until });
  }
  if ((denied.count ?? 0) >= 20) alerts.push({ id: "denied", severity: "Low", title: `${denied.count} blocked attempts to open pages without permission`, detail: "In the last 24 hours. Someone may be exploring areas their role cannot use.", when: nowIso });
  const staffNo2fa = ((staff.data ?? []) as unknown[]).length;
  if (required && staffNo2fa > 0) alerts.push({ id: "no-2fa", severity: "Medium", title: `${staffNo2fa} team member${staffNo2fa === 1 ? "" : "s"} without a mobile number or code set up`, detail: "Two-factor sign-in is required for the team. Check that each person has a mobile number or working email.", when: nowIso });

  const rank = { High: 0, Medium: 1, Low: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || b.when.localeCompare(a.when));
}

// ═════════════ devices ═════════════
export async function listDevices() {
  const rows = check(
    await supabaseAdmin
      .from("trusted_devices")
      .select("id, label, created_at, last_used_at, expires_at, user_profiles:profile_id(first_name, last_name, email, institution_id, roles:role_id(display_name))")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(300)
  ) as unknown as { created_at: string }[];
  const newSince = Date.now() - 7 * DAY;
  return rows.map((r) => ({ ...r, is_new: new Date(r.created_at).getTime() > newSince }));
}

export async function removeDevice(id: string) {
  const rows = check(await supabaseAdmin.from("trusted_devices").delete().eq("id", id).select("id")) as unknown[];
  if (!rows.length) throw new HttpError(404, "That device was already removed.");
  return { success: true };
}

/** Ends every signed-in session except the caller's own. */
export async function endOtherSessionsOfEveryone(keepSessionId: string | null, actorProfileId?: string) {
  let q = supabaseAdmin.from("user_sessions").select("session_id").is("revoked_at", null);
  if (keepSessionId) q = q.neq("session_id", keepSessionId);
  const rows = check(await q.limit(5000)) as { session_id: string }[];
  let ended = 0;
  for (const r of rows) ended += await endSessions({ sessionId: r.session_id }, actorProfileId);
  return { ended };
}

// ═════════════ data changes ═════════════
/** Changes that recorded what a value was and what it became. */
export async function listDataChanges(query: Record<string, unknown>) {
  const p = parsePage(query);
  const res = await supabaseAdmin
    .from("audit_logs")
    .select("id, actor_email, action, entity_name, entity_id, old_data, new_data, created_at", { count: "exact" })
    .not("old_data", "is", null)
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

// ═════════════ retention ═════════════
export const RETENTION = {
  login_events: { setting: "retention.login_events_days", table: "login_events", column: "created_at", fallback: 365 },
  audit_logs: { setting: "retention.audit_logs_days", table: "audit_logs", column: "created_at", fallback: 1095 },
} as const;

export async function retentionStatus() {
  const out: Record<string, { days: number; rows: number; oldest: string | null }> = {};
  for (const [key, r] of Object.entries(RETENTION)) {
    const [days, count, oldest] = await Promise.all([
      getSetting<number>(r.setting, r.fallback),
      supabaseAdmin.from(r.table).select("*", { count: "exact", head: true }),
      supabaseAdmin.from(r.table).select(r.column).order(r.column, { ascending: true }).limit(1),
    ]);
    out[key] = { days, rows: count.count ?? 0, oldest: ((oldest.data ?? [])[0] as unknown as Record<string, string> | undefined)?.[r.column] ?? null };
  }
  return out;
}

/** Deletes records older than their retention period. Returns how many went. */
export async function runRetention(): Promise<{ login_events: number; audit_logs: number }> {
  const result = { login_events: 0, audit_logs: 0 };
  for (const [key, r] of Object.entries(RETENTION) as [keyof typeof RETENTION, (typeof RETENTION)[keyof typeof RETENTION]][]) {
    const days = await getSetting<number>(r.setting, r.fallback);
    const cutoff = new Date(Date.now() - days * DAY).toISOString();
    const { data } = await supabaseAdmin.from(r.table).delete().lt(r.column, cutoff).select("id");
    result[key] = data?.length ?? 0;
  }
  return result;
}

// ═════════════ two-factor coverage ═════════════
/** Platform team members, with whether they can receive a sign-in code. */
export async function staffMfaStatus() {
  const rows = check(
    await supabaseAdmin
      .from("user_profiles")
      .select("id, first_name, last_name, email, phone, otp_enabled, last_login_at, roles:role_id!inner(display_name)")
      .is("institution_id", null)
      .eq("status", "active")
      .order("first_name")
      .limit(200)
  ) as unknown as { id: string; first_name: string; last_name: string; email: string; phone: string | null; otp_enabled: boolean; last_login_at: string | null; roles: { display_name: string } }[];
  const required = await getSetting<boolean>("security.require_2fa_staff", false);
  return { required, people: rows.map((r) => ({ ...r, has_phone: !!r.phone, code_on: required || r.otp_enabled })) };
}
