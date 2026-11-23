import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requireRoles } from "../../middleware/rbacGuard";
import { requireInstitutionId } from "../../lib/tenant";
import { HttpError, sendError } from "../../lib/http-error";
import * as a from "./accounts.service";
import * as cf from "./accounts-fees.service";
import * as bl from "./accounts-billing.service";
import * as bk from "./accounts-books.service";
import * as gl from "./accounts-gl.service";
import * as rp from "./accounts-reports.service";
import { accountsChat } from "./accounts-assist";
import { transcribe as transcribeAudio } from "../admin/assist.service";
import * as t from "../teacher/teacher.service";
import * as m from "../teacher/teacher-me.service";

/** The Accounts (Fee & Finance) portal. Only the Accountant role gets in; every handler works on the signed-in accountant's own school. */
export const accountsRouter = Router();

export const ACCOUNTS_ROLES = ["Accountant"];
accountsRouter.use(authGuard);
accountsRouter.use(requireRoles(...ACCOUNTS_ROLES));
// the portal is the school's Fee & Finance module; without it in the plan there is nothing here to open
accountsRouter.use((req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || (u.modules ?? []).includes("fees")) return next();
  res.status(403).json({ error: "Your school's plan does not include Fee & Finance. Ask your administrator to add the module.", code: "MODULE_NOT_IN_PLAN" });
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
const any = (...codes: string[]) => (req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || codes.some((c) => (u.modules ?? []).includes(c))) return next();
  res.status(403).json({ error: "This feature is not included in your school's plan.", code: "MODULE_NOT_IN_PLAN" });
};
const self = any("employee_self_service");
const hrGate = any("hr_payroll", "payroll");

// ── finance dashboard ──
accountsRouter.get("/me", h(({ inst, me }) => a.me(inst, me)));
accountsRouter.get("/overview", h(({ inst }) => a.overview(inst)));
accountsRouter.get("/leadership", h(({ inst }) => a.leadership(inst)));
accountsRouter.put("/revenue-budget", h(({ inst, req }) => a.saveRevenueBudget(inst, req.body)));
accountsRouter.get("/notifications", h(({ inst, me }) => a.notifications(inst, me)));
accountsRouter.post("/notifications/read", h(({ inst, me, req }) => a.markRead(inst, me, req.body)));
accountsRouter.get("/sent-messages", h(({ inst }) => a.sentMessages(inst)));
accountsRouter.get("/exit-clearance", hrGate, h(({ inst }) => a.exitClearance(inst)));
accountsRouter.post("/exit-clearance/:id", hrGate, h(({ inst, req }) => a.clearAccounts(inst, uuid(req))));

// ── concessions and parent payment ──
accountsRouter.get("/concession-types", h(({ inst }) => cf.concessionTypes(inst)));
accountsRouter.post("/concession-types", h(({ inst, me, req }) => cf.addConcessionType(inst, me, req.body), 201));
accountsRouter.get("/concession-register", h(({ inst }) => cf.concessionRegister(inst)));
accountsRouter.get("/concession-requests", h(({ inst, req }) => cf.concessionRequests(inst, req.query.source === "Parent")));
accountsRouter.get("/parent-pay/students", h(({ inst }) => cf.payStudents(inst)));
accountsRouter.get("/parent-pay/student/:id", h(({ inst, req }) => cf.payView(inst, uuid(req))));
accountsRouter.post("/parent-pay/start", h(({ inst, me, req }) => cf.payStart(inst, me, req.body), 201));
accountsRouter.post("/parent-pay/:id/confirm", h(({ inst, me, req }) => cf.payFinish(inst, me, uuid(req), true)));
accountsRouter.post("/parent-pay/:id/fail", h(({ inst, me, req }) => cf.payFinish(inst, me, uuid(req), false)));

// ── invoices and the due list ──
accountsRouter.get("/dues", h(({ inst, req }) => bl.dueList(inst, req.query.term)));
accountsRouter.get("/invoices", h(({ inst, req }) => bl.invoices(inst, req.query.term)));
accountsRouter.get("/invoices/generate", h(({ inst, req }) => bl.generateView(inst, req.query.term, req.query.class_label)));
accountsRouter.post("/invoices/generate", h(({ inst, me, req }) => bl.generate(inst, me, req.body), 201));

