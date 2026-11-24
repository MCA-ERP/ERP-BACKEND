import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { applicantLinkLimiter, applicantSignupLimiter } from "../../middleware/security";
import { requireInstitutionId } from "../../lib/tenant";
import { HttpError, sendError } from "../../lib/http-error";
import * as a from "./applicant.service";
import * as acc from "./applicant.account";
import { applicantChat } from "./applicant-assist";
import { transcribe as transcribeAudio } from "../admin/assist.service";

/** The Applicant portal: families applying for admission. Only the Applicant role gets in (a Super Admin has no family, so is refused too). */
export const applicantRouter = Router();
export const APPLICANT_ROLES = ["Applicant"];

applicantRouter.use(authGuard);
applicantRouter.use((req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || !APPLICANT_ROLES.includes(u.role)) { res.status(403).json({ error: "Forbidden. This area is for applicant families." }); return; }
  // the portal is the school's Admissions module; without it in the plan there is nothing here to open
  if (!(u.modules ?? []).includes("online_admissions")) { res.status(403).json({ error: "Your school's plan does not include online admissions.", code: "MODULE_NOT_IN_PLAN" }); return; }
  next();
});

type Ctx = { inst: string; me: string; req: Request };
const h = (fn: (c: Ctx, res: Response) => Promise<unknown>, status = 200) => async (req: Request, res: Response, _n: NextFunction) => {
  try {
    // the school and the family are the session's: nothing the browser sends can name another school or family
    const inst = requireInstitutionId(req);
    const me = req.user?.profileId;
    if (!me) throw new HttpError(401, "Sign in again.");
    res.status(status).json(await fn({ inst, me, req }, res));
  } catch (err) {
    sendError(res, err, "Request failed");
  }
};
const uuid = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const header = (v: unknown) => { try { return decodeURIComponent(str(v)); } catch { return ""; } };

applicantRouter.get("/me", h(({ inst, me }) => a.me(inst, me)));
applicantRouter.get("/overview", h(({ inst, me, req }) => a.overview(inst, me, str(req.query.application) || undefined)));
applicantRouter.get("/notifications", h(({ inst, me }) => a.notifications(inst, me)));
applicantRouter.post("/notifications/read", h(({ me, req }) => a.markRead(me, req.body)));
applicantRouter.get("/search", h(({ inst, me, req }) => a.search(inst, me, req.query.q)));
applicantRouter.post("/link", applicantLinkLimiter, h(({ inst, me, req }) => acc.link(inst, me, req.body)));

// about the school
applicantRouter.get("/school/overview", h(({ inst }) => a.schoolOverview(inst)));
applicantRouter.get("/school/classes", h(({ inst }) => a.classesAndSeats(inst)));
applicantRouter.get("/school/fees", h(({ inst, req }) => a.feeStructure(inst, str(req.query.class) || "Class 1")));
applicantRouter.get("/school/calendar", h(({ inst }) => a.calendar(inst)));
applicantRouter.get("/school/faqs", h(({ inst }) => a.faqs(inst)));
applicantRouter.get("/school/subjects", h(({ inst }) => a.subjects(inst)));

// enquiry and visit
applicantRouter.get("/enquiries", h(({ inst, me }) => a.enquiries(inst, me)));
applicantRouter.post("/enquiries", h(({ inst, me, req }) => a.askEnquiry(inst, me, req.body), 201));
applicantRouter.get("/visits", h(({ inst, me }) => a.visits(inst, me)));
applicantRouter.post("/visits/book", h(({ inst, me, req }) => a.bookVisit(inst, me, req.body)));

