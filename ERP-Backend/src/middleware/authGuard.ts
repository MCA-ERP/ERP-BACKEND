import { Request, Response, NextFunction } from "express";
import { supabaseAdmin, supabasePublic } from "../../db/client";
import { getRolePermissions, getRoleModuleLimit } from "../lib/permissions";
import { getEntitlements } from "../lib/entitlements";
import { checkSession, sessionIdOf } from "../lib/sessions";
import { maintenanceState } from "../lib/maintenance";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  roleDisplayName?: string;
  institutionId?: string;
  campusId?: string;
  profileId?: string;
  /** Permission codes granted to the role. SuperAdmin bypasses permission checks. */
  permissions: string[];
  /** Module codes the user's school may use (plan + overrides). SuperAdmin bypasses module checks. */
  modules: string[];
  /** The person's name, for greetings and the sidebar. */
  fullName?: string;
  roleId?: string;
  /** "campus" = sees only their own campus's records where a module supports it. */
  dataScope?: "school" | "campus";
  /** True until the user replaces the temporary password an admin gave them. */
  mustChangePassword?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Comma-separated emails allowed to act as SuperAdmin before any user_profiles
 * row exists (first-time bootstrap). Empty by default: no implicit admins.
 */
function bootstrapSuperAdmins(): string[] {
  return (process.env.SUPER_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Verifies the Supabase JWT and resolves the caller's role from user_profiles.
 * Every request must carry a valid Bearer token; the role is never taken from
 * client-supplied headers.
 */
export async function authGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  try {
    const { data: authData, error: authError } = await supabasePublic.auth.getUser(token);

    if (authError || !authData.user) {
      res.status(401).json({ error: "Invalid or expired authentication token." });
      return;
    }

    const sid = sessionIdOf(token);
    if (sid) {
      const state = await checkSession(sid);
      if (state === "revoked" || state === "idle") {
        res.status(401).json({ error: state === "revoked" ? "This session was ended. Please sign in again." : "You were signed out after being idle. Please sign in again.", code: "SESSION_ENDED" });
        return;
      }
    }

    const authUserId = authData.user.id;
    const email = (authData.user.email || "").toLowerCase();

    const { data: profile } = await supabaseAdmin
      .from("user_profiles")
      .select("id, status, must_change_password, role_id, institution_id, campus_id, first_name, last_name, roles:role_id(name, display_name, data_scope)")
      .eq("auth_user_id", authUserId)
      .maybeSingle();

    if (!profile) {
      if (email && bootstrapSuperAdmins().includes(email)) {
        req.user = {
          id: authUserId,
          email,
          role: "SuperAdmin",
          roleDisplayName: "Super Administrator",
          permissions: [],
          modules: [],
        };
        return next();
      }
      res.status(403).json({ error: "No ERP profile is assigned to this account." });
      return;
    }

    if (profile.status && profile.status !== "active") {
      res.status(403).json({ error: `Account is ${profile.status}.` });
      return;
    }

    const roleData = (profile.roles as unknown as { name?: string; display_name?: string; data_scope?: "school" | "campus" }) || {};
    if (!roleData.name) {
      res.status(403).json({ error: "No role is assigned to this account." });
      return;
    }

    // Planned work: school users see the message while the platform team keeps working.
    if (profile.institution_id && roleData.name !== "SuperAdmin") {
      const m = await maintenanceState();
      if (m.active) {
        res.status(503).json({ error: m.message, code: "MAINTENANCE", ends_at: m.ends_at });
        return;
      }
    }

    // A school that is not live (or whose subscription lapsed) cannot use the product.
    let modules: string[] = [];
    if (profile.institution_id && roleData.name !== "SuperAdmin") {
      const ent = await getEntitlements(profile.institution_id);
      if (ent.status === "Pending" || ent.status === "Suspended" || ent.status === "Inactive") {
        res.status(403).json({ error: `This school is ${ent.status.toLowerCase()}. Contact My Class Assist support.`, code: "SCHOOL_INACTIVE" });
        return;
      }
      if (ent.status === "Expired" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        res.status(403).json({ error: "The subscription has expired. The portal is read-only until it is renewed.", code: "SUBSCRIPTION_EXPIRED" });
        return;
      }
      modules = ent.modules;
      // a role can be limited to some of the modules its school has
      const limit = await getRoleModuleLimit(profile.role_id);
      if (limit) modules = modules.filter((m) => limit.includes(m));
    }

    req.user = {
      id: authUserId,
      profileId: profile.id,
      fullName: `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim() || undefined,
      roleId: profile.role_id,
      dataScope: roleData.data_scope === "campus" ? "campus" : "school",
      email,
      role: roleData.name,
      roleDisplayName: roleData.display_name || roleData.name,
      institutionId: profile.institution_id,
      campusId: profile.campus_id,
      permissions: await getRolePermissions(profile.role_id),
      modules,
      mustChangePassword: profile.must_change_password === true,
    };

    next();
  } catch (err: unknown) {
    console.error("Auth verification failed:", err);
    res.status(500).json({ error: "Authentication verification failed" });
  }
}
