import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requireRoles } from "../../middleware/rbacGuard";
import { requireInstitutionId } from "../../lib/tenant";
import { HttpError, sendError } from "../../lib/http-error";
import { actorName } from "../../lib/actor";
import * as a from "./admissions.service";
import * as s from "./admissions-selection.service";
import * as ob from "./admissions-onboard.service";
import * as ap from "../applicant/applicant.service";
import { admissionsChat } from "./admissions-assist";
import { transcribe as transcribeAudio } from "../admin/assist.service";
import * as t from "../teacher/teacher.service";
import * as m from "../teacher/teacher-me.service";

/** The Admissions portal. Only the Admissions Head gets in; every handler works on the signed-in person's own school. */
export const admissionsRouter = Router();

export const ADMISSIONS_ROLES = ["AdmissionsHead"];
admissionsRouter.use(authGuard);
admissionsRouter.use(requireRoles(...ADMISSIONS_ROLES));
// the portal is the school's Admissions module; without it in the plan there is nothing here to open
admissionsRouter.use((req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || ["admissions", "online_admissions"].some((c) => (u.modules ?? []).includes(c))) return next();
  res.status(403).json({ error: "Your school's plan does not include Admissions. Ask your administrator to add the module.", code: "MODULE_NOT_IN_PLAN" });
});

