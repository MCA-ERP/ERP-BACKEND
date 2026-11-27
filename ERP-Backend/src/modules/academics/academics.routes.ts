import { Router } from "express";
import { authGuard } from "../../middleware/authGuard";
import { requireModule, requirePermission, staffOnly } from "../../middleware/rbacGuard";
import { timetableController } from "./academics.controller";

export const academicsRouter = Router();

// the whole school's timetable is not for families: a parent's comes from /api/v1/parent, for their own children
academicsRouter.use(authGuard, staffOnly, requireModule("timetable"));

// GET /api/v1/academics/timetable    — Weekly timetable
academicsRouter.get("/timetable", requirePermission("academics.timetable.view"), timetableController);
