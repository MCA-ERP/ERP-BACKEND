import { Router, Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import { authGuard } from "../../middleware/authGuard";
import * as svc from "./admin.service";
import * as schools from "./schools.service";
import * as modules from "./modules.service";
import * as mgmt from "./school-mgmt.service";
import * as modsvc from "./module-config.service";
import { applicationSchema } from "./school-mgmt.service";
import { actorName } from "../../lib/actor";
import { adminAccess } from "./admin.access";
import { opsRouter } from "./admin.ops.routes";
import { billingRouter } from "../billing/billing.routes";
import { insightsRouter } from "./admin.insights.routes";
import { subscriptionsRouter } from "./admin.subscriptions.routes";
import { moduleConfigRouter } from "./admin.module-config.routes";
import { usersRouter } from "./admin.users.routes";
import { rolesRouter } from "./admin.roles.routes";
import * as topbar from "./topbar.service";
import * as rolesvc from "./roles-mgmt.service";
import * as subsvc from "./subscriptions.service";

export const adminRouter = Router();

// Every admin route: valid token, allowed network address, platform staff holding the route's permission.
adminRouter.use(authGuard, adminAccess);

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
  gst_number: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, "A GSTIN has 15 letters and digits.").optional().nullable().or(z.literal("").transform(() => null)),
});

const schoolCreate = schoolBase.extend({
  code: z.string().trim().min(2).max(50).regex(/^[A-Za-z0-9_-]+$/, "Code may contain letters, digits, - and _").optional().or(z.literal("").transform(() => undefined)),
  plan_code: z.string().trim().min(1).optional(),
  status: z.enum(["Pending", "Trial", "Active"]).optional(),
  admin: z
    .object({
      first_name: z.string().trim().min(1, "Administrator first name is required.").max(100),
      last_name: z.string().trim().min(1, "Administrator last name is required.").max(100),
      email: z.string().trim().email("Enter a valid administrator email."),
      password: z.string().min(8, "Administrator password must be at least 8 characters.").max(72),
    })
    .optional(),
});
const schoolPatch = schoolBase.partial();
const campusExtra = {
  phone: nullableStr(30),
  email: z.string().trim().email().nullable().optional().or(z.literal("").transform(() => null)),
  principal_name: nullableStr(150),
  is_main: z.boolean().optional(),
};


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
adminRouter.get("/plans", h(async (req, res) => res.json({ plans: await schools.listPlans(req.query.all === "1") })));

// Schools
adminRouter.get("/schools", h(async (req, res) => res.json(await schools.listSchools(req.query))));
adminRouter.post(
  "/schools",
  h(async (req, res) => {
    const created = await schools.createSchool(schoolCreate.parse(req.body), req.user?.profileId);
    await mgmt.logEvent(created.school.id, "created", "School registered (" + created.school.status + ")", await actorName(req));
    res.status(201).json(created);
  })
);
adminRouter.get("/schools/:id", h(async (req, res) => res.json(await schools.getSchool(id(req)))));
adminRouter.patch("/schools/:id", h(async (req, res) => res.json(await schools.updateSchool(id(req), schoolPatch.parse(req.body)))));
adminRouter.post(
  "/schools/:id/status",
  h(async (req, res) => {
    const { status } = z.object({ status: z.enum(schools.SCHOOL_STATUSES) }).parse(req.body);
    const sid = id(req);
    const result = await schools.setSchoolStatus(sid, status);
    await mgmt.logEvent(sid, "status_changed", "Status set to " + status, await actorName(req));
    res.json(result);
  })
);
adminRouter.post(
  "/schools/:id/plan",
  h(async (req, res) => {
    const { plan_code } = z.object({ plan_code: z.string().trim().min(1) }).parse(req.body);
    res.json(await subsvc.changePlanChecked(id(req), plan_code, await actorName(req)));
  })
);
adminRouter.get(
  "/schools/:id/campuses",
  h(async (req, res) => res.json({ campuses: await svc.listCampuses(id(req)) }))
);
adminRouter.post(
  "/schools/:id/campuses",
  h(async (req, res) => res.status(201).json({ campus: await mgmt.addCampus(id(req), campusSchema.extend(campusExtra).parse(req.body), await actorName(req)) }))
);

// ── school profile, configuration, contacts ──
const hexColor = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #0294ce.").nullable().optional().or(z.literal("").transform(() => null));
const profilePatch = z
  .object({
    name: z.string().trim().min(2).max(255),
    type: z.string().trim().min(1).max(50),
    board: nullableStr(50),
    established_year: z.number().int().min(1800).max(2100).nullable(),
    affiliation_number: nullableStr(80),
    registration_number: nullableStr(80),
    website: nullableStr(255),
    gst_number: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, "A GSTIN has 15 letters and digits.").nullable().or(z.literal("").transform(() => null)),
    address: nullableStr(500),
    city: nullableStr(100),
    state: nullableStr(100),
    postal_code: nullableStr(20),
    country: nullableStr(100),
    contact_name: nullableStr(150),
    contact_email: z.string().trim().email("Enter a valid contact email.").nullable().or(z.literal("").transform(() => null)),
    contact_phone: nullableStr(50),
    logo_url: z.string().trim().url("Enter a full https:// address.").max(500).nullable().or(z.literal("").transform(() => null)),
    tagline: nullableStr(200),
    primary_color: hexColor,
    secondary_color: hexColor,
  })
  .partial()
  .strict();
