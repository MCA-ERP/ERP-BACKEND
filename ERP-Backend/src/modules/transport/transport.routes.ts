import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requireRoles } from "../../middleware/rbacGuard";
import { requireInstitutionId } from "../../lib/tenant";
import { HttpError, sendError } from "../../lib/http-error";
import * as p from "./transport-portal.service";
import * as o from "./transport-ops.service";
import * as f from "./transport-parents.service";
import { transportChat } from "./transport-assist";
import { transcribe as transcribeAudio } from "../admin/assist.service";
import * as t from "../teacher/teacher.service";
import * as m from "../teacher/teacher-me.service";

/**
 * The Transport portal. Only the Transport Manager gets in; every handler works on the signed-in person's own school.
 * Vehicles, crew, routes, stops, allocations, trips and bus attendance are served by the School Admin routes
 * (/school/tr/*), which let the Transport Manager in.
 */
export const transportRouter = Router();

export const TRANSPORT_ROLES = ["TransportManager"];
transportRouter.use(authGuard);
transportRouter.use(requireRoles(...TRANSPORT_ROLES));
// the portal is the school's Transport module; without it in the plan there is nothing here to open
transportRouter.use((req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || (u.modules ?? []).includes("transport")) return next();
  res.status(403).json({ error: "Your school's plan does not include Transport. Ask your administrator to add the module.", code: "MODULE_NOT_IN_PLAN" });
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
const q = (req: Request, k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : "");
const any = (...codes: string[]) => (req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || codes.some((c) => (u.modules ?? []).includes(c))) return next();
  res.status(403).json({ error: "This feature is not included in your school's plan.", code: "MODULE_NOT_IN_PLAN" });
};
const self = any("employee_self_service");

// ── dashboard, the sidebar badge, the bell and search ──
transportRouter.get("/me", h(({ inst, me }) => p.me(inst, me)));
transportRouter.get("/dashboard", h(({ inst }) => p.dashboard(inst)));
transportRouter.get("/notifications", h(({ inst, me }) => p.notifications(inst, me)));
transportRouter.post("/notifications/read", h(({ inst, me, req }) => p.markRead(inst, me, req.body)));
transportRouter.get("/search", h(({ inst, req }) => p.search(inst, req.query.q)));

// ── settings are read only; a change is asked of the School Admin ──
transportRouter.get("/settings", h(({ inst }) => p.settingsView(inst)));
transportRouter.post("/settings/request", h(({ inst, me, req }) => p.requestChange(inst, me, req.body), 201));

// ── messages to parents ──
transportRouter.get("/sent-messages", h(({ inst }) => p.sentMessages(inst)));
transportRouter.get("/parent-updates", h(({ inst, mods }) => f.updateOptions(inst, mods)));
transportRouter.post("/parent-updates", h(({ inst, me, mods, req }) => f.sendUpdate(inst, me, mods, req.body), 201));
transportRouter.get("/sent-updates", h(({ inst }) => f.sentUpdates(inst)));
transportRouter.get("/parent-view", h(({ inst, req }) => f.parentPreview(inst, q(req, "student_id") || undefined)));
transportRouter.put("/parent-sharing", h(({ inst, req }) => f.saveSharing(inst, req.body)));

// ── transport fees (billed and collected in Fee & Finance) ──
transportRouter.get("/fees", h(({ inst }) => f.feeRule(inst)));
transportRouter.post("/fees/remind", h(({ inst, me, req }) => f.remindFees(inst, me, req.body), 201));
transportRouter.post("/fees/ask", h(({ inst, me, req }) => f.askFinance(inst, me, req.body), 201));

// ── staff exit clearance (blocks HR's final settlement until cleared) ──
transportRouter.get("/exit-clearance", any("hr_payroll"), h(({ inst }) => p.clearance(inst)));
transportRouter.post("/exit-clearance/:id", any("hr_payroll"), h(({ inst, me, req }) => p.markCleared(inst, me, uuid(req))));

// ── vehicles, their documents and route assignment ──
transportRouter.get("/vehicles", h(({ inst }) => p.fleet(inst)));
transportRouter.post("/vehicles", h(({ inst, req }) => p.addVehicle(inst, req.body), 201));
transportRouter.post("/vehicles/:id/documents", h(({ inst, req }) => p.renewDocument(inst, uuid(req), req.body)));
// the body is the raw PDF, JPG or PNG; its type is checked against the file's own first bytes, its size against 5 MB
transportRouter.post("/vehicles/:id/scan", express.raw({ type: ["application/pdf", "image/png", "image/jpeg"], limit: p.MAX_FILE }), h(({ inst, req }) =>
  p.uploadScan(inst, uuid(req), q(req, "doc_type"), q(req, "name"), String(req.headers["content-type"] ?? "").split(";")[0], Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)), 201));
transportRouter.get("/documents/:id/link", h(({ inst, req }) => p.scanLink(inst, uuid(req))));

