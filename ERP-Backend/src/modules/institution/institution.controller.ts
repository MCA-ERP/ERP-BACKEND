import { Request, Response } from "express";
import { getInstitution, listAllSchools, registerSchool, getSchoolByCode } from "./institution.service";

/**
 * GET /api/v1/institution
 */
export async function getInstitutionController(_req: Request, res: Response): Promise<void> {
  try {
    const institution = await getInstitution();
    res.json({ institution });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to load institution master";
    res.status(500).json({ error: msg });
  }
}

/**
 * GET /api/v1/institution/all
 */
export async function listSchoolsController(_req: Request, res: Response): Promise<void> {
  try {
    const schools = await listAllSchools();
    res.json({ schools });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to load schools list";
    res.status(500).json({ error: msg });
  }
}

/**
 * POST /api/v1/institution/register
 */
export async function registerSchoolController(req: Request, res: Response): Promise<void> {
  try {
    const { name } = req.body;
    if (!name) {
      res.status(400).json({ error: "School name is required." });
      return;
    }

    const school = await registerSchool(req.body);
    res.status(201).json({ success: true, message: "School registered successfully.", school });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to register school";
    res.status(500).json({ error: msg });
  }
}

/**
 * GET /api/v1/institution/by-code/:code
 */
export async function getSchoolByCodeController(req: Request, res: Response): Promise<void> {
  try {
    const code = req.params.code as string;
    const school = await getSchoolByCode(code);
    res.json({ school });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to look up school code";
    res.status(err instanceof Error && err.message.includes("not found") ? 404 : 500).json({ error: msg });
  }
}
