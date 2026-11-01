import { Router } from "express";
import {
  getInstitutionController,
  listSchoolsController,
  registerSchoolController,
  getSchoolByCodeController,
} from "./institution.controller";

export const institutionRouter = Router();

// GET  /api/v1/institution              — Primary institution profile
institutionRouter.get("/", getInstitutionController);

// GET  /api/v1/institution/all          — All registered schools
institutionRouter.get("/all", listSchoolsController);

// POST /api/v1/institution/register     — Register a new school (SuperAdmin)
institutionRouter.post("/register", registerSchoolController);

// GET  /api/v1/institution/by-code/:code — Lookup school by short code
institutionRouter.get("/by-code/:code", getSchoolByCodeController);
