import { Request, Response } from "express";
import { loginUser, getUserProfile, listRoles } from "./auth.service";

/**
 * POST /api/v1/auth/login
 */
export async function loginController(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  try {
    const session = await loginUser({ email, password });
    res.json(session);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Login failed";
    res.status(401).json({ error: msg });
  }
}

/**
 * GET /api/v1/auth/me
 * Return role + permissions of the authenticated user
 */
export async function meController(req: Request, res: Response): Promise<void> {
  try {
    const user = req.user!;
    const permissions = await getUserProfile(user.role);
    res.json({ user, permissions });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to load session profile";
    res.status(500).json({ error: msg });
  }
}

/**
 * GET /api/v1/auth/roles
 */
export async function rolesController(_req: Request, res: Response): Promise<void> {
  try {
    const roles = await listRoles();
    res.json({ roles });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch roles";
    res.status(500).json({ error: msg });
  }
}
