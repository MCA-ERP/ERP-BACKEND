import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requireRoles } from "../../middleware/rbacGuard";
import { requireInstitutionId } from "../../lib/tenant";
import { HttpError, sendError } from "../../lib/http-error";
import * as p from "./principal.service";
import * as rv from "./principal-reviews.service";
import * as t from "../teacher/teacher.service";
import * as m from "../teacher/teacher-me.service";
import * as topbar from "../school/topbar.service";

/** The Principal portal. Only the Principal gets in; every handler works on the signed-in person's own school. */
export const principalRouter = Router();

export const PRINCIPAL_ROLES = ["Principal"];
principalRouter.use(authGuard);
principalRouter.use(requireRoles(...PRINCIPAL_ROLES));

type Ctx = { inst: string; me: string; role: string; mods: string[]; req: Request };
const h = (fn: (c: Ctx) => Promise<unknown>, status = 200) => async (req: Request, res: Response, _n: NextFunction) => {
  try {
    const inst = requireInstitutionId(req, typeof req.query.institution_id === "string" ? req.query.institution_id : undefined);
    const me = req.user?.profileId;
    if (!me) throw new HttpError(401, "Sign in again.");
    res.status(status).json(await fn({ inst, me, role: req.user?.role ?? "", mods: req.user?.modules ?? [], req }));
  } catch (err) {
    sendError(res, err, "Request failed");
  }
};
const uuid = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);
const self = (req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || (u.modules ?? []).includes("employee_self_service")) return next();
  res.status(403).json({ error: "This feature is not included in your school's plan.", code: "MODULE_NOT_IN_PLAN" });
};

// ── dashboard, the sidebar badge and the bell ──
principalRouter.get("/years", h(({ inst }) => p.years(inst).then((items) => ({ items }))));
principalRouter.get("/me", h(({ inst, me, mods }) => p.me(inst, me, mods)));
principalRouter.get("/overview", h(({ inst, me, mods, req }) => {
  const q = z.object({ tab: z.enum(["statistics", "attendance", "fees", "admissions"]).default("statistics"), year: z.string().uuid().optional() }).parse(req.query);
  return p.overview(inst, me, mods, q.tab, q.year);
}));
principalRouter.get("/notifications", h(({ inst, me, mods }) => p.notifications(inst, me, mods)));
principalRouter.post("/notifications/read", h(({ inst, me, mods, req }) => p.markNotificationsRead(inst, me, mods, req.body)));
principalRouter.get("/settings", h(({ inst, me }) => rv.mySettings(inst, me)));
principalRouter.put("/settings", h(({ inst, me, req }) => rv.saveMySettings(inst, me, req.body)));
principalRouter.get("/search", h(({ inst, req }) => topbar.search(inst, req.query.q, true, true)));

// ── approvals: what waits for the Principal, deciding it, and what was decided ──
principalRouter.get("/approvals", h(({ inst, me, mods, req }) => p.approvals(inst, me, mods, typeof req.query.kind === "string" ? req.query.kind : undefined)));
principalRouter.post("/approvals/:kind/:id", h(({ inst, me, role, mods, req }) => p.decide(inst, me, role, mods, String(req.params.kind), String(req.params.id).slice(0, 80), req.body)));
principalRouter.get("/decided", h(({ inst }) => p.decided(inst)));
principalRouter.get("/concerns", h(({ inst }) => p.concerns(inst)));
principalRouter.post("/concerns/:source/:id", h(({ inst, me, req }) => p.setConcern(inst, me, String(req.params.source), uuid(req), req.body)));
const R = rv;
principalRouter.get("/subjects-by-class", h(({ inst }) => R.subjectsByClass(inst)));
principalRouter.get("/academics/classes", h(({ inst }) => R.classes(inst)));
principalRouter.get("/academics/subjects", h(({ inst }) => R.subjects(inst)));
principalRouter.get("/academics/syllabus", h(({ inst }) => R.syllabus(inst)));
principalRouter.get("/academics/workload", h(({ inst }) => R.teacherWorkload(inst)));
principalRouter.get("/academics/lesson-plans", h(({ inst }) => R.lessonPlans(inst)));
principalRouter.get("/academics/class-performance", h(({ inst, req }) => { const q = z.object({ section: z.string().uuid().optional(), exam: z.string().uuid().optional() }).parse(req.query); return R.classPerformance(inst, q.section, q.exam); }));
principalRouter.get("/academics/subject-performance", h(({ inst, req }) => { const q = z.object({ grade: z.string().uuid().optional(), exam: z.string().uuid().optional() }).parse(req.query); return R.subjectPerformance(inst, q.grade, q.exam); }));
principalRouter.get("/students/sections", h(({ inst }) => R.sectionWise(inst)));
principalRouter.get("/students/behaviour", h(({ inst, req }) => R.behaviour(inst, String(req.query.tab ?? "incidents"))));
principalRouter.post("/students/behaviour/:id/close", h(({ inst, me, req }) => R.closeBehaviour(inst, me, uuid(req))));
principalRouter.get("/attendance/monthly", h(({ inst }) => R.monthlyAttendance(inst)));
principalRouter.get("/attendance/defaulters", h(({ inst }) => R.defaulters(inst)));
principalRouter.post("/attendance/defaulters/:id/contact", h(({ inst, me, req }) => R.parentContact(inst, me, uuid(req), req.body)));
principalRouter.get("/attendance/staff/daily", h(({ inst }) => R.staffDaily(inst)));
principalRouter.get("/attendance/staff/monthly", h(({ inst }) => R.staffMonthly(inst)));
principalRouter.get("/attendance/staff/exceptions", h(({ inst }) => R.staffExceptions(inst)));
principalRouter.post("/attendance/staff/ask-reason", h(({ inst, me, req }) => R.askReason(inst, me, req.body)));
principalRouter.get("/admissions/applications", h(({ inst }) => R.applications(inst)));
principalRouter.get("/reports/:kind", h(({ inst, req }) => R.schoolReport(inst, String(req.params.kind), typeof req.query.grade === "string" ? z.string().uuid().parse(req.query.grade) : undefined)));
principalRouter.get("/concerns/complaints", h(({ inst }) => R.complaints(inst)));
principalRouter.get("/concerns/help-desk", h(({ inst }) => R.helpDesk(inst)));
principalRouter.post("/concerns/help-desk/:id/update", h(({ inst, me, req }) => R.askUpdate(inst, me, uuid(req))));
principalRouter.get("/store", h(({ inst }) => R.store(inst)));
principalRouter.get("/staff/leave/:status", h(({ inst, req }) => R.decidedLeave(inst, String(req.params.status))));

// ── staff self-service shared with the Teacher, Accounts and Admissions portals (the same screens call these paths) ──
principalRouter.get("/help/categories", h(({ inst }) => t.helpCategories(inst)));
principalRouter.get("/help/tickets", h(({ inst, me }) => t.myTickets(inst, me)));
principalRouter.post("/help/tickets", h(({ inst, me, req }) => t.raiseTicket(inst, me, req.body, "Staff"), 201));
principalRouter.post("/help/tickets/:id/rate", h(({ inst, me, req }) => t.rateTicket(inst, me, uuid(req), req.body)));
principalRouter.get("/calendar", h(({ inst, me, req }) => {
  const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  return t.calendar(inst, me, q.from, q.to);
}));
principalRouter.get("/payslips", self, h(({ inst, me, req }) => m.payslips(inst, me, typeof req.query.month === "string" ? req.query.month : undefined)));
