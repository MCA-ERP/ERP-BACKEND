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
