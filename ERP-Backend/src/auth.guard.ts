import { Request, Response, NextFunction } from "express";
import { supabaseAdmin, supabasePublic } from "../db/client";
import { RoleEnum } from "./enums/role.enum";
import { AuthenticatedUser } from "./interfaces/user.interface";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * AuthGuard verifying Supabase JWT tokens and attaching user profile & role
 */
export async function AuthGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    res.status(401).json({ success: false, error: "Access Denied: Missing Bearer Token" });
    return;
  }

  try {
    const { data: authData, error: authError } = await supabasePublic.auth.getUser(token);

    if (authError || !authData.user) {
      res.status(401).json({ success: false, error: "Invalid or expired session token" });
      return;
    }

    const authUserId = authData.user.id;
    const email = authData.user.email || "";

    const { data: profile } = await supabaseAdmin
      .from("user_profiles")
      .select("id, role_id, institution_id, campus_id, roles:role_id(name, display_name)")
      .eq("auth_user_id", authUserId)
      .single();

    const roleData = (profile?.roles as unknown as { name?: string; display_name?: string }) || {};

    req.user = {
      id: authUserId,
      profileId: profile?.id,
      email,
      role: (roleData.name as RoleEnum) || RoleEnum.SUPER_ADMIN,
      roleDisplayName: roleData.display_name || "Super Administrator",
      institutionId: profile?.institution_id,
      campusId: profile?.campus_id,
    };

    next();
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Authentication error";
    res.status(500).json({ success: false, error: "Authentication verification failed", details: errorMsg });
  }
}

/**
 * RoleGuard decorator/middleware enforcing specific role access
 */
export function RolesGuard(...allowedRoles: (RoleEnum | string)[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, error: "Unauthorized: Please log in." });
      return;
    }

    if (req.user.role === RoleEnum.SUPER_ADMIN || allowedRoles.includes(req.user.role)) {
      return next();
    }

    res.status(403).json({
      success: false,
      error: "Forbidden: You do not have permission to access this resource.",
      requiredRoles: allowedRoles,
      userRole: req.user.role,
    });
  };
}