adminRouter.get("/schools/:id/profile", h(async (req, res) => res.json(await mgmt.getProfile(id(req)))));
adminRouter.patch("/schools/:id/profile", h(async (req, res) => res.json(await mgmt.updateProfile(id(req), profilePatch.parse(req.body), await actorName(req)))));
adminRouter.post(
  "/schools/:id/contacts",
  h(async (req, res) => {
    const input = z.object({ role: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(150), email: z.string().trim().email().nullable().optional().or(z.literal("").transform(() => null)), phone: nullableStr(30) }).parse(req.body);
    res.status(201).json({ contact: await mgmt.addContact(id(req), input, await actorName(req)) });
  })
);
adminRouter.delete("/schools/:id/contacts/:contactId", h(async (req, res) => res.json(await mgmt.removeContact(id(req), z.string().uuid().parse(req.params.contactId), await actorName(req)))));

const configSchemas = {
  academic: z.object({
    year_start_month: z.number().int().min(1).max(12),
    terms: z.number().int().min(1).max(4),
    grading: z.enum(["Marks and percentage", "Grades (A-E)", "CGPA", "Descriptive only"]),
    attendance_rule: z.enum(["Daily", "Per period"]),
    min_attendance_percent: z.number().int().min(0).max(100),
  }).partial().strict(),
  regional: z.object({
    country: z.string().trim().min(2).max(60),
    timezone: z.enum(["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"]),
    currency: z.enum(["INR", "USD", "AED", "GBP", "SGD"]),
    date_format: z.enum(["DD MMM YYYY", "DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]),
  }).partial().strict(),
  language: z.object({
    default: z.string().trim().min(2).max(40),
    enabled: z.array(z.string().trim().min(2).max(40)).min(1).max(12),
  }).partial().strict().refine((v) => !v.default || !v.enabled || v.enabled.includes(v.default), "The default language must be one of the enabled languages."),
} as const;
adminRouter.get("/schools/:id/config", h(async (req, res) => res.json(await mgmt.getConfig(id(req)))));
adminRouter.put(
  "/schools/:id/config/:section",
  h(async (req, res) => {
    const section = z.enum(["academic", "regional", "language"]).parse(req.params.section);
    res.json(await mgmt.updateConfig(id(req), section, configSchemas[section].parse(req.body), await actorName(req)));
  })
);

// ── campuses across all schools ──
adminRouter.get("/campuses", h(async (req, res) => res.json(await mgmt.listAllCampuses(req.query))));
adminRouter.get("/campuses/:id", h(async (req, res) => res.json(await mgmt.getCampus(id(req)))));
adminRouter.patch(
  "/campuses/:id",
  h(async (req, res) => res.json(await mgmt.updateCampus(id(req), campusSchema.extend(campusExtra).extend({ is_active: z.boolean() }).partial().strict().parse(req.body), await actorName(req))))
);

// ── school admins ──
adminRouter.get("/schools/:id/admins", h(async (req, res) => res.json(await mgmt.listAdmins(id(req)))));
adminRouter.post(
  "/schools/:id/admins",
  h(async (req, res) => {
    const input = z
      .object({
        first_name: z.string().trim().min(1).max(100),
        last_name: z.string().trim().min(1).max(100),
        email: z.string().trim().email(),
        phone: z.string().trim().max(30).optional(),
        password: z.string().min(8, "Password must be at least 8 characters.").max(72),
        make_primary: z.boolean().optional(),
      })
      .parse(req.body);
    res.status(201).json({ admin: await mgmt.createAdmin(id(req), input, await actorName(req)) });
  })
);
adminRouter.post(
  "/schools/:id/primary-admin",
  h(async (req, res) => res.json(await mgmt.assignPrimaryAdmin(id(req), z.object({ admin_id: z.string().uuid() }).parse(req.body).admin_id, await actorName(req))))
);
adminRouter.get("/schools/:id/admin-access", h(async (req, res) => res.json(await mgmt.getAdminAccess(id(req)))));

// ── status actions, approval, readiness ──
adminRouter.post(
  "/schools/:id/status-action",
  h(async (req, res) => {
    const { action, reason } = z.object({ action: z.enum(["activate", "deactivate", "suspend", "reactivate"]), reason: z.string().trim().max(500).optional() }).parse(req.body);
    res.json(await mgmt.statusAction(id(req), action, reason, await actorName(req)));
  })
);
adminRouter.get("/schools/:id/readiness", h(async (req, res) => res.json(await mgmt.getReadiness(id(req)))));
adminRouter.post(
  "/schools/:id/approve",
  h(async (req, res) => {
    const { status, force } = z.object({ status: z.enum(["Trial", "Active"]), force: z.boolean().optional() }).parse(req.body);
    res.json(await mgmt.approveSchool(id(req), status, !!force && req.user?.role === "SuperAdmin", await actorName(req)));
  })
);

// ── documents ──
const docSchema = z.object({
  category: z.enum(["registration", "affiliation"]),
  doc_type: z.string().trim().min(1).max(100),
  number: nullableStr(100),
  issued_by: nullableStr(150),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal("").transform(() => null)),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().or(z.literal("").transform(() => null)),
  file_url: z.string().trim().url("Enter a full https:// address.").max(500).nullable().optional().or(z.literal("").transform(() => null)),
  notes: nullableStr(500),
});
adminRouter.get("/schools/:id/documents", h(async (req, res) => res.json(await mgmt.listDocuments(id(req), typeof req.query.category === "string" ? req.query.category : undefined))));
adminRouter.post("/schools/:id/documents", h(async (req, res) => res.status(201).json({ document: await mgmt.addDocument(id(req), docSchema.parse(req.body), await actorName(req)) })));
adminRouter.post(
  "/schools/:id/documents/:docId/review",
  h(async (req, res) => {
    const { status, notes } = z.object({ status: z.enum(["verified", "rejected", "pending"]), notes: z.string().trim().max(500).nullable().optional() }).parse(req.body);
    res.json(await mgmt.reviewDocument(id(req), z.string().uuid().parse(req.params.docId), status, notes, await actorName(req)));
  })
);
adminRouter.delete("/schools/:id/documents/:docId", h(async (req, res) => res.json(await mgmt.removeDocument(id(req), z.string().uuid().parse(req.params.docId), await actorName(req)))));

// ── history ──
adminRouter.get("/schools/:id/history/:type", h(async (req, res) => res.json(await mgmt.getHistory(id(req), z.enum(["activity", "subscription", "audit"]).parse(req.params.type), req.query))));

// ── applications ──
adminRouter.get("/applications", h(async (req, res) => res.json(await mgmt.listApplications(req.query))));
adminRouter.post(
  "/applications",
  h(async (req, res) => res.status(201).json(await mgmt.createApplication({ ...applicationSchema.parse(req.body), source: z.enum(["website", "demo", "referral"]).default("referral").parse(req.body?.source) })))
);
adminRouter.patch(
  "/applications/:id",
  h(async (req, res) => res.json(await mgmt.updateApplication(id(req), z.object({ status: z.enum(["new", "in_review", "rejected"]), notes: nullableStr(500) }).partial().parse(req.body), await actorName(req))))
);
adminRouter.post(
  "/applications/:id/convert",
  h(async (req, res) => res.status(201).json(await mgmt.convertApplication(id(req), z.object({ plan_code: z.string().trim().min(1).optional() }).parse(req.body ?? {}).plan_code, await actorName(req))))
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
adminRouter.put(
  "/schools/:id/modules",
  h(async (req, res) => {
    const { module_codes } = z.object({ module_codes: z.array(z.string().trim().min(1)).max(100) }).parse(req.body);
    res.json(await modsvc.assignSchoolModules(id(req), module_codes, req.user?.profileId));
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
  h(async (req, res) => res.status(201).json({ user: await svc.createUser(userCreate.parse(req.body), req.user?.role) }))
);
adminRouter.patch(
  "/users/:id",
  h(async (req, res) =>
    res.json({ user: await svc.updateUser(id(req), req.user?.profileId, userPatch.parse(req.body), req.user?.role) })
  )
);

// Roles & permissions
adminRouter.get("/roles", h(async (_req, res) => res.json({ roles: await svc.listRolesWithPermissions() })));
adminRouter.get("/permissions", h(async (_req, res) => res.json({ permissions: await svc.listPermissions() })));
adminRouter.put(
  "/roles/:id/permissions",
  h(async (req, res) => {
    const { permission_ids } = z.object({ permission_ids: z.array(z.string().uuid()) }).parse(req.body);
    res.json(await rolesvc.setPermissions(id(req), permission_ids, await actorName(req)));
  })
);

// Audit logs
adminRouter.get("/audit-logs", h(async (req, res) => res.json(await svc.listAuditLogs(req.query))));

adminRouter.use(opsRouter);
adminRouter.use(subscriptionsRouter);
adminRouter.use(moduleConfigRouter);
adminRouter.use(usersRouter);
adminRouter.use(rolesRouter);

// the top bar: one search box and the bell
const canView = (req: Request) => (area: string) => req.user?.role === "SuperAdmin" || !!req.user?.permissions.includes(`platform.${area}.view`);
adminRouter.get("/search", h(async (req, res) => res.json(await topbar.search(req.query.q, canView(req)))));
adminRouter.get("/notifications", h(async (req, res) => res.json(await topbar.notifications(canView(req)))));
adminRouter.use(billingRouter);
adminRouter.use(insightsRouter);

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