// ── drivers and attendants ──
const upload = express.raw({ type: ["application/pdf", "image/png", "image/jpeg"], limit: p.MAX_FILE });
const body = (req: Request) => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
const mimeOf = (req: Request) => String(req.headers["content-type"] ?? "").split(";")[0];
transportRouter.get("/crew", h(({ inst }) => o.crew(inst)));
transportRouter.post("/crew", h(({ inst, req }) => o.registerCrew(inst, req.body), 201));
transportRouter.post("/crew/drivers/:id/licence", h(({ inst, req }) => o.updateLicence(inst, uuid(req), req.body)));
transportRouter.post("/crew/:role/:id/verify", h(({ inst, req }) => o.verifyPolice(inst, String(req.params.role), uuid(req))));
transportRouter.post("/crew/:role/:id/documents", upload, h(({ inst, req }) => o.uploadCrewFile(inst, String(req.params.role), uuid(req), q(req, "name"), mimeOf(req), body(req)), 201));
transportRouter.get("/crew-documents/:id/link", h(({ inst, req }) => o.crewFileLink(inst, uuid(req))));

// ── routes, stops and timings ──
transportRouter.get("/routes", h(({ inst }) => o.routeBook(inst)));
transportRouter.post("/routes", h(({ inst, req }) => o.createRoute(inst, req.body), 201));
transportRouter.post("/routes/:id/activate", h(({ inst, req }) => o.activateRoute(inst, uuid(req))));
transportRouter.get("/timings", h(({ inst }) => o.timings(inst)));
transportRouter.put("/timings/:id", h(({ inst, req }) => o.saveTimings(inst, uuid(req), req.body)));
transportRouter.get("/planner", h(({ inst, req }) => o.planner(inst, { seats: Number(req.query.seats), longest: Number(req.query.longest), walk: Number(req.query.walk) })));
transportRouter.post("/planner/apply", h(({ inst, req }) => o.applyPlan(inst, req.body), 201));
transportRouter.post("/planner/homes", h(({ inst, req }) => o.saveHomes(inst, req.body)));

// ── students on stops and what parents ask for ──
transportRouter.get("/students", h(({ inst }) => o.studentBoard(inst)));
transportRouter.put("/students/:id/allocation", h(({ inst, req }) => o.allocate(inst, uuid(req), req.body)));
transportRouter.get("/requests", h(({ inst }) => o.parentRequests(inst)));
transportRouter.post("/requests/decide", h(({ inst, me, req }) => o.decideParentRequest(inst, me, req.body)));
transportRouter.get("/app-requests", h(({ inst }) => o.appRequests(inst)));
transportRouter.post("/app-requests/:id", h(({ inst, me, req }) => o.decideAppRequest(inst, me, uuid(req), req.body)));

// ── vehicle, driver and attendant of each route ──
transportRouter.get("/assignments", h(({ inst }) => o.assignments(inst)));
transportRouter.put("/assignments/:id", h(({ inst, req }) => o.setAssignment(inst, uuid(req), req.body)));

// ── trips ──
transportRouter.get("/live", h(({ inst }) => o.liveBoard(inst)));
transportRouter.post("/trips/:id/delay", h(({ inst, me, req }) => o.reportDelay(inst, me, uuid(req), req.body)));
transportRouter.get("/trip-log", h(({ inst }) => o.tripLog(inst)));
transportRouter.get("/vehicle-status", h(({ inst }) => o.vehicleStatus(inst)));
transportRouter.get("/driver", h(({ inst, req }) => o.driverView(inst, q(req, "route_id"))));
transportRouter.post("/sos", h(({ inst, me, req }) => o.sos(inst, me, req.body), 201));

// ── staff self-service shared with the other staff portals (the same screens call these paths) ──
transportRouter.get("/help/categories", h(({ inst }) => t.helpCategories(inst)));
transportRouter.get("/help/tickets", h(({ inst, me }) => t.myTickets(inst, me)));
transportRouter.post("/help/tickets", h(({ inst, me, req }) => t.raiseTicket(inst, me, req.body, "Staff"), 201));
transportRouter.post("/help/tickets/:id/rate", h(({ inst, me, req }) => t.rateTicket(inst, me, uuid(req), req.body)));
transportRouter.get("/calendar", h(({ inst, me, req }) => {
  const r = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  return t.calendar(inst, me, r.from, r.to);
}));
transportRouter.get("/payslips", self, h(({ inst, me, req }) => m.payslips(inst, me, typeof req.query.month === "string" ? req.query.month : undefined)));
transportRouter.get("/claims", self, h(({ inst, me }) => m.claims(inst, me)));
transportRouter.post("/claims", self, h(({ inst, me, req }) => m.submitClaim(inst, me, req.body), 201));

// ── assistant (transport records only) ──
transportRouter.post("/assist/chat", any("school_assistant"), h(({ inst, me, req }) => {
  const b = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20), page: z.string().trim().max(200).optional(), guide: z.string().max(6000).optional() }).parse(req.body);
  if (b.messages[b.messages.length - 1].role !== "user") throw new HttpError(400, "Ask a question first.");
  return transportChat(b.messages, b.page, b.guide ?? "", inst, me, req.user?.roleDisplayName ?? "");
}));
transportRouter.post("/assist/transcribe", any("school_assistant"), express.raw({ type: "audio/*", limit: "2mb" }), h(({ me, req }) => {
  const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the recording as audio.");
  return transcribeAudio(req.body, mime, me);
}));
