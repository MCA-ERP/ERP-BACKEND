import { Request, Response } from "express";
import { z } from "zod";
import { sendError } from "../../lib/http-error";
import { institutionIdByCode, resolveInstitutionId, requireInstitutionId } from "../../lib/tenant";
import { enrollStudent, getSisStats, listStudents } from "./sis.service";

/** SuperAdmin may target a school by code; everyone else is pinned to their own institution. */
async function institutionFromRequest(req: Request, schoolCode: unknown, required: boolean): Promise<string | null> {
  const code = typeof schoolCode === "string" && schoolCode.trim() ? schoolCode : undefined;
  const requested = code && req.user?.role === "SuperAdmin" ? await institutionIdByCode(code) : undefined;
  return required ? requireInstitutionId(req, requested) : resolveInstitutionId(req, requested);
}

const enrollSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required.").max(100),
  last_name: z.string().trim().min(1, "Last name is required.").max(100),
  gender: z.string().trim().max(20).optional(),
  date_of_birth: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD.").optional().or(z.literal("")),
  grade: z.string().trim().min(1, "Grade is required.").max(50),
  section: z.string().trim().max(50).optional(),
  roll_no: z.string().trim().max(30).optional(),
  guardian_name: z.string().trim().max(200).optional(),
  guardian_phone: z.string().trim().max(30).optional(),
  guardian_relation: z.string().trim().max(50).optional(),
  address: z.string().trim().max(500).optional(),
  school_code: z.string().trim().max(50).optional(),
});

/** GET /api/v1/sis/stats */
export async function statsController(req: Request, res: Response): Promise<void> {
  try {
    const institutionId = await institutionFromRequest(req, req.query.school_code, false);
    res.json(await getSisStats(institutionId));
  } catch (err) {
    sendError(res, err, "Failed to load SIS stats");
  }
}

/** GET /api/v1/sis/students */
export async function listStudentsController(req: Request, res: Response): Promise<void> {
  try {
    const institutionId = await institutionFromRequest(req, req.query.school_code ?? req.query.schoolCode, false);
    res.json(
      await listStudents(institutionId, {
        search: req.query.search as string | undefined,
        status: req.query.status as string | undefined,
        limit: parseInt(req.query.limit as string, 10) || 20,
        offset: parseInt(req.query.offset as string, 10) || 0,
        // roles with campus data scope see only their own campus
        campusId: req.user?.dataScope === "campus" && req.user.campusId ? req.user.campusId : undefined,
      })
    );
  } catch (err) {
    sendError(res, err, "Failed to load students");
  }
}

/** POST /api/v1/sis/students — registration number is generated server-side (e.g. RAVST001) */
export async function enrollStudentController(req: Request, res: Response): Promise<void> {
  try {
    const input = enrollSchema.parse(req.body);
    const institutionId = await institutionFromRequest(req, input.school_code, true);
    const student = await enrollStudent(institutionId!, input, req.user?.profileId);
    res.status(201).json({
      success: true,
      message: `Student enrolled successfully with Student ID: ${student.student_id}`,
      student,
    });
  } catch (err) {
    sendError(res, err, "Failed to enroll student");
  }
}
