import { Router } from "express";
import { departmentsController, timetableController } from "./academics.controller";

export const academicsRouter = Router();

// GET /api/v1/academics/departments  — Department + programs list
academicsRouter.get("/departments", departmentsController);

// GET /api/v1/academics/timetable    — Weekly master timetable
academicsRouter.get("/timetable", timetableController);
