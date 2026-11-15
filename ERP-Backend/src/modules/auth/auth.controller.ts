import { Request, Response } from "express";
import { loginUser, logoutUser, getUserProfile, listRoles, verifyLoginCode } from "./auth.service";
import { clientIp } from "../admin/security.service";
import { HttpError } from "../../lib/http-error";

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
    const deviceToken = typeof req.body.deviceToken === "string" ? req.body.deviceToken : undefined;
    const result = await loginUser({ email: String(email), password: String(password), deviceToken }, { ip: clientIp(req), userAgent: req.headers["user-agent"] ?? null });
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Login failed";
    res.status(err instanceof HttpError ? err.status : 401).json({ error: msg });
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

/** POST /api/v1/auth/logout: ends the caller's tracked session. */
export async function logoutController(req: Request, res: Response): Promise<void> {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const u = req.user;
  await logoutUser(token, u?.profileId ? { id: u.profileId, email: u.email, institution_id: u.institutionId ?? null } : null, { ip: clientIp(req), userAgent: req.headers["user-agent"] ?? null }).catch(() => undefined);
  res.json({ success: true });
}

/** POST /api/v1/auth/login/verify: the code, after the password. */
export async function verifyController(req: Request, res: Response): Promise<void> {
  const { email, password, challenge_id, code, trust_device } = req.body ?? {};
  if (!email || !password || !challenge_id || !code) {
    res.status(400).json({ error: "Email, password and the code are required." });
    return;
  }
  try {
    res.json(await verifyLoginCode({ email: String(email), password: String(password), challengeId: String(challenge_id), code: String(code), trustDevice: trust_device === true }, { ip: clientIp(req), userAgent: req.headers["user-agent"] ?? null }));
  } catch (err: unknown) {
    res.status(err instanceof HttpError ? err.status : 401).json({ error: err instanceof Error ? err.message : "Verification failed" });
  }
}
