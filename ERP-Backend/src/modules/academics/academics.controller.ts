import { Request, Response } from "express";
import { listDepartments, getWeeklyTimetable } from "./academics.service";

/**
 * GET /api/v1/academics/departments
 */
export async function departmentsController(_req: Request, res: Response): Promise<void> {
  try {
    const departments = await listDepartments();
    res.json({ departments });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to load departments";
    res.status(500).json({ error: msg });
  }
}

/**
 * GET /api/v1/academics/timetable
 */
export async function timetableController(_req: Request, res: Response): Promise<void> {
  try {
    const schedule = getWeeklyTimetable();
    res.json({ schedule });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to load timetable";
    res.status(500).json({ error: msg });
  }
}
