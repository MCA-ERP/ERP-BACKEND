import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authGuard } from "../../middleware/authGuard";
import { requireRoles } from "../../middleware/rbacGuard";
import { requireInstitutionId } from "../../lib/tenant";
import { HttpError, sendError } from "../../lib/http-error";
import * as hm from "./parent-home.service";
import * as pf from "./parent-profile.service";
import * as ln from "./parent-learning.service";
import * as fe from "./parent-fees.service";
import * as sc from "./parent-school.service";
import { parentChat } from "./parent-assist";
import { transcribe as transcribeAudio } from "../admin/assist.service";
import * as t from "../teacher/teacher.service";

/**
 * The Parent portal. Only a Parent gets in; the school and the account always come from the session, and every handler
 * works on the children linked to that account (see parent-core).
 */
export const parentRouter = Router();

export const PARENT_ROLES = ["Parent"];
parentRouter.use(authGuard);
parentRouter.use(requireRoles(...PARENT_ROLES));

/** Passes when the school's plan (and the Parent role) has any one of the modules. */
const any = (...codes: string[]) => (req: Request, res: Response, next: NextFunction) => {
  const u = req.user;
  if (!u || u.role === "SuperAdmin" || codes.some((c) => (u.modules ?? []).includes(c))) return next();
  res.status(403).json({ error: "Your school's plan does not include this feature.", code: "MODULE_NOT_IN_PLAN" });
};
// the portal itself is the school's Parent app module
parentRouter.use(any("parent_app"));

type Ctx = { inst: string; me: string; mods: string[]; req: Request };
const h = (fn: (c: Ctx) => Promise<unknown>, status = 200) => async (req: Request, res: Response, _n: NextFunction) => {
  try {
    const inst = requireInstitutionId(req);
    const me = req.user?.profileId;
    if (!me) throw new HttpError(401, "Sign in again.");
    res.status(status).json(await fn({ inst, me, mods: req.user?.modules ?? [], req }));
  } catch (err) {
    sendError(res, err, "Request failed");
  }
};
const uuid = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const child = (req: Request) => str(req.query.child);

const attendance = any("attendance");
const exams = any("exams");
const academics = any("academics");
const timetable = any("timetable");
const competitive = any("competitive_prep");
const fees = any("fees");
const homework = any("homework");
const online = any("online_classes", "homework");
const transport = any("transport");
const health = any("health_welfare");
const library = any("library");
const mess = any("cafeteria", "hostel");
const events = any("activities_events", "photo_gallery");
const house = any("house_points", "activities_events");
const talk = any("notifications", "school_diary", "chat", "sms_whatsapp", "whatsapp", "email");

// ── sidebar, bell, search ──
parentRouter.get("/me", h(({ inst, me, mods, req }) => hm.me(inst, me, mods, String(req.headers["user-agent"] ?? ""))));
parentRouter.get("/notifications", h(({ inst, me, mods }) => hm.notifications(inst, me, mods)));
parentRouter.post("/notifications/read", h(({ inst, me, mods, req }) => hm.markRead(inst, me, mods, req.body)));
parentRouter.get("/search", h(({ inst, me, mods, req }) => hm.search(inst, me, mods, req.query.q)));

// ── dashboard, house points, calendar, help desk ──
parentRouter.get("/dashboard", h(({ inst, me, mods, req }) => {
  const q = z.object({ tab: z.enum(hm.TABS).default("overview"), child: z.string().uuid().optional() }).parse(req.query);
  return hm.dashboard(inst, me, mods, q.tab, q.child);
}));
parentRouter.get("/house-points", house, h(({ inst, me, req }) => hm.housePoints(inst, me, child(req))));
parentRouter.get("/calendar", h(({ inst, me, req }) => {
  const q = z.object({ from: z.string(), to: z.string() }).parse(req.query);
  return hm.calendar(inst, me, q.from, q.to);
}));
parentRouter.get("/help/categories", h(({ inst }) => hm.helpCategories(inst)));
parentRouter.get("/help/tickets", h(({ inst, me }) => t.myTickets(inst, me)));
parentRouter.post("/help/tickets", h(({ inst, me, req }) => hm.raiseTicket(inst, me, req.body), 201));
parentRouter.post("/help/tickets/:id/rate", h(({ inst, me, req }) => t.rateTicket(inst, me, uuid(req), req.body)));

// ── parent profile, privacy and consent ──
parentRouter.get("/profile", h(({ inst, me }) => pf.profile(inst, me)));
parentRouter.put("/profile", h(({ inst, me, req }) => pf.saveProfile(inst, me, req.body)));
parentRouter.post("/profile/mobile", h(({ inst, me, req }) => pf.requestMobileChange(inst, me, req.body), 201));
parentRouter.get("/linked", h(({ inst, me }) => pf.linkedStudents(inst, me)));
parentRouter.post("/linked", h(({ inst, me, req }) => pf.requestLink(inst, me, req.body), 201));
parentRouter.get("/consents", h(({ inst, me }) => pf.consents(inst, me)));
parentRouter.post("/consents", h(({ inst, me, req }) => pf.setConsent(inst, me, req.body)));
parentRouter.post("/rights", h(({ inst, me, req }) => pf.useRight(inst, me, req.body), 201));

