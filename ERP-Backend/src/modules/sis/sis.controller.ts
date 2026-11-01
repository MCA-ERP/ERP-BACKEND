import { Request, Response } from "express";
import { getSisStats, listStudents, enrollStudent } from "./sis.service";

/**
 * GET /api/v1/sis/stats
 * Dashboard overview metrics
 */
export async function statsController(_req: Request, res: Response): Promise<void> {
  try {
    const stats = await getSisStats();
    res.json(stats);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to load SIS stats";
    res.status(500).json({ error: msg });
  }
}

/**
 * GET /api/v1/sis/students
 * List and search students
 */
export async function listStudentsController(req: Request, res: Response): Promise<void> {
  try {
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const school_code = (req.query.school_code || req.query.schoolCode) as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await listStudents(search, status, limit, offset, school_code);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to load students";
    res.status(500).json({ error: msg });
  }
}

/**
 * POST /api/v1/sis/students
 * Enroll a new student with auto-generated Student ID (e.g. RAVST001)
 */
export async function enrollStudentController(req: Request, res: Response): Promise<void> {
  try {
    const { first_name, last_name } = req.body;

    if (!first_name || !last_name) {
      res.status(400).json({ error: "Student first name and last name are required." });
      return;
    }

    const student = await enrollStudent(req.body);

    res.status(201).json({
      success: true,
      message: `Student enrolled successfully with Student ID: ${student.student_id}`,
      student,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to enroll student";
    res.status(500).json({ error: msg });
  }
}
