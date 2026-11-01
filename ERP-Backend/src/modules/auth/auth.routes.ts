import { Router } from "express";
import { authGuard } from "../../middleware/authGuard";
import { loginController, meController, rolesController } from "./auth.controller";

export const authRouter = Router();

// POST /api/v1/auth/login   — Email + password login
authRouter.post("/login", loginController);

// GET  /api/v1/auth/me      — Current session profile (protected)
authRouter.get("/me", authGuard, meController);

// GET  /api/v1/auth/roles   — List all ERP roles
authRouter.get("/roles", rolesController);