// ── learning ──
parentRouter.get("/academics/records", exams, h(({ inst, me, req }) => {
  const q = z.object({ tab: z.enum(["report-cards", "marks", "coscholastic", "schedule", "progress", "holistic", "seat"]).default("report-cards"), child: z.string().uuid().optional(), exam: z.string().uuid().optional() }).parse(req.query);
  return ln.records(inst, me, q.child, q.tab, q.exam);
}));
parentRouter.get("/academics/syllabus", academics, h(({ inst, me, req }) => ln.syllabus(inst, me, child(req))));
parentRouter.get("/academics/timetable", timetable, h(({ inst, me, req }) => ln.timetable(inst, me, child(req))));
parentRouter.get("/academics/competitive", competitive, h(({ inst, me, req }) => ln.competitive(inst, me, child(req))));
parentRouter.get("/attendance", attendance, h(({ inst, me, req }) => ln.attendance(inst, me, child(req))));
parentRouter.get("/homework", homework, h(({ inst, me, req }) => ln.homework(inst, me, child(req))));
parentRouter.get("/online", online, h(({ inst, me, req }) => ln.online(inst, me, child(req))));

// ── fees: amounts and payment results are decided here, never by the browser ──
parentRouter.get("/fees", fees, h(({ inst, me, req }) => fe.fees(inst, me, child(req))));
parentRouter.get("/fees/receipts/:id", fees, h(({ inst, me, req }) => fe.feeReceipt(inst, me, uuid(req))));
parentRouter.post("/fees/order", fees, h(({ inst, me, req }) => fe.payOrder(inst, me, req.body), 201));
parentRouter.post("/fees/verify", fees, h(({ inst, me, req }) => fe.payVerify(inst, me, req.body)));
parentRouter.post("/fees/concessions", fees, h(({ inst, me, req }) => fe.askConcession(inst, me, req.body), 201));

// ── requests ──
parentRouter.get("/requests", h(({ inst, me, mods, req }) => sc.requests(inst, me, mods, child(req))));
parentRouter.post("/requests", h(({ inst, me, mods, req }) => sc.raise(inst, me, mods, req.body), 201));

// ── communication ──
parentRouter.get("/messages", talk, h(({ inst, me, req }) => sc.messages(inst, me, child(req))));
parentRouter.post("/messages", talk, h(({ inst, me, req }) => sc.sendMessage(inst, me, req.body), 201));
parentRouter.post("/messages/:id/read", talk, h(({ inst, me, req }) => sc.readMessage(inst, me, uuid(req))));
parentRouter.get("/ptm", talk, h(({ inst, me, req }) => sc.ptm(inst, me, child(req))));
parentRouter.post("/ptm", talk, h(({ inst, me, req }) => sc.bookSlot(inst, me, req.body), 201));
parentRouter.delete("/ptm/:id", talk, h(({ inst, me, req }) => sc.cancelSlot(inst, me, child(req), uuid(req))));
parentRouter.get("/notices", talk, h(({ inst, me, req }) => sc.notices(inst, me, child(req))));
parentRouter.post("/notices/diary/:id/seen", talk, h(({ inst, me, req }) => sc.seeDiary(inst, me, child(req), uuid(req))));

// ── school life and care ──
parentRouter.get("/events", events, h(({ inst, me, mods }) => sc.events(inst, me, mods)));
parentRouter.get("/transport", transport, h(({ inst, me, req }) => sc.transport(inst, me, child(req))));
parentRouter.get("/health", health, h(({ inst, me, req }) => sc.health(inst, me, child(req))));
parentRouter.get("/library", library, h(({ inst, me, req }) => sc.library(inst, me, child(req))));
parentRouter.get("/mess", mess, h(({ inst, me, req }) => sc.mess(inst, me, child(req))));

// ── the assistant: reads only this parent's children, changes nothing ──
const assistOn = any("school_assistant");
parentRouter.post("/assist/chat", assistOn, h(({ inst, me, mods, req }) => {
  const b = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20), page: z.string().trim().max(200).optional(), guide: z.string().max(6000).optional() }).parse(req.body);
  if (b.messages[b.messages.length - 1].role !== "user") throw new HttpError(400, "Ask a question first.");
  return parentChat(b.messages, b.page, b.guide ?? "", inst, me, mods);
}));
parentRouter.post("/assist/transcribe", assistOn, express.raw({ type: "audio/*", limit: "2mb" }), h(({ me, req }) => {
  const mime = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Send the recording as audio.");
  return transcribeAudio(req.body, mime, me);
}));
