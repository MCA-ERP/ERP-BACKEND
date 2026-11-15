import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sendError } from "../../lib/http-error";
import * as billing from "./billing.service";
import * as pm from "./payments-mgmt.service";
import { actorName } from "../../lib/actor";

/** Platform-side billing, mounted under /api/v1/admin (access is enforced by adminAccess: area "payments"). */
export const billingRouter = Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const uuid = (req: Request, name = "id") => z.string().uuid("Invalid id.").parse(req.params[name]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD.");
const paise = z.number().int("Amounts must be whole paise.").positive("The amount must be greater than zero.");

const invoiceSchema = z.object({
  institution_id: z.string().uuid("Choose a school."),
  description: z.string().trim().min(3, "Enter a description.").max(255),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1, "Each line needs a description.").max(255),
        quantity: z.number().int().positive("Quantity must be at least 1."),
        unit_price_paise: z.number().int().min(0, "Price cannot be negative."),
      })
    )
    .min(1, "Add at least one line.")
    .max(50),
  due_on: date.optional(),
  period_start: date.nullable().optional(),
  period_end: date.nullable().optional(),
  gst_rate_percent: z.number().min(0).max(100).optional(),
});

billingRouter.get("/payments/gateway", h(async (_req, res) => res.json(billing.gatewayInfo())));
billingRouter.get("/payments/analytics", h(async (_req, res) => res.json(await billing.getAnalytics())));
billingRouter.get("/payments/transactions", h(async (req, res) => res.json(await pm.listTransactions(req.query))));
billingRouter.get("/payments/refunds", h(async (_req, res) => res.json({ refunds: await billing.listRefunds() })));

// refund requests: asked for by one person, decided by another
billingRouter.get("/payments/refund-requests", h(async (req, res) => res.json(await pm.listRefundRequests(req.query))));
billingRouter.post(
  "/payments/:id/refund-requests",
  h(async (req, res) => {
    const input = z.object({ amount_paise: paise.optional(), reason: z.string().trim().min(3, "A reason is required.").max(500) }).parse(req.body);
    res.status(201).json({ request: await pm.createRefundRequest(uuid(req), input, await actorName(req)) });
  })
);
billingRouter.post(
  "/payments/refund-requests/:id/decide",
  h(async (req, res) => {
    const b = z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }).parse(req.body);
    res.json(await pm.decideRefundRequest(uuid(req), b.approve, b.note, await actorName(req), req.user?.role));
  })
);

// gateway, accepted methods, tax and daily revenue
billingRouter.get("/payments/settings", h(async (_req, res) => res.json(await pm.getPaymentSettings())));
billingRouter.put(
  "/payments/settings",
  h(async (req, res) => res.json(await pm.updatePaymentSettings(z.object({ online_enabled: z.boolean(), manual_methods: z.array(z.string()).max(20) }).partial().strict().parse(req.body), req.user?.profileId)))
);
billingRouter.post("/payments/gateway/test", h(async (_req, res) => res.json(await pm.testGateway())));
billingRouter.get("/payments/gateway/events", h(async (_req, res) => res.json({ events: await pm.recentGatewayEvents() })));
billingRouter.get("/payments/tax-settings", h(async (_req, res) => res.json(await pm.getTaxSettings())));
billingRouter.put(
  "/payments/tax-settings",
  h(async (req, res) => res.json(await pm.updateTaxSettings(z.object({ values: z.record(z.string(), z.unknown()) }).parse(req.body).values, req.user?.profileId)))
);
billingRouter.get("/payments/tax-months", h(async (_req, res) => res.json(await pm.taxMonths())));
billingRouter.get("/payments/tax-report", h(async (req, res) => res.json(await pm.taxReport(String(req.query.month ?? "")))));
billingRouter.get("/payments/revenue/daily", h(async (req, res) => res.json(await pm.dailyRevenue(typeof req.query.month === "string" ? req.query.month : undefined))));

billingRouter.get("/payments/invoices", h(async (req, res) => res.json(await billing.listInvoices(req.query))));
billingRouter.get("/payments/invoices/suggest/:schoolId", h(async (req, res) => res.json(await billing.suggestInvoice(uuid(req, "schoolId"), typeof req.query.coupon === "string" ? req.query.coupon : undefined))));
billingRouter.post(
  "/payments/invoices",
  h(async (req, res) => res.status(201).json(await billing.createInvoice(invoiceSchema.parse(req.body), req.user?.profileId)))
);
billingRouter.get("/payments/invoices/:id", h(async (req, res) => res.json(await billing.getInvoice(uuid(req)))));
billingRouter.post(
  "/payments/invoices/:id/void",
  h(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3, "A reason is required.").max(500) }).parse(req.body);
    res.json(await billing.voidInvoice(uuid(req), reason));
  })
);
billingRouter.post(
  "/payments/invoices/:id/payments",
  h(async (req, res) => {
    const input = z
      .object({
        amount_paise: paise,
        method: z.enum(billing.METHODS),
        reference: z.string().trim().max(120).nullable().optional(),
        paid_on: date.optional(),
        notes: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body);
    res.status(201).json(await billing.recordPayment(uuid(req), input, req.user?.profileId));
  })
);
billingRouter.post(
  "/payments/:id/refund",
  h(async (req, res) => {
    const input = z
      .object({ amount_paise: paise.optional(), reason: z.string().trim().min(3, "A reason is required.").max(500) })
      .parse(req.body);
    res.json(await billing.refundPayment(uuid(req), input, req.user?.profileId));
  })
);

// ── Razorpay webhook (public; authenticated by its signature) ───────────────
export const webhookRouter = Router();

webhookRouter.post("/razorpay", async (req, res) => {
  try {
    const raw: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!raw) {
      res.status(400).json({ error: "Missing body." });
      return;
    }
    const result = await billing.handleRazorpayWebhook(
      raw,
      String(req.headers["x-razorpay-signature"] ?? ""),
      typeof req.headers["x-razorpay-event-id"] === "string" ? req.headers["x-razorpay-event-id"] : undefined
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, err, "Webhook failed");
  }
});
