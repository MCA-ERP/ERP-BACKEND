import { Request, Response, NextFunction } from "express";

/**
 * Middleware to restrict access based on user role
 * @param allowedRoles Array of role names permitted to access the endpoint
 */
export function requireRoles(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    // SuperAdmin always has full access
    if (req.user.role === "SuperAdmin" || allowedRoles.includes(req.user.role)) {
      return next();
    }

    res.status(403).json({
      error: "Forbidden. Insufficient role permissions.",
      requiredRoles: allowedRoles,
      currentRole: req.user.role,
    });
  };
}

/**
 * Middleware requiring ALL of the given permission codes (e.g. "sis.student.create").
 * SuperAdmin always passes. Prefer this over requireRoles for business endpoints.
 */
export function requirePermission(...codes: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (req.user.role === "SuperAdmin" || codes.every((c) => req.user!.permissions.includes(c))) {
      return next();
    }
    res.status(403).json({ error: "Forbidden. Missing permission.", requiredPermissions: codes });
  };
}

/**
 * Middleware requiring the caller's school to have a module in its plan (or a per-school grant).
 * SuperAdmin always passes.
 */
export function requireModule(code: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    if (req.user.role === "SuperAdmin" || req.user.modules.includes(code)) return next();
    res.status(403).json({
      error: "This feature is not included in your school's plan.",
      code: "MODULE_NOT_IN_PLAN",
      module: code,
    });
  };
}