// ── expenses and the student ledger ──
accountsRouter.get("/expense-summary", h(({ inst }) => bk.expenseSummary(inst)));
accountsRouter.get("/vendors", h(({ inst }) => bk.vendors(inst)));
accountsRouter.post("/vendors", h(({ inst, me, req }) => bk.addVendor(inst, me, req.body), 201));
accountsRouter.get("/student-ledger/:id", h(({ inst, req }) => bk.studentLedger(inst, uuid(req))));

// ── books of account ──
accountsRouter.get("/gl/chart", h(({ inst }) => gl.chart(inst)));
accountsRouter.post("/gl/chart", h(({ inst, req }) => gl.addAccount(inst, req.body), 201));
accountsRouter.get("/gl/journal", h(({ inst }) => gl.journal(inst)));
accountsRouter.post("/gl/journal", h(({ inst, me, req }) => gl.addJournal(inst, me, req.body), 201));
accountsRouter.get("/gl/ledger/:code", h(({ inst, req }) => gl.ledger(inst, z.string().regex(/^\d{4}$/).parse(req.params.code))));
accountsRouter.get("/gl/statements", h(({ inst }) => gl.statements(inst)));
accountsRouter.get("/gl/bank", h(({ inst }) => gl.bank(inst)));
accountsRouter.post("/gl/bank/mark", h(({ inst, me, req }) => gl.markBank(inst, me, req.body)));

// ── finance reports ──
accountsRouter.get("/reports/class-wise", h(({ inst }) => rp.classWise(inst)));
accountsRouter.get("/reports/category-wise", h(({ inst }) => rp.categoryWise(inst)));

// ── AI insights ──
accountsRouter.get("/insights", h(({ inst, me }) => a.insightList(inst, me)));
accountsRouter.post("/insights/task", h(({ inst, me, req }) => a.createTask(inst, me, req.body), 201));
accountsRouter.get("/alert-rules", h(({ inst }) => a.alertRules(inst)));
accountsRouter.put("/alert-rules", h(({ inst, req }) => a.saveAlertRule(inst, req.body)));

// ── hiring budget ──
accountsRouter.get("/hiring/posts", hrGate, h(({ inst }) => a.postApprovals(inst)));
accountsRouter.post("/hiring/posts/:id", hrGate, h(({ inst, req }) => a.decidePost(inst, uuid(req), req.body, req.user?.role ?? "")));
accountsRouter.get("/hiring/budget", hrGate, h(({ inst }) => a.salaryBudget(inst)));
accountsRouter.get("/hiring/settlements", hrGate, h(({ inst }) => a.finalSettlements(inst)));

// ── staff self-service shared with the Teacher portal (the same screens call these paths) ──
accountsRouter.get("/help/categories", h(({ inst }) => t.helpCategories(inst)));
accountsRouter.get("/help/tickets", h(({ inst, me }) => t.myTickets(inst, me)));
accountsRouter.post("/help/tickets", h(({ inst, me, req }) => t.raiseTicket(inst, me, req.body, "Staff"), 201));
accountsRouter.post("/help/tickets/:id/rate", h(({ inst, me, req }) => t.rateTicket(inst, me, uuid(req), req.body)));
accountsRouter.get("/calendar", h(({ inst, me, req }) => {
  const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  return t.calendar(inst, me, q.from, q.to);
}));
accountsRouter.get("/payslips", self, h(({ inst, me, req }) => m.payslips(inst, me, typeof req.query.month === "string" ? req.query.month : undefined)));
accountsRouter.get("/claims", self, h(({ inst, me }) => m.claims(inst, me)));
accountsRouter.post("/claims", self, h(({ inst, me, req }) => m.submitClaim(inst, me, req.body), 201));

// ── assistant (fee and finance records only) ──
accountsRouter.post("/assist/chat", h(({ inst, me, req }) => {
  const b = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20), page: z.string().trim().max(200).optional(), guide: z.string().max(6000).optional() }).parse(req.body);
  if (b.messages[b.messages.length - 1].role !== "user") throw new HttpError(400, "Ask a question first.");
  return accountsChat(b.messages, b.page, b.guide ?? "", inst, me, req.user?.roleDisplayName ?? "");
}));
accountsRouter.post("/assist/transcribe", express.raw({ type: "audio/*", limit: "2mb" }), h(({ me, req }) => {
  const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the recording as audio.");
  return transcribeAudio(req.body, mime, me);
}));
