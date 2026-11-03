import { Request, Response, NextFunction } from "express";
import { supabaseAdmin, supabasePublic } from "../../db/client";
import { getRolePermissions } from "../lib/permissions";
import { getEntitlements } from "../lib/entitlements";

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

    const authUserId = authData.user.id;
    const email = (authData.user.email || "").toLowerCase();

    const { data: profile } = await supabaseAdmin
      .from("user_profiles")
      .select("id, status, role_id, institution_id, campus_id, roles:role_id(name, display_name)")
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

    const roleData = (profile.roles as unknown as { name?: string; display_name?: string }) || {};
    if (!roleData.name) {
      res.status(403).json({ error: "No role is assigned to this account." });
      return;
    }

    // A school that is not live (or whose subscription lapsed) cannot use the product.
    let modules: string[] = [];
    if (profile.institution_id && roleData.name !== "SuperAdmin") {
      const ent = await getEntitlements(profile.institution_id);
      if (ent.status === "Pending" || ent.status === "Suspended") {
        res.status(403).json({ error: `This school is ${ent.status.toLowerCase()}. Contact My Class Assist support.`, code: "SCHOOL_INACTIVE" });
        return;
      }
      if (ent.status === "Expired" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        res.status(403).json({ error: "The subscription has expired. The portal is read-only until it is renewed.", code: "SUBSCRIPTION_EXPIRED" });
        return;
      }
      modules = ent.modules;
    }

    req.user = {
      id: authUserId,
      profileId: profile.id,
      email,
      role: roleData.name,
      roleDisplayName: roleData.display_name || roleData.name,
      institutionId: profile.institution_id,
      campusId: profile.campus_id,
      permissions: await getRolePermissions(profile.role_id),
      modules,
    };

    next();
  } catch (err: unknown) {
    console.error("Auth verification failed:", err);
    res.status(500).json({ error: "Authentication verification failed" });
  }
}
