import { Router } from "express";
import { authGuard } from "../../middleware/authGuard";
import { requireModule, requirePermission } from "../../middleware/rbacGuard";
import { timetableController } from "./academics.controller";

export const academicsRouter = Router();

academicsRouter.use(authGuard, requireModule("timetable"));

// GET /api/v1/academics/timetable    — Weekly timetable
academicsRouter.get("/timetable", requirePermission("academics.timetable.view"), timetableController);
