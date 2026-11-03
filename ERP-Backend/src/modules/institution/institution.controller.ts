import { Request, Response } from "express";
import { z } from "zod";
import { sendError } from "../../lib/http-error";
import { resolveInstitutionId } from "../../lib/tenant";
import { getInstitution, listAllSchools, registerSchool, getSchoolByCode } from "./institution.service";

const registerSchema = z.object({
  name: z.string().trim().min(2, "School name is required.").max(255),
  code: z.string().trim().max(50).regex(/^[A-Za-z0-9_-]*$/, "Code may contain letters, digits, - and _").optional(),
  type: z.string().trim().max(50).optional(),
  contact_email: z.string().trim().email().optional().or(z.literal("")),
  contact_phone: z.string().trim().max(50).optional(),
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  website: z.string().trim().max(255).optional(),
});

/** GET /api/v1/institution — the caller's own institution */
export async function getInstitutionController(req: Request, res: Response): Promise<void> {
  try {
    res.json({ institution: await getInstitution(resolveInstitutionId(req)) });
  } catch (err) {
    sendError(res, err, "Failed to load institution");
  }
}

/** GET /api/v1/institution/all (SuperAdmin) */
export async function listSchoolsController(_req: Request, res: Response): Promise<void> {
  try {
    res.json({ schools: await listAllSchools() });
  } catch (err) {
    sendError(res, err, "Failed to load schools list");
  }
}

/** POST /api/v1/institution/register (SuperAdmin) */
export async function registerSchoolController(req: Request, res: Response): Promise<void> {
  try {
    const school = await registerSchool(registerSchema.parse(req.body));
    res.status(201).json({ success: true, message: "School registered successfully.", school });
  } catch (err) {
    sendError(res, err, "Failed to register school");
  }
}

/** GET /api/v1/institution/by-code/:code — public, minimal fields */
export async function getSchoolByCodeController(req: Request, res: Response): Promise<void> {
  try {
    const full = await getSchoolByCode(req.params.code as string);
    res.json({ school: { code: full.code, name: full.name, type: full.type, is_active: full.is_active } });
  } catch (err) {
    sendError(res, err, "Failed to look up school code");
  }
}
