import { Request, Response } from "express";
import { getWeeklyTimetable } from "./academics.service";

/**
 * GET /api/v1/academics/timetable
 */
export async function timetableController(_req: Request, res: Response): Promise<void> {
  res.json({ schedule: getWeeklyTimetable() });
}