// application
applicantRouter.get("/programmes", h(({ inst }) => a.programmeCards(inst)));
applicantRouter.post("/eligibility", h(({ inst, req }) => a.checkEligibility(inst, req.body)));
applicantRouter.get("/applications", h(({ inst, me }) => a.myApplications(inst, me)));
applicantRouter.post("/applications", h(({ inst, me, req }) => a.startApplication(inst, me, req.body), 201));
applicantRouter.get("/applications/:id", h(({ inst, me, req }) => a.application(inst, me, uuid(req))));
applicantRouter.patch("/applications/:id", h(({ inst, me, req }) => a.saveDetails(inst, me, uuid(req), req.body)));
applicantRouter.post("/applications/:id/submit", h(({ inst, me, req }) => a.submit(inst, me, uuid(req))));
applicantRouter.get("/merit", h(({ inst, me }) => a.meritAndOffer(inst, me)));
applicantRouter.post("/offers/:id/accept", h(({ inst, me, req }) => a.acceptOffer(inst, me, uuid(req))));
applicantRouter.get("/letter", h(({ inst, me }) => a.letter(inst, me)));

// documents: the body is the raw PDF, JPG or PNG; its type is checked against the file's own first bytes, its size against 5 MB
applicantRouter.get("/applications/:id/documents", h(({ inst, me, req }) => a.documents(inst, me, uuid(req))));
applicantRouter.post("/applications/:id/documents", express.raw({ type: ["application/pdf", "image/png", "image/jpeg"], limit: a.MAX_FILE }), h(({ inst, me, req }) =>
  a.uploadDocument(inst, me, uuid(req), header(req.headers["x-doc-type"]), header(req.headers["x-file-name"]).slice(0, 150), str(req.headers["content-type"]).split(";")[0], Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)), 201));
applicantRouter.get("/documents/:id/link", h(({ inst, me, req }) => a.documentLink(inst, me, uuid(req))));

// assessment
applicantRouter.get("/applications/:id/assessment", h(({ inst, me, req }) => a.assessment(inst, me, uuid(req))));
applicantRouter.post("/applications/:id/assessment/book", h(({ inst, me, req }) => a.bookAssessment(inst, me, uuid(req), req.body)));

// fees and payment
applicantRouter.get("/fees", h(({ inst, me, req }) => a.fees(inst, me, str(req.query.application) || undefined)));
applicantRouter.post("/payments/order", h(({ inst, me, req }) => a.payOrder(inst, me, req.body), 201));
applicantRouter.post("/payments/verify", h(({ inst, me, req }) => a.payVerify(inst, me, req.body)));

// messages
applicantRouter.get("/messages", h(({ inst, me }) => a.messages(inst, me)));
applicantRouter.post("/messages", h(({ inst, me, req }) => a.sendMessage(inst, me, req.body), 201));

// the assistant: reads only this family's records and the school's public admission information, changes nothing
const assistOn = (req: Request, res: Response, next: NextFunction) => { if ((req.user?.modules ?? []).includes("school_assistant")) return next(); res.status(403).json({ error: "The assistant is not part of your school's plan.", code: "MODULE_NOT_IN_PLAN" }); };
applicantRouter.post("/assist/chat", assistOn, h(({ inst, me, req }) => {
  const b = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20), page: z.string().trim().max(200).optional(), guide: z.string().max(6000).optional() }).parse(req.body);
  if (b.messages[b.messages.length - 1].role !== "user") throw new HttpError(400, "Ask a question first.");
  return applicantChat(b.messages, b.page, b.guide ?? "", inst, me);
}));
applicantRouter.post("/assist/transcribe", assistOn, express.raw({ type: "audio/*", limit: "2mb" }), h(({ me, req }) => {
  const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the recording as audio.");
  return transcribeAudio(req.body, mime, me);
}));

/** Public, no sign-in: the sign-up page checks the school code and creates the family's account. */
export const applicantPublicRouter = Router();
applicantPublicRouter.get("/school/:code", async (req, res) => { try { res.json(await acc.schoolForSignup(String(req.params.code))); } catch (err) { sendError(res, err, "Could not check the school code"); } });
applicantPublicRouter.post("/register", applicantSignupLimiter, async (req, res) => { try { res.status(201).json(await acc.register(req.body)); } catch (err) { sendError(res, err, "Could not create your account"); } });
