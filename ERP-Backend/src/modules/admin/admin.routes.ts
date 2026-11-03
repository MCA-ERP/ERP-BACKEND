import { Router, Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requireRoles } from "../../middleware/rbacGuard";
import * as svc from "./admin.service";
import * as schools from "./schools.service";
import * as modules from "./modules.service";

export const adminRouter = Router();

// Every admin route: valid token + SuperAdmin only.
adminRouter.use(authGuard, requireRoles());

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const id = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);

const optStr = z.string().trim().max(500).optional().nullable().transform((v) => v || null);

const campusSchema = z.object({
  code: z.string().trim().min(1).max(50).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(255),
  address: optStr,
  city: optStr,
  state: optStr,
  postal_code: optStr,
});

const nullableStr = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => v || null);

const schoolBase = z.object({
  name: z.string().trim().min(2, "School name is required.").max(255),
  type: z.string().trim().min(1).max(50).optional(),
  board: nullableStr(50),
  city: nullableStr(100),
  state: nullableStr(100),
  contact_name: nullableStr(150),
  contact_email: z.string().trim().email("Enter a valid contact email.").optional().nullable().or(z.literal("").transform(() => null)),
  contact_phone: nullableStr(50),
  address: nullableStr(500),
  website: nullableStr(255),
});

const schoolCreate = schoolBase.extend({
  code: z.string().trim().min(2).max(50).regex(/^[A-Za-z0-9_-]+$/, "Code may contain letters, digits, - and _").optional().or(z.literal("").transform(() => undefined)),
  plan_code: z.string().trim().min(1).optional(),
  status: z.enum(["Pending", "Trial", "Active"]).optional(),
});
const schoolPatch = schoolBase.partial();

const userCreate = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters.").max(72),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(30).optional(),
  role: z.string().trim().min(1),
  institution_id: z.string().uuid().optional().nullable(),
  campus_id: z.string().uuid().optional().nullable(),
});

const userPatch = z
  .object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    phone: z.string().trim().max(30).nullable(),
    role: z.string().trim().min(1),
    status: z.enum(["active", "suspended", "pending"]),
    institution_id: z.string().uuid().nullable(),
    campus_id: z.string().uuid().nullable(),
  })
  .partial();

// Dashboard & plans
adminRouter.get("/dashboard/summary", h(async (_req, res) => res.json(await schools.getDashboardSummary())));
adminRouter.get("/plans", h(async (_req, res) => res.json({ plans: await schools.listPlans() })));

// Schools
adminRouter.get("/schools", h(async (req, res) => res.json(await schools.listSchools(req.query))));
adminRouter.post(
  "/schools",
  h(async (req, res) => res.status(201).json(await schools.createSchool(schoolCreate.parse(req.body), req.user?.profileId)))
);
adminRouter.get("/schools/:id", h(async (req, res) => res.json(await schools.getSchool(id(req)))));
adminRouter.patch("/schools/:id", h(async (req, res) => res.json(await schools.updateSchool(id(req), schoolPatch.parse(req.body)))));
adminRouter.post(
  "/schools/:id/status",
  h(async (req, res) => {
    const { status } = z.object({ status: z.enum(schools.SCHOOL_STATUSES) }).parse(req.body);
    res.json(await schools.setSchoolStatus(id(req), status));
  })
);
adminRouter.post(
  "/schools/:id/plan",
  h(async (req, res) => {
    const { plan_code } = z.object({ plan_code: z.string().trim().min(1) }).parse(req.body);
    res.json(await schools.changeSchoolPlan(id(req), plan_code, req.user?.profileId));
  })
);
adminRouter.get(
  "/schools/:id/campuses",
  h(async (req, res) => res.json({ campuses: await svc.listCampuses(id(req)) }))
);
adminRouter.post(
  "/schools/:id/campuses",
  h(async (req, res) => res.status(201).json({ campus: await svc.createCampus(id(req), campusSchema.parse(req.body)) }))
);

// Modules & plan gating
adminRouter.get("/modules", h(async (_req, res) => res.json(await modules.listModules())));
adminRouter.patch(
  "/modules/:code",
  h(async (req, res) => {
    const { is_enabled } = z.object({ is_enabled: z.boolean() }).parse(req.body);
    res.json(await modules.setModuleEnabled(String(req.params.code), is_enabled));
  })
);
adminRouter.get("/plan-modules", h(async (_req, res) => res.json(await modules.getPlanMatrix())));
adminRouter.put(
  "/plans/:code/modules",
  h(async (req, res) => {
    const { module_codes } = z.object({ module_codes: z.array(z.string()) }).parse(req.body);
    res.json(await modules.setPlanModules(String(req.params.code), module_codes));
  })
);
adminRouter.get("/schools/:id/modules", h(async (req, res) => res.json(await modules.getSchoolModules(id(req)))));
adminRouter.put(
  "/schools/:id/modules/:code",
  h(async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean().nullable() }).parse(req.body);
    res.json(await modules.setSchoolModuleOverride(id(req), String(req.params.code), enabled, req.user?.profileId));
  })
);

// Users
adminRouter.get("/users", h(async (req, res) => res.json(await svc.listUsers(req.query))));
adminRouter.post(
  "/users",
  h(async (req, res) => res.status(201).json({ user: await svc.createUser(userCreate.parse(req.body)) }))
);
adminRouter.patch(
  "/users/:id",
  h(async (req, res) =>
    res.json({ user: await svc.updateUser(id(req), req.user?.profileId, userPatch.parse(req.body)) })
  )
);

// Roles & permissions
adminRouter.get("/roles", h(async (_req, res) => res.json({ roles: await svc.listRolesWithPermissions() })));
adminRouter.get("/permissions", h(async (_req, res) => res.json({ permissions: await svc.listPermissions() })));
adminRouter.put(
  "/roles/:id/permissions",
  h(async (req, res) => {
    const { permission_ids } = z.object({ permission_ids: z.array(z.string().uuid()) }).parse(req.body);
    res.json(await svc.setRolePermissions(id(req), permission_ids));
  })
);

// Audit logs
adminRouter.get("/audit-logs", h(async (req, res) => res.json(await svc.listAuditLogs(req.query))));

// Error mapping for this router
adminRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: err.issues[0]?.message || "Invalid request.",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  if (err instanceof svc.HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
});
