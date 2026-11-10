import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as cfg from "./module-config.service";

/** Module details, dependencies, flags, pricing, bundles and releases. Access is enforced by adminAccess. */
export const moduleConfigRouter = Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const uuid = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);
const code = (req: Request) => z.string().regex(/^[a-z0-9_]{1,40}$/, "Invalid module.").parse(req.params.code);

moduleConfigRouter.get("/module-config/modules/:code", h(async (req, res) => res.json(await cfg.getModuleDetails(code(req)))));
moduleConfigRouter.patch(
  "/module-config/modules/:code",
  h(async (req, res) => {
    const patch = z.object({ category: z.enum(cfg.CATEGORIES), build_status: z.enum(cfg.BUILD_STATUSES), description: z.string().trim().min(3).max(500) }).partial().strict().parse(req.body);
    res.json(await cfg.updateMeta(code(req), patch));
  })
);

moduleConfigRouter.get("/module-config/settings", h(async (_req, res) => res.json(await cfg.getModuleSettings())));
moduleConfigRouter.put(
  "/module-config/settings",
  h(async (req, res) => res.json(await cfg.updateModuleSettings(z.object({ values: z.record(z.string(), z.unknown()) }).parse(req.body).values, req.user?.profileId)))
);

moduleConfigRouter.get("/module-config/dependencies", h(async (_req, res) => res.json({ modules: await cfg.listDependencies() })));
moduleConfigRouter.put(
  "/module-config/dependencies/:code",
  h(async (req, res) => res.json({ modules: await cfg.setDependencies(code(req), z.object({ requires: z.array(z.string().min(1)).max(20) }).parse(req.body).requires) }))
);

moduleConfigRouter.get("/module-config/flags", h(async (_req, res) => res.json({ flags: await cfg.listFlags() })));
moduleConfigRouter.post("/module-config/flags", h(async (req, res) => res.status(201).json({ flag: await cfg.saveFlag(null, cfg.flagSchema.parse(req.body)) })));
moduleConfigRouter.patch(
  "/module-config/flags/:id",
  h(async (req, res) => res.json({ flag: await cfg.saveFlag(uuid(req), cfg.flagSchema.pick({ name: true, description: true, rollout_percent: true, enabled: true }).partial().strict().parse(req.body)) }))
);
moduleConfigRouter.delete("/module-config/flags/:id", h(async (req, res) => res.json(await cfg.deleteFlag(uuid(req)))));

moduleConfigRouter.get("/module-config/pricing", h(async (_req, res) => res.json(await cfg.listPricing())));
moduleConfigRouter.patch(
  "/module-config/pricing/:code",
  h(async (req, res) => res.json(await cfg.setAddonPrice(code(req), z.object({ addon_price_paise: z.number().int().min(0).max(10_000_000) }).parse(req.body).addon_price_paise)))
);
moduleConfigRouter.post("/module-config/bundles", h(async (req, res) => res.status(201).json({ bundle: await cfg.saveBundle(null, cfg.bundleSchema.parse(req.body)) })));
moduleConfigRouter.patch("/module-config/bundles/:id", h(async (req, res) => res.json({ bundle: await cfg.saveBundle(uuid(req), cfg.bundleSchema.partial().strict().parse(req.body)) })));
moduleConfigRouter.delete("/module-config/bundles/:id", h(async (req, res) => res.json(await cfg.deleteBundle(uuid(req)))));

moduleConfigRouter.get("/module-config/releases", h(async (req, res) => res.json({ releases: await cfg.listReleases(req.query) })));
moduleConfigRouter.post("/module-config/releases", h(async (req, res) => res.status(201).json({ release: await cfg.createRelease(cfg.releaseSchema.parse(req.body), req.user?.profileId) })));
moduleConfigRouter.patch(
  "/module-config/releases/:id",
  h(async (req, res) => res.json({ release: await cfg.updateRelease(uuid(req), z.object({ status: z.enum(["planned", "rolling_out", "live", "rolled_back"]), rollout_percent: z.number().int().min(0).max(100), notes: z.string().trim().min(3).max(5000) }).partial().strict().parse(req.body)) }))
);
