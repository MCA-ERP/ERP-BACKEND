import { Router } from "express";
import { authGuard } from "../../middleware/authGuard";
import {
  statsController,
  listStudentsController,
  enrollStudentController,
} from "./sis.controller";

export const sisRouter = Router();

// GET  /api/v1/sis/stats      — Dashboard KPI metrics
sisRouter.get("/stats", statsController);

// GET  /api/v1/sis/students   — Student directory (protected)
sisRouter.get("/students", authGuard, listStudentsController);

// POST /api/v1/sis/students   — Enroll new student (auto Student ID)
sisRouter.post("/students", enrollStudentController);
