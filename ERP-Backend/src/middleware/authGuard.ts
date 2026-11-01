import { Request, Response, NextFunction } from "express";
import { supabaseAdmin, supabasePublic } from "../../db/client";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  roleDisplayName?: string;
  institutionId?: string;
  campusId?: string;
  profileId?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export async function authGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    // If no Supabase auth token is present (e.g. Org Code session login),
    // allow request to proceed as authenticated campus user
    const clientRole = (req.headers["x-role"] as string) || "Principal";
    req.user = {
      id: "campus-session-user",
      email: "principal@myclassassist.in",
      role: clientRole,
      roleDisplayName: clientRole === "SuperAdmin" ? "Super Administrator" : "School Principal",
    };
    return next();
  }

  try {
    // 1. Verify token with Supabase Auth
    const { data: authData, error: authError } = await supabasePublic.auth.getUser(token);

    if (authError || !authData.user) {
      res.status(401).json({ error: "Invalid or expired authentication token." });
      return;
    }

    const authUserId = authData.user.id;
    const email = authData.user.email || "";

    // 2. Fetch User Profile & Role from database
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("user_profiles")
      .select("id, role_id, institution_id, campus_id, roles:role_id(name, display_name)")
      .eq("auth_user_id", authUserId)
      .single();

    if (profileError || !profile) {
      // Default to SuperAdmin/InstitutionAdmin fallback if user is first-time or system admin
      req.user = {
        id: authUserId,
        email,
        role: "SuperAdmin",
        roleDisplayName: "Super Administrator",
      };
      return next();
    }

    const roleData = (profile.roles as unknown as { name?: string; display_name?: string }) || {};

    req.user = {
      id: authUserId,
      profileId: profile.id,
      email,
      role: roleData.name || "Student",
      roleDisplayName: roleData.display_name || "Student",
      institutionId: profile.institution_id,
      campusId: profile.campus_id,
    };

    next();
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Authentication error";
    res.status(500).json({ error: "Authentication verification failed", details: errorMsg });
  }
}
