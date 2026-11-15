import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { actorName } from "../../lib/actor";
import * as r from "./roles-mgmt.service";

/** Custom roles, module and page access, assignment and the change history. Access is enforced by adminAccess. */
export const rolesRouter = Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const uuid = (req: Request, name = "id") => z.string().uuid("Invalid id.").parse(req.params[name]);

rolesRouter.get("/role-config/roles", h(async (_req, res) => res.json({ roles: await r.listRoles() })));
rolesRouter.post("/role-config/roles", h(async (req, res) => res.status(201).json({ role: await r.createRole(r.roleSchema.parse(req.body), await actorName(req)) })));
rolesRouter.patch(
  "/role-config/roles/:id",
  h(async (req, res) => {
    const patch = z.object({ display_name: z.string().trim().min(3).max(100), description: z.string().trim().max(500).nullable(), data_scope: z.enum(["school", "campus"]) }).partial().strict().parse(req.body);
    res.json({ role: await r.updateRole(uuid(req), patch, await actorName(req)) });
  })
);
rolesRouter.delete("/role-config/roles/:id", h(async (req, res) => res.json(await r.deleteRole(uuid(req), await actorName(req)))));

rolesRouter.get("/role-config/module-access", h(async (_req, res) => res.json(await r.getModuleAccess())));
rolesRouter.put(
  "/role-config/module-access/:id",
  h(async (req, res) => res.json(await r.setModuleAccess(uuid(req), z.object({ modules: z.array(z.string().min(1)).max(100) }).parse(req.body).modules, await actorName(req))))
);
rolesRouter.get("/role-config/page-access", h(async (_req, res) => res.json(await r.getPageAccess())));
rolesRouter.put(
  "/role-config/page-access/:id",
  h(async (req, res) => res.json(await r.setPageAccess(uuid(req), z.object({ denied: z.array(z.string().min(1)).max(100) }).parse(req.body).denied, await actorName(req))))
);

rolesRouter.get("/role-config/roles/:id/users", h(async (req, res) => res.json({ users: await r.roleUsers(uuid(req), typeof req.query.search === "string" ? req.query.search : undefined) })));
rolesRouter.post(
  "/role-config/roles/:id/assign",
  h(async (req, res) => res.json(await r.assignUsers(uuid(req), z.object({ user_ids: z.array(z.string().uuid()).min(1).max(500) }).parse(req.body).user_ids, await actorName(req), req.user?.role)))
);
rolesRouter.post(
  "/role-config/roles/:id/reassign",
  h(async (req, res) => {
    const b = z.object({ to_role_id: z.string().uuid(), user_ids: z.array(z.string().uuid()).max(500).optional() }).parse(req.body);
    res.json(await r.reassign(uuid(req), b.to_role_id, b.user_ids, await actorName(req), req.user?.role));
  })
);

rolesRouter.get("/role-config/changes", h(async (req, res) => res.json(await r.listChanges(req.query))));
rolesRouter.get("/role-config/roles/:id/history", h(async (req, res) => res.json(await r.history(uuid(req)))));
rolesRouter.post("/role-config/roles/:id/restore", h(async (req, res) => res.json(await r.restore(uuid(req), z.object({ change_id: z.string().uuid() }).parse(req.body).change_id, await actorName(req)))));
