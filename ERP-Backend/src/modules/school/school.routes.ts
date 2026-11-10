import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requirePermission } from "../../middleware/rbacGuard";
import { requireInstitutionId } from "../../lib/tenant";
import { sendError } from "../../lib/http-error";
import * as svc from "./school.service";
import * as support from "../admin/support.service";
import { listSchoolAnnouncements, markAnnouncementRead } from "../admin/communication.service";
import { actorName } from "../../lib/actor";
import * as billing from "../billing/billing.service";
import * as subsvc from "../admin/subscriptions.service";
import * as modcfg from "../admin/module-config.service";
import * as sm from "../admin/support-mgmt.service";
import * as svc2 from "../admin/schools.service";

export const schoolRouter = Router();

// Everything here is the school's own setup data; SuperAdmin must say which school via ?institution_id=
schoolRouter.use(authGuard);

const manage = requirePermission("academics.setup.manage");
const view = requirePermission("sis.student.view");

type Handler = (req: Request, res: Response, inst: string) => Promise<unknown>;
const h =
  (fn: Handler) =>
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const inst = requireInstitutionId(req, typeof req.query.institution_id === "string" ? req.query.institution_id : undefined);
      res.json(await fn(req, res, inst));
    } catch (err) {
      sendError(res, err, "Request failed");
    }
  };

const uuid = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD.");

const yearSchema = z.object({
  name: z.string().trim().min(3, "Enter a name like 2026-2027.").max(50),
  start_date: date,
  end_date: date,
  is_current: z.boolean().optional(),
});
const gradeSchema = z.object({
  code: z.string().trim().min(1).max(20).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(100),
  sort_order: z.number().int().optional(),
});
const sectionSchema = z.object({
  grade_id: z.string().uuid(),
  academic_year_id: z.string().uuid(),
  name: z.string().trim().min(1).max(50),
  capacity: z.number().int().min(1).max(500).optional(),
});
const subjectSchema = z.object({
  code: z.string().trim().min(1).max(30).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(150),
});

schoolRouter.get("/setup/status", view, h((_req, _res, inst) => svc.getSetupStatus(inst)));

// Academic years
schoolRouter.get("/years", view, h((_req, _res, inst) => svc.listYears(inst).then((years) => ({ years }))));
schoolRouter.post("/years", manage, h(async (req, res, inst) => {
  res.status(201);
  return { year: await svc.createYear(inst, yearSchema.parse(req.body)) };
}));
schoolRouter.patch("/years/:id", manage, h(async (req, _res, inst) => ({
  year: await svc.updateYear(inst, uuid(req), yearSchema.partial().omit({ is_current: true }).extend({ is_locked: z.boolean().optional() }).parse(req.body)),
})));
schoolRouter.post("/years/:id/current", manage, h(async (req, _res, inst) => ({ year: await svc.setCurrentYear(inst, uuid(req)) })));

// Grades
schoolRouter.get("/grades", view, h((_req, _res, inst) => svc.listGrades(inst).then((grades) => ({ grades }))));
schoolRouter.post("/grades", manage, h(async (req, res, inst) => {
  res.status(201);
  return { grade: await svc.createGrade(inst, gradeSchema.parse(req.body)) };
}));
schoolRouter.post("/grades/defaults", manage, h((_req, _res, inst) => svc.addDefaultGrades(inst).then((grades) => ({ grades }))));
schoolRouter.patch("/grades/:id", manage, h(async (req, _res, inst) => ({
  grade: await svc.updateGrade(inst, uuid(req), z.object({ name: z.string().trim().min(1).max(100), sort_order: z.number().int(), is_active: z.boolean() }).partial().parse(req.body)),
})));

// Sections
schoolRouter.get("/sections", view, h((req, _res, inst) =>
  svc.listSections(inst, typeof req.query.academic_year_id === "string" ? req.query.academic_year_id : undefined).then((sections) => ({ sections }))
));
schoolRouter.post("/sections", manage, h(async (req, res, inst) => {
  res.status(201);
  return { section: await svc.createSection(inst, sectionSchema.parse(req.body)) };
}));
schoolRouter.post("/sections/defaults", manage, h(async (req, _res, inst) => {
  const { academic_year_id, names } = z
    .object({ academic_year_id: z.string().uuid(), names: z.array(z.string().trim().min(1).max(50)).min(1).max(10) })
    .parse(req.body);
  return { sections: await svc.addDefaultSections(inst, academic_year_id, names) };
}));
schoolRouter.patch("/sections/:id", manage, h(async (req, _res, inst) => ({
  section: await svc.updateSection(inst, uuid(req), z.object({ name: z.string().trim().min(1).max(50), capacity: z.number().int().min(1).max(500) }).partial().parse(req.body)),
})));
schoolRouter.delete("/sections/:id", manage, h((req, _res, inst) => svc.deleteSection(inst, uuid(req))));

