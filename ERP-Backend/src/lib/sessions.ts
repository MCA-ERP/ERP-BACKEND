import { supabaseAdmin } from "../../db/client";
import { getSetting } from "../modules/admin/settings.service";

export type SessionState = "ok" | "revoked" | "idle" | "untracked";

interface Cached {
  at: number;
  state: SessionState;
  lastSeen: number;
}
const cache = new Map<string, Cached>();
const TTL_MS = 10_000;
const TOUCH_EVERY_MS = 60_000;

/** The identity provider's session id, read from the (already verified) access token. */
export function sessionIdOf(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { session_id?: unknown };
    return typeof payload.session_id === "string" && /^[0-9a-f-]{36}$/i.test(payload.session_id) ? payload.session_id : null;
  } catch {
    return null;
  }
}

/**
 * Whether a token's session may still be used. Sessions that were never recorded (signed in before tracking
 * began) are allowed; recorded ones stop working when ended by an administrator or idle past the timeout.
 */
export async function checkSession(sessionId: string): Promise<SessionState> {
  const now = Date.now();
  let c = cache.get(sessionId);
  if (!c || now - c.at > TTL_MS) {
    const { data } = await supabaseAdmin.from("user_sessions").select("revoked_at, last_seen_at").eq("session_id", sessionId).maybeSingle();
    c = { at: now, state: !data ? "untracked" : data.revoked_at ? "revoked" : "ok", lastSeen: data ? new Date(data.last_seen_at as string).getTime() : now };
    cache.set(sessionId, c);
    if (cache.size > 5000) for (const k of cache.keys()) { cache.delete(k); if (cache.size < 2500) break; }
  }
  if (c.state !== "ok") return c.state;

  const timeoutMin = await getSetting<number>("security.session_timeout_minutes", 480);
  if (now - c.lastSeen > timeoutMin * 60_000) return "idle";

  if (now - c.lastSeen > TOUCH_EVERY_MS) {
    c.lastSeen = now;
    void supabaseAdmin.from("user_sessions").update({ last_seen_at: new Date(now).toISOString() }).eq("session_id", sessionId).then(() => undefined);
  }
  return "ok";
}

export async function recordSession(sessionId: string, profileId: string, ip: string | null, userAgent: string | null) {
  const res = await supabaseAdmin.from("user_sessions").upsert({ session_id: sessionId, user_profile_id: profileId, ip_address: ip, user_agent: userAgent?.slice(0, 300) ?? null }, { onConflict: "session_id" });
  if (res.error) console.error("Session not recorded:", res.error.message);
  cache.delete(sessionId);
}

/** Ends every other session of a person, keeping the one they just signed in with. */
export async function endOtherSessions(profileId: string, keepSessionId: string): Promise<number> {
  const { data } = await supabaseAdmin.from("user_sessions").update({ revoked_at: new Date().toISOString(), revoked_by: profileId }).eq("user_profile_id", profileId).neq("session_id", keepSessionId).is("revoked_at", null).select("session_id");
  for (const r of (data ?? []) as { session_id: string }[]) cache.delete(r.session_id);
  return data?.length ?? 0;
}

export async function endSessions(filter: { sessionId?: string; profileId?: string }, by?: string): Promise<number> {
  let q = supabaseAdmin.from("user_sessions").update({ revoked_at: new Date().toISOString(), revoked_by: by ?? null }).is("revoked_at", null);
  if (filter.sessionId) q = q.eq("session_id", filter.sessionId);
  if (filter.profileId) q = q.eq("user_profile_id", filter.profileId);
  const { data } = await q.select("session_id");
  for (const r of (data ?? []) as { session_id: string }[]) cache.delete(r.session_id);
  return data?.length ?? 0;
}
