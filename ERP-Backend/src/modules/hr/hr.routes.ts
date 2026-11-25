import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requireRoles } from "../../middleware/rbacGuard";
import { requireInstitutionId } from "../../lib/tenant";
import { HttpError, sendError } from "../../lib/http-error";
import * as p from "./hr-portal.service";
import { hrChat } from "./hr-assist";
import { transcribe as transcribeAudio } from "../admin/assist.service";
import * as t from "../teacher/teacher.service";
import * as m from "../teacher/teacher-me.service";
import * as topbar from "../school/topbar.service";

/**
 * The HR portal. Only the HR role gets in; every handler works on the signed-in person's own school. The HR and Payroll
 * records themselves are served by the School Admin routes (/school/hr/*, /school/pay/*), which let HR in with limits.
 */
export const hrRouter = Router();

export const HR_ROLES = ["HR"];
hrRouter.use(authGuard);
hrRouter.use(requireRoles(...HR_ROLES));
// the portal is the school's HR and Payroll modules; with neither in the plan there is nothing here to open
hrRouter.use((req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || ["hr_payroll", "payroll"].some((c) => (u.modules ?? []).includes(c))) return next();
  res.status(403).json({ error: "Your school's plan does not include HR or Payroll. Ask your administrator to add the module.", code: "MODULE_NOT_IN_PLAN" });
});

type Ctx = { inst: string; me: string; mods: string[]; req: Request };
const h = (fn: (c: Ctx) => Promise<unknown>, status = 200) => async (req: Request, res: Response, _n: NextFunction) => {
  try {
    const inst = requireInstitutionId(req, typeof req.query.institution_id === "string" ? req.query.institution_id : undefined);
    const me = req.user?.profileId;
    if (!me) throw new HttpError(401, "Sign in again.");
    res.status(status).json(await fn({ inst, me, mods: req.user?.modules ?? [], req }));
  } catch (err) {
    sendError(res, err, "Request failed");
  }
};
const uuid = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);
const any = (...codes: string[]) => (req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || codes.some((c) => (u.modules ?? []).includes(c))) return next();
  res.status(403).json({ error: "This feature is not included in your school's plan.", code: "MODULE_NOT_IN_PLAN" });
};
const self = any("employee_self_service");
const staffing = any("hr_payroll");

// ── dashboard, the sidebar badge, the bell and search ──
hrRouter.get("/me", h(({ inst, me, mods }) => p.me(inst, me, mods)));
hrRouter.get("/overview", h(({ inst, mods }) => p.overview(inst, mods)));
hrRouter.get("/notifications", h(({ inst, me, mods }) => p.notifications(inst, me, mods)));
hrRouter.post("/notifications/read", h(({ inst, me, mods, req }) => p.markNotificationsRead(inst, me, mods, req.body)));
hrRouter.get("/search", h(({ inst, req }) => topbar.search(inst, req.query.q, false, true)));
hrRouter.get("/pipeline", staffing, h(({ inst }) => p.pipeline(inst)));

// ── verification of what staff sent in, and the claims register (read only) ──
hrRouter.get("/verification", staffing, h(({ inst }) => p.verificationQueue(inst)));
hrRouter.post("/verification/:kind/:id", staffing, h(({ inst, me, req }) => p.verify(inst, me, String(req.params.kind), uuid(req))));
hrRouter.get("/claim-register", staffing, h(({ inst }) => p.claimRegister(inst)));

// ── staff self-service shared with the Teacher, Accounts and Admissions portals (the same screens call these paths) ──
hrRouter.get("/help/categories", h(({ inst }) => t.helpCategories(inst)));
hrRouter.get("/help/tickets", h(({ inst, me }) => t.myTickets(inst, me)));
hrRouter.post("/help/tickets", h(({ inst, me, req }) => t.raiseTicket(inst, me, req.body, "Staff"), 201));
hrRouter.post("/help/tickets/:id/rate", h(({ inst, me, req }) => t.rateTicket(inst, me, uuid(req), req.body)));
hrRouter.get("/calendar", h(({ inst, me, req }) => {
  const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  return t.calendar(inst, me, q.from, q.to);
}));
hrRouter.get("/profile/employment", self, h(({ inst, me }) => p.employment(inst, me)));
hrRouter.get("/profile/qualifications", self, h(({ me }) => m.qualifications(me)));
hrRouter.post("/profile/qualifications", self, h(async ({ me, req }) => ({ item: await m.addQualification(me, req.body) }), 201));
hrRouter.get("/profile/documents", self, h(({ inst, me }) => m.documents(inst, me)));
hrRouter.post("/profile/documents", self, h(({ inst, me, req }) => m.uploadDocument(inst, me, req.body), 201));
hrRouter.get("/payslips", self, h(({ inst, me, req }) => m.payslips(inst, me, typeof req.query.month === "string" ? req.query.month : undefined)));
hrRouter.get("/claims", self, h(({ inst, me }) => m.claims(inst, me)));
hrRouter.post("/claims", self, h(({ inst, me, req }) => m.submitClaim(inst, me, req.body), 201));

// ── assistant (HR records only) ──
hrRouter.post("/assist/chat", any("school_assistant"), h(({ inst, me, mods, req }) => {
  const b = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20), page: z.string().trim().max(200).optional(), guide: z.string().max(6000).optional() }).parse(req.body);
  if (b.messages[b.messages.length - 1].role !== "user") throw new HttpError(400, "Ask a question first.");
  return hrChat(b.messages, b.page, b.guide ?? "", inst, me, mods, req.user?.roleDisplayName ?? "");
}));
hrRouter.post("/assist/transcribe", any("school_assistant"), express.raw({ type: "audio/*", limit: "2mb" }), h(({ me, req }) => {
  const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the recording as audio.");
  return transcribeAudio(req.body, mime, me);
}));
