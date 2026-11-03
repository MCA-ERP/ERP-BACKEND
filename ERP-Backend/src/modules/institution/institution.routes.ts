import { Router } from "express";
import { authGuard } from "../../middleware/authGuard";
import { requireRoles } from "../../middleware/rbacGuard";
import {
  getInstitutionController,
  listSchoolsController,
  registerSchoolController,
  getSchoolByCodeController,
} from "./institution.controller";

export const institutionRouter = Router();

// GET  /api/v1/institution              — Primary institution profile
institutionRouter.get("/", authGuard, getInstitutionController);

// GET  /api/v1/institution/all          — All registered schools (SuperAdmin)
institutionRouter.get("/all", authGuard, requireRoles(), listSchoolsController);

// POST /api/v1/institution/register     — Register a new school (SuperAdmin)
institutionRouter.post("/register", authGuard, requireRoles(), registerSchoolController);

// GET  /api/v1/institution/by-code/:code — Public lookup (name/code only, see controller)
institutionRouter.get("/by-code/:code", getSchoolByCodeController);
