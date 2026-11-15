import type { Request, Response, NextFunction } from "express";
import { clientIp, isIpAllowed, isIpBlocked } from "./security.service";
import { deniedPages, pageKeyFor } from "../../lib/role-pages";

type Action = "view" | "create" | "edit" | "delete";

const ACTION: Record<string, Action> = { GET: "view", HEAD: "view", POST: "create", PUT: "edit", PATCH: "edit", DELETE: "delete" };

/** First path segment -> platform permission area. */
const AREA: Record<string, string> = {
  dashboard: "dashboard",
  plans: "subscriptions",
  subscriptions: "subscriptions",
  schools: "schools",
  campuses: "schools",
  applications: "schools",
  modules: "modules",
  "plan-modules": "modules",
  "module-config": "modules",
  "role-config": "roles",
  search: "dashboard",
  notifications: "dashboard",
  users: "users",
  "user-directory": "users",
  "login-activity": "users",
  "student-accounts": "users",
  "parent-accounts": "users",
  roles: "roles",
  permissions: "roles",
  "audit-logs": "security",
  "ip-allowlist": "security",
  "ip-blocklist": "security",
  security: "security",
  system: "settings",
  backups: "security",
  support: "support",
  communication: "communication",
  cms: "cms",
  settings: "settings",
  payments: "payments",
  reports: "reports",
  integrations: "integrations",
};

/** The permission a request to /admin/* needs, or null when the path is not recognised. */
export function requiredPermission(method: string, path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  const action = ACTION[method];
  if (!parts.length || !action) return null;

  let area = AREA[parts[0]];
  let act: Action = action;

  if (parts[0] === "schools") {
    if (parts[2] === "modules") area = "modules";
    else if (parts[2] === "plan") {
      area = "subscriptions";
      act = "edit";
    } else if (["status", "status-action", "approve", "primary-admin"].includes(parts[2])) act = "edit";
    else if (parts[2] === "documents" && parts[4] === "review") act = "edit";
  }
  if (parts[0] === "plans" && parts[2] === "modules") area = "modules";
  if (parts[0] === "user-directory" && act === "create") act = "edit";
  if (parts[0] === "support" && act === "create" && (parts[1] === "assign" || parts[1] === "reassign")) act = "edit";
  if (parts[0] === "role-config" && act === "create" && ["assign", "reassign", "restore"].some((w) => parts.includes(w))) act = "edit";
  if (parts[0] === "login-activity" && act === "create") act = "edit";
  if (parts[0] === "subscriptions" && act === "create" && ["cancel", "reinstate", "extend-trial", "change-plan", "decide"].some((w) => parts.includes(w))) act = "edit";
  if (parts[0] === "applications" && act === "create" && (parts[2] === "convert" || parts[2] === "reject")) act = "edit";
  if (parts[0] === "settings" && act === "create") act = "edit";
  if (parts[0] === "integrations" && act === "create" && ["revoke", "test", "rotate-secret", "redeliver"].some((w) => parts.includes(w))) act = "edit";
  if (parts[0] === "payments" && act === "create" && (parts.includes("void") || parts.includes("refund") || parts.includes("decide") || parts.includes("test"))) act = "edit";

  return area ? `platform.${area}.${act}` : null;
}

/**
 * Gate for every /admin route: the caller's address must be allowed, they must be platform staff
 * (SuperAdmin, or a user with no school) and hold the permission this route needs.
 * Unknown routes are denied.
 */
export async function adminAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const ip = clientIp(req);
    if (await isIpBlocked(ip)) {
      res.status(403).json({ error: "Your network address is blocked.", code: "IP_BLOCKED" });
      return;
    }
    if (!(await isIpAllowed(ip))) {
      res.status(403).json({ error: "Your network address is not allowed to use the admin portal.", code: "IP_NOT_ALLOWED" });
      return;
    }

    if (user.role === "SuperAdmin") return next();

    const needed = requiredPermission(req.method, req.path);
    if (user.institutionId || !needed || !user.permissions.includes(needed)) {
      if (res.locals) res.locals.denied = needed ?? "unknown area";
      res.status(403).json({ error: "Forbidden. You do not have access to this area.", requiredPermission: needed });
      return;
    }
    // some pages inside a menu can be switched off for a role
    const page = user.roleId ? pageKeyFor(req.path.split("/").filter(Boolean)) : null;
    if (page && (await deniedPages(user.roleId!)).has(page)) {
      if (res.locals) res.locals.denied = `page:${page}`;
      res.status(403).json({ error: "Your role cannot open this page.", page });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