type Ctx = { inst: string; me: string; req: Request };
const h = (fn: (c: Ctx, res: Response) => Promise<unknown>, status = 200) => async (req: Request, res: Response, _n: NextFunction) => {
  try {
    const inst = requireInstitutionId(req, typeof req.query.institution_id === "string" ? req.query.institution_id : undefined);
    const me = req.user?.profileId;
    if (!me) throw new HttpError(401, "Sign in again.");
    res.status(status).json(await fn({ inst, me, req }, res));
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
const fees = (req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || (u.modules ?? []).includes("fees")) return next();
  res.status(403).json({ error: "Fee & Finance is not part of your school's plan.", code: "MODULE_NOT_IN_PLAN" });
};

// ── dashboard ──
admissionsRouter.get("/me", h(({ inst, me }) => a.me(inst, me)));
admissionsRouter.get("/steps", h(({ inst }) => a.steps(inst)));
admissionsRouter.get("/overview", h(({ inst }) => a.overview(inst)));
admissionsRouter.get("/pipeline", h(({ inst }) => a.pipeline(inst)));
admissionsRouter.get("/search", h(({ inst, req }) => a.search(inst, req.query.q)));
admissionsRouter.get("/notifications", h(({ inst, me }) => a.notifications(inst, me)));
admissionsRouter.post("/notifications/read", h(({ inst, me, req }) => a.markRead(inst, me, req.body)));

// ── enquiries, leads and follow-ups ──
admissionsRouter.get("/enquiries", h(({ inst }) => a.newEnquiries(inst)));
admissionsRouter.post("/enquiries/:id/lead", h(({ inst, me, req }) => a.createLead(inst, me, uuid(req)), 201));
admissionsRouter.get("/leads", h(({ inst }) => a.leads(inst, false)));
admissionsRouter.get("/followups/due", h(({ inst }) => a.leads(inst, true)));
admissionsRouter.get("/followups/history", h(({ inst }) => a.followupHistory(inst)));
admissionsRouter.post("/leads/:id/followup", h(({ inst, me, req }) => a.logFollowup(inst, me, uuid(req), req.body), 201));
admissionsRouter.post("/leads/:id/application", h(({ inst, me, req }) => a.sendApplication(inst, me, uuid(req)), 201));
admissionsRouter.post("/leads/:id/lost", h(({ inst, req }) => a.markLost(inst, uuid(req), req.body)));

// ── applications, verification, test and interview, waitlist ──
admissionsRouter.get("/applications", h(({ inst }) => s.applications(inst)));
admissionsRouter.post("/applications/:id/fee", h(({ inst, req }) => s.collectFee(inst, uuid(req), req.body)));
admissionsRouter.post("/applications/:id/waive", h(({ inst, req }) => s.waiveFee(inst, uuid(req), req.body)));
admissionsRouter.post("/applications/:id/remind", h(({ inst, req }) => s.remind(inst, uuid(req))));
admissionsRouter.put("/applications/:id/details", h(({ inst, req }) => s.saveDetails(inst, uuid(req), req.body)));
admissionsRouter.post("/applications/:id/submit", h(({ inst, req }) => s.submitApplication(inst, uuid(req))));
admissionsRouter.get("/verification/pending", h(({ inst }) => s.verificationPending(inst)));
admissionsRouter.get("/verification/returned", h(({ inst }) => s.returned(inst)));
admissionsRouter.post("/verification/:id/verify", h(({ inst, req }) => s.verify(inst, uuid(req))));
admissionsRouter.post("/verification/:id/return", h(({ inst, req }) => s.returnApplication(inst, uuid(req), req.body)));
admissionsRouter.get("/eligibility-rules", h(({ inst }) => s.eligibilityRules(inst)));
admissionsRouter.put("/eligibility-rules", h(({ inst, req }) => s.setRule(inst, req.body)));
admissionsRouter.get("/selection/to-schedule", h(({ inst }) => s.toSchedule(inst)));
admissionsRouter.post("/selection/:id/schedule", h(({ inst, req }) => s.schedule(inst, uuid(req), req.body), 201));
admissionsRouter.get("/selection/results", h(({ inst }) => s.resultsToEnter(inst)));
admissionsRouter.post("/selection/:id/result", h(({ inst, req }) => s.enterResult(inst, uuid(req), req.body)));
admissionsRouter.get("/waitlisted-rejected", h(({ inst }) => s.waitlistedRejected(inst)));
admissionsRouter.post("/waitlisted-rejected/:id/approve", h(({ inst, req }) => s.approveWaitlisted(inst, uuid(req))));

// ── the Applicant portal's other side: families' messages, the visit and assessment slots they book, documents sent back ──
admissionsRouter.get("/family/threads", h(({ inst }) => ap.staffThreads(inst)));
admissionsRouter.post("/family/reply", h(({ inst, me, req }) => ap.staffReply(inst, me, req.body), 201));
admissionsRouter.get("/family/slots", h(({ inst }) => ap.staffSlots(inst)));
admissionsRouter.post("/family/slots", h(({ inst, me, req }) => ap.staffAddSlots(inst, me, req.body), 201));
admissionsRouter.delete("/family/slots/:id", h(({ inst, req }) => ap.staffDeleteSlot(inst, uuid(req))));
admissionsRouter.post("/family/documents/:id/return", h(({ inst, req }) => ap.staffReturnDocument(inst, uuid(req), req.body)));

// ── fee assignment, registration, class allocation, admitted, reports ──
admissionsRouter.get("/fee-assignment", h(({ inst }) => ob.feeAssignment(inst)));
admissionsRouter.get("/fee-structure", h(({ inst }) => ob.feeStructure(inst)));
admissionsRouter.get("/registration", h(({ inst }) => ob.toRegister(inst)));
admissionsRouter.get("/allocation", h(({ inst }) => ob.allocation(inst)));
admissionsRouter.get("/admitted", h(({ inst }) => ob.admitted(inst)));
admissionsRouter.get("/reports", h(({ inst }) => ob.reports(inst)));

// ── onboarding: fee plan, portal accounts, confirmation ──
admissionsRouter.get("/fee-plans", fees, h(({ inst }) => a.feePlans(inst)));
admissionsRouter.post("/fee-plans/:id", fees, h(({ inst, req }) => a.assignFeePlan(inst, uuid(req))));
admissionsRouter.get("/portal-accounts", h(({ inst }) => a.portalAccounts(inst)));
admissionsRouter.post("/portal-accounts/:id", h(async ({ inst, me, req }) => { const who = await actorName(req); return a.createPortalAccounts(inst, me, who.name, req.user?.role ?? "", uuid(req)); }, 201));
admissionsRouter.get("/confirmations", h(({ inst }) => a.confirmations(inst)));
admissionsRouter.post("/confirmations/:id", h(({ inst, me, req }) => a.confirmAdmission(inst, me, uuid(req))));

// ── staff self-service shared with the Teacher and Accounts portals (the same screens call these paths) ──
admissionsRouter.get("/help/categories", h(({ inst }) => t.helpCategories(inst)));
admissionsRouter.get("/help/tickets", h(({ inst, me }) => t.myTickets(inst, me)));
admissionsRouter.post("/help/tickets", h(({ inst, me, req }) => t.raiseTicket(inst, me, req.body, "Staff"), 201));
admissionsRouter.post("/help/tickets/:id/rate", h(({ inst, me, req }) => t.rateTicket(inst, me, uuid(req), req.body)));
admissionsRouter.get("/calendar", h(({ inst, me, req }) => {
  const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  return t.calendar(inst, me, q.from, q.to);
}));
admissionsRouter.get("/payslips", self, h(({ inst, me, req }) => m.payslips(inst, me, typeof req.query.month === "string" ? req.query.month : undefined)));
admissionsRouter.get("/claims", self, h(({ inst, me }) => m.claims(inst, me)));
admissionsRouter.post("/claims", self, h(({ inst, me, req }) => m.submitClaim(inst, me, req.body), 201));

// ── assistant (admission records only) ──
admissionsRouter.post("/assist/chat", h(({ inst, me, req }) => {
  const b = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20), page: z.string().trim().max(200).optional(), guide: z.string().max(6000).optional() }).parse(req.body);
  if (b.messages[b.messages.length - 1].role !== "user") throw new HttpError(400, "Ask a question first.");
  return admissionsChat(b.messages, b.page, b.guide ?? "", inst, me, req.user?.roleDisplayName ?? "");
}));
admissionsRouter.post("/assist/transcribe", express.raw({ type: "audio/*", limit: "2mb" }), h(({ me, req }) => {
  const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the recording as audio.");
  return transcribeAudio(req.body, mime, me);
}));
