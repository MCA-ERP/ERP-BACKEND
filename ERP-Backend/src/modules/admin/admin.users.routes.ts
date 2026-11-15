import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { actorName } from "../../lib/actor";
import * as u from "./users-mgmt.service";

/** The user directory, account actions, login activity, and student and parent accounts. */
export const usersRouter = Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const uuid = (req: Request, name = "id") => z.string().uuid("Invalid id.").parse(req.params[name]);

usersRouter.get("/user-directory", h(async (req, res) => res.json(await u.listDirectory(req.query))));
usersRouter.get("/user-directory/counts", h(async (_req, res) => res.json(await u.directoryCounts())));

usersRouter.post(
  "/user-directory/:id/reset-password",
  h(async (req, res) => {
    const b = z.object({ mode: z.enum(["temporary", "link"]), password: z.string().min(8).max(72).optional() }).parse(req.body);
    res.json(await u.resetPassword(uuid(req), b, await actorName(req), req.user?.role));
  })
);
usersRouter.post(
  "/user-directory/:id/state",
  h(async (req, res) => {
    const { state } = z.object({ state: z.enum(["disable", "enable", "unlock"]) }).parse(req.body);
    res.json(await u.setAccountState(uuid(req), state, await actorName(req), req.user?.role));
  })
);
usersRouter.post("/user-directory/:id/end-sessions", h(async (req, res) => res.json(await u.endAllSessions(uuid(req), await actorName(req)))));

usersRouter.get("/login-activity/history", h(async (req, res) => res.json(await u.loginHistory(req.query, true))));
usersRouter.get("/login-activity/failed", h(async (req, res) => res.json({ ...(await u.loginHistory(req.query, false)), locked: await u.lockedAccounts() })));
usersRouter.get("/login-activity/sessions", h(async (req, res) => res.json(await u.activeSessions(req.query))));
usersRouter.post("/login-activity/sessions/:id/end", h(async (req, res) => res.json(await u.endSession(uuid(req), await actorName(req)))));

usersRouter.get("/student-accounts", h(async (req, res) => res.json(await u.listStudentAccounts(req.query))));
usersRouter.post(
  "/student-accounts",
  h(async (req, res) => {
    const { student_ids } = z.object({ student_ids: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
    res.status(201).json(await u.createStudentAccounts(student_ids, await actorName(req), req.user?.role));
  })
);

usersRouter.get("/parent-accounts", h(async (req, res) => res.json(await u.listParentAccounts(req.query))));
usersRouter.post(
  "/parent-accounts",
  h(async (req, res) => {
    const { guardian_id } = z.object({ guardian_id: z.string().uuid() }).parse(req.body);
    res.status(201).json(await u.createParentAccount(guardian_id, await actorName(req), req.user?.role));
  })
);
