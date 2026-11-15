import { Router } from "express";
import { authGuard } from "../../middleware/authGuard";
import { requirePermission } from "../../middleware/rbacGuard";
import { supabaseAdmin } from "../../../db/client";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import * as account from "./account.service";
import { sessionIdOf } from "../../lib/sessions";
import { loginController, logoutController, meController, rolesController, verifyController } from "./auth.controller";

export const authRouter = Router();

// POST /api/v1/auth/login   — Email + password login
authRouter.post("/login", loginController);

// POST /api/v1/auth/login/verify — the sign-in code, after the password
authRouter.post("/login/verify", verifyController);

// POST /api/v1/auth/logout — end this session
authRouter.post("/logout", authGuard, logoutController);

// GET  /api/v1/auth/me      — Current session profile (protected)
authRouter.get("/me", authGuard, meController);

// GET  /api/v1/auth/roles   — List all ERP roles (protected)
authRouter.get("/roles", authGuard, requirePermission("admin.users.manage"), rolesController);

// POST /api/v1/auth/password-changed — the signed-in user has replaced their temporary password
authRouter.post("/password-changed", authGuard, async (req, res) => {
  if (!req.user?.profileId) {
    res.status(400).json({ error: "No profile to update." });
    return;
  }
  const { error } = await supabaseAdmin.from("user_profiles").update({ must_change_password: false }).eq("id", req.user.profileId);
  if (error) {
    res.status(500).json({ error: "Could not update the profile." });
    return;
  }
  res.json({ success: true });
});

// ── my account: profile, password, two-step sign-in, my sign-ins ──
type H = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: H) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const me = (req: Request) => ({ profileId: req.user?.profileId, email: req.user!.email, role: req.user!.role });
const token = (req: Request) => req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";

authRouter.get("/account", authGuard, h(async (req, res) => res.json(await account.getAccount(me(req)))));
authRouter.patch(
  "/account",
  authGuard,
  h(async (req, res) => {
    const b = z.object({ first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), phone: z.string().trim().max(30).nullable() }).partial().strict().parse(req.body);
    res.json(await account.updateProfile(me(req), b));
  })
);
authRouter.post(
  "/account/create-profile",
  authGuard,
  h(async (req, res) => {
    const b = z.object({ first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), phone: z.string().trim().max(30).nullable().optional() }).parse(req.body);
    res.status(201).json(await account.createBootstrapProfile(req.user!.id, me(req), b));
  })
);
authRouter.post(
  "/change-password",
  authGuard,
  h(async (req, res) => {
    const b = z.object({ current_password: z.string().min(1).max(200), new_password: z.string().min(8).max(72) }).parse(req.body);
    res.json(await account.changePassword(me(req), token(req), b));
  })
);
authRouter.put("/two-factor", authGuard, h(async (req, res) => res.json(await account.setTwoFactor(me(req), z.object({ enabled: z.boolean() }).parse(req.body).enabled))));
authRouter.get("/two-factor/devices", authGuard, h(async (req, res) => res.json(await account.listTrustedDevices(me(req)))));
authRouter.delete("/two-factor/devices/:id", authGuard, h(async (req, res) => res.json(await account.removeTrustedDevice(me(req), z.string().uuid().parse(req.params.id)))));
authRouter.get("/my-activity", authGuard, h(async (req, res) => res.json(await account.myActivity(me(req), sessionIdOf(token(req))))));
authRouter.post("/my-activity/sessions/:id/end", authGuard, h(async (req, res) => res.json(await account.endMySession(me(req), z.string().uuid().parse(req.params.id)))));
