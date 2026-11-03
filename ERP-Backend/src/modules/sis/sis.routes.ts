import { Router } from "express";
import { authGuard } from "../../middleware/authGuard";
import { requireModule, requirePermission } from "../../middleware/rbacGuard";
import {
  statsController,
  listStudentsController,
  enrollStudentController,
} from "./sis.controller";

export const sisRouter = Router();

sisRouter.use(authGuard, requireModule("student_information"));

// GET  /api/v1/sis/stats      — KPI counts for the caller's institution
sisRouter.get("/stats", requirePermission("sis.student.view"), statsController);

// GET  /api/v1/sis/students   — Student directory
sisRouter.get("/students", requirePermission("sis.student.view"), listStudentsController);

// POST /api/v1/sis/students   — Enroll a new student (auto registration number)
sisRouter.post("/students", requirePermission("sis.student.create"), enrollStudentController);
