import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import * as reports from "../reports/reports.service";
import * as integrations from "../integrations/integrations.service";
import * as status from "../integrations/service-status";

/** Reports and integrations. Access is enforced by adminAccess (areas "reports" and "integrations"). */
export const insightsRouter = Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const uuid = (req: Request, name = "id") => z.string().uuid("Invalid id.").parse(req.params[name]);

// ── reports ─────────────────────────────────────────────────
insightsRouter.get("/reports", h(async (_req, res) => res.json(reports.listReports())));
insightsRouter.get("/reports/overview", h(async (_req, res) => res.json(await reports.getOverview())));
insightsRouter.get("/reports/:key", h(async (req, res) => res.json(await reports.runReport(String(req.params.key), req.query))));
insightsRouter.get(
  "/reports/:key/export",
  h(async (req, res) => {
    const { filename, body } = await reports.exportReportCsv(String(req.params.key), req.query);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(body);
  })
);

// ── integrations ────────────────────────────────────────────
const events = z.array(z.enum(integrations.EVENTS)).min(1, "Choose at least one event.");

insightsRouter.get("/integrations/services", h(async (_req, res) => res.json(await integrations.listServices())));
insightsRouter.get("/integrations/meta", h(async (_req, res) => res.json({ events: integrations.EVENTS, scopes: integrations.SCOPES })));

const detail = (req: { params: Record<string, unknown> }) => z.enum(status.DETAIL_SERVICES).parse(req.params.service);
insightsRouter.get("/integrations/services/:service", h(async (req, res) => res.json(await status.serviceDetail(detail(req)))));
insightsRouter.post("/integrations/services/:service/test", h(async (req, res) => res.json(await status.testService(detail(req)))));
insightsRouter.get("/integrations/email-dns", h(async (_req, res) => res.json(await status.emailDnsChecks())));
insightsRouter.get("/integrations/deliveries", h(async (_req, res) => res.json({ deliveries: await status.allDeliveries() })));
insightsRouter.get("/integrations/api-keys", h(async (_req, res) => res.json({ keys: await integrations.listApiKeys() })));
insightsRouter.post(
  "/integrations/api-keys",
  h(async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(2, "Give the key a name.").max(120),
        scopes: z.array(z.enum(integrations.SCOPES)).min(1, "Choose at least one scope."),
      })
      .parse(req.body);
    res.status(201).json(await integrations.createApiKey(input, req.user?.profileId));
  })
);
insightsRouter.post("/integrations/api-keys/:id/revoke", h(async (req, res) => res.json({ apiKey: await integrations.revokeApiKey(uuid(req)) })));

insightsRouter.get("/integrations/webhooks", h(async (_req, res) => res.json({ webhooks: await integrations.listWebhooks() })));
insightsRouter.post(
  "/integrations/webhooks",
  h(async (req, res) => {
    const input = z
      .object({ url: z.string().trim().min(8).max(500), events, description: z.string().trim().max(200).nullable().optional() })
      .parse(req.body);
    res.status(201).json(await integrations.createWebhook(input, req.user?.profileId));
  })
);
insightsRouter.patch(
  "/integrations/webhooks/:id",
  h(async (req, res) => {
    const patch = z
      .object({ url: z.string().trim().min(8).max(500), events, description: z.string().trim().max(200).nullable(), active: z.boolean() })
      .partial()
      .parse(req.body);
    res.json({ webhook: await integrations.updateWebhook(uuid(req), patch) });
  })
);
insightsRouter.delete("/integrations/webhooks/:id", h(async (req, res) => res.json(await integrations.deleteWebhook(uuid(req)))));
insightsRouter.post("/integrations/webhooks/:id/test", h(async (req, res) => res.json(await integrations.sendTestEvent(uuid(req)))));
insightsRouter.post("/integrations/webhooks/:id/rotate-secret", h(async (req, res) => res.json(await integrations.rotateWebhookSecret(uuid(req)))));
insightsRouter.get("/integrations/webhooks/:id/deliveries", h(async (req, res) => res.json({ deliveries: await integrations.listDeliveries(uuid(req)) })));
insightsRouter.post(
  "/integrations/webhooks/:id/deliveries/:deliveryId/redeliver",
  h(async (req, res) => res.json(await integrations.redeliver(uuid(req), uuid(req, "deliveryId"))))
);