// Subjects
schoolRouter.get("/subjects", view, h((_req, _res, inst) => svc.listSubjects(inst).then((subjects) => ({ subjects }))));
schoolRouter.post("/subjects", manage, h(async (req, res, inst) => {
  res.status(201);
  return { subject: await svc.createSubject(inst, subjectSchema.parse(req.body)) };
}));
schoolRouter.post("/subjects/defaults", manage, h((_req, _res, inst) => svc.addDefaultSubjects(inst).then((subjects) => ({ subjects }))));
schoolRouter.patch("/subjects/:id", manage, h(async (req, _res, inst) => ({
  subject: await svc.updateSubject(inst, uuid(req), z.object({ name: z.string().trim().min(1).max(150), is_active: z.boolean() }).partial().parse(req.body)),
})));

// Announcements from the platform team (any signed-in school user)
schoolRouter.get("/announcements", h((_req, _res, inst) => listSchoolAnnouncements(inst).then((announcements) => ({ announcements }))));

schoolRouter.post("/announcements/:id/read", h((req, _res, inst) => markAnnouncementRead(inst, uuid(req))));

// Help centre: anyone signed in to the school can read it
schoolRouter.get("/help", h(async (req, _res) => ({ items: await sm.listKb(req.query, true) })));
schoolRouter.post("/help/:id/view", h(async (req, _res) => sm.viewKb(uuid(req))));
schoolRouter.post("/help/:id/vote", h(async (req, _res) => sm.voteKb(uuid(req), z.object({ helpful: z.boolean() }).parse(req.body).helpful)));
schoolRouter.get("/support/categories", h(async () => ({ categories: await sm.activeCategories() })));
schoolRouter.get("/features", h((_req, _res, inst) => sm.listFeatures(inst).then((items) => ({ items }))));
schoolRouter.post("/features", manage, h(async (req, res, inst) => {
  res.status(201);
  return sm.createFeature(inst, await actorName(req), z.object({ title: z.string().trim().min(5, "Describe the feature in a few words.").max(200), description: z.string().trim().max(2000).nullable().optional() }).parse(req.body));
}));
schoolRouter.post("/features/:id/vote", manage, h((req, _res, inst) => sm.toggleVote(inst, uuid(req))));
schoolRouter.post("/feedback", manage, h(async (req, res, inst) => {
  res.status(201);
  return sm.submitFeedback(inst, await actorName(req), z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).nullable().optional(), ticket_id: z.string().uuid().nullable().optional() }).parse(req.body));
}));

// Support tickets raised by the school
schoolRouter.get("/support/tickets", manage, h((_req, _res, inst) => support.listSchoolTickets(inst).then((tickets) => ({ tickets }))));
schoolRouter.post("/support/tickets", manage, h(async (req, res, inst) => {
  const input = z
    .object({
      subject: z.string().trim().min(3, "Enter a short subject.").max(255),
      category: z.string().trim().min(1).max(50).default("General"),
      priority: z.enum(support.PRIORITIES).optional(),
      subtopic: z.string().trim().max(60).optional(),
      body: z.string().trim().min(1, "Describe the problem.").max(5000),
    })
    .parse(req.body);
  res.status(201);
  return support.createSchoolTicket(inst, await actorName(req), input);
}));
schoolRouter.get("/support/tickets/:id", manage, h((req, _res, inst) => support.getSchoolTicket(inst, uuid(req))));
schoolRouter.post("/support/tickets/:id/messages", manage, h(async (req, res, inst) => {
  const { body } = z.object({ body: z.string().trim().min(1, "Write a message.").max(5000) }).parse(req.body);
  res.status(201);
  return support.addSchoolMessage(inst, uuid(req), await actorName(req), body);
}));

// Billing: the school sees its own invoices and can pay online
const billingPerm = requirePermission("admin.settings.manage");
schoolRouter.get("/billing/invoices", billingPerm, h((req, _res, inst) => billing.listInvoices(req.query, inst)));
schoolRouter.get("/billing/invoices/:id", billingPerm, h((req, _res, inst) => billing.getInvoice(uuid(req), inst)));
schoolRouter.post("/billing/invoices/:id/order", billingPerm, h((req, _res, inst) => billing.createCheckoutOrder(inst, uuid(req))));
schoolRouter.post("/billing/verify", billingPerm, h((req, _res, inst) =>
  billing.verifyCheckout(
    inst,
    z.object({ razorpay_order_id: z.string().min(1), razorpay_payment_id: z.string().min(1), razorpay_signature: z.string().min(1) }).parse(req.body)
  )
));
schoolRouter.get("/flags", h(async (_req, _res, inst) => ({ flags: await modcfg.flagsForSchool(inst) })));
schoolRouter.get("/subscription", billingPerm, h(async (_req, _res, inst) => {
  const [details, requests, plans] = await Promise.all([subsvc.getSchoolSubscription(inst), subsvc.schoolRequests(inst), svc2.listPlans()]);
  return { subscription: details.subscription, usage: details.usage, requests, plans };
}));
schoolRouter.post("/subscription/request", billingPerm, h(async (req, res, inst) => {
  const b = z.object({ plan_code: z.string().trim().min(1), note: z.string().trim().max(500).optional() }).parse(req.body);
  res.status(201);
  return subsvc.createRequest(inst, req.user?.profileId, b.plan_code, b.note);
}));
schoolRouter.get("/billing/config", billingPerm, h(async () => ({ online_payments: billing.gatewayInfo().razorpay.configured })));
