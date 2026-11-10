import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { actorName } from "../../lib/actor";
import * as subs from "./subscriptions.service";

/** Plans, subscriptions, renewals, trials and discounts. Access is enforced by adminAccess. */
export const subscriptionsRouter = Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const id = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);
const cycle = z.enum(["annual", "quarterly"]);

// ── plans ──
subscriptionsRouter.get("/subscriptions/plans", h(async (_req, res) => res.json({ plans: await subs.listPlansFull() })));
subscriptionsRouter.post(
  "/subscriptions/plans",
  h(async (req, res) => {
    const input = subs.planFields.extend({ code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{2,30}$/, "Use 2-30 lowercase letters, digits, - or _.") }).parse(req.body);
    res.status(201).json({ plan: await subs.createPlan(input, await actorName(req)) });
  })
);
subscriptionsRouter.patch("/subscriptions/plans/:id", h(async (req, res) => res.json({ plan: await subs.updatePlan(id(req), subs.planFields.partial().strict().parse(req.body)) })));
subscriptionsRouter.patch(
  "/subscriptions/plans/:id/active",
  h(async (req, res) => res.json({ plan: await subs.setPlanActive(id(req), z.object({ is_active: z.boolean() }).parse(req.body).is_active) }))
);

// ── subscriptions ──
subscriptionsRouter.get("/subscriptions", h(async (req, res) => res.json(await subs.listSubscriptions(req.query))));
subscriptionsRouter.get("/subscriptions/schools/:id", h(async (req, res) => res.json(await subs.getSchoolSubscription(id(req)))));
subscriptionsRouter.patch(
  "/subscriptions/schools/:id/cycle",
  h(async (req, res) => res.json(await subs.setCycle(id(req), cycle.parse(req.body?.cycle), await actorName(req))))
);
subscriptionsRouter.post(
  "/subscriptions/schools/:id/cancel",
  h(async (req, res) => res.json(await subs.cancelSubscription(id(req), z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body).reason, await actorName(req))))
);
subscriptionsRouter.post("/subscriptions/schools/:id/reinstate", h(async (req, res) => res.json(await subs.reinstateSubscription(id(req), await actorName(req)))));
subscriptionsRouter.post(
  "/subscriptions/schools/:id/extend-trial",
  h(async (req, res) => res.json(await subs.extendTrial(id(req), z.object({ days: z.number().int().min(1).max(60) }).parse(req.body).days, await actorName(req))))
);
subscriptionsRouter.post(
  "/subscriptions/schools/:id/change-plan",
  h(async (req, res) => res.json(await subs.changePlanChecked(id(req), z.object({ plan_code: z.string().trim().min(1) }).parse(req.body).plan_code, await actorName(req))))
);

// ── renewals ──
subscriptionsRouter.get("/subscriptions/renewals/upcoming", h(async (req, res) => res.json({ renewals: await subs.upcomingRenewals(Number(req.query.days) || 90) })));
subscriptionsRouter.get("/subscriptions/renewals/history", h(async (req, res) => res.json(await subs.renewalHistory(req.query))));
const renewBody = z.object({ coupon_code: z.string().trim().max(40).optional(), cycle: cycle.optional() });
subscriptionsRouter.post(
  "/subscriptions/schools/:id/renewal-preview",
  h(async (req, res) => {
    const b = renewBody.parse(req.body ?? {});
    res.json(await subs.renewalPreview(id(req), b.coupon_code, b.cycle));
  })
);
subscriptionsRouter.post(
  "/subscriptions/schools/:id/renew",
  h(async (req, res) => {
    const b = renewBody.parse(req.body ?? {});
    res.status(201).json(await subs.issueRenewal(id(req), { couponCode: b.coupon_code, cycle: b.cycle }, await actorName(req)));
  })
);

// ── plan change requests ──
subscriptionsRouter.get("/subscriptions/requests", h(async (req, res) => res.json(await subs.listRequests(req.query))));
subscriptionsRouter.post(
  "/subscriptions/requests/:id/decide",
  h(async (req, res) => {
    const b = z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }).parse(req.body);
    res.json(await subs.decideRequest(id(req), b.approve, b.note, await actorName(req)));
  })
);

// ── trials ──
subscriptionsRouter.get("/subscriptions/trials", h(async (_req, res) => res.json(await subs.trialOverview())));

// ── discounts ──
subscriptionsRouter.get("/subscriptions/coupons", h(async (_req, res) => res.json({ coupons: await subs.listCoupons() })));
subscriptionsRouter.post("/subscriptions/coupons", h(async (req, res) => res.status(201).json({ coupon: await subs.saveCoupon(null, subs.couponSchema.parse(req.body)) })));
subscriptionsRouter.patch("/subscriptions/coupons/:id", h(async (req, res) => res.json({ coupon: await subs.saveCoupon(id(req), z.object({ description: z.string().trim().max(255).nullable(), plan_codes: z.array(z.string().trim().min(1).max(30)).max(20), max_redemptions: z.number().int().min(1).nullable(), valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), is_active: z.boolean() }).partial().strict().parse(req.body)) })));
subscriptionsRouter.delete("/subscriptions/coupons/:id", h(async (req, res) => res.json(await subs.deleteCoupon(id(req)))));

subscriptionsRouter.get("/subscriptions/offers", h(async (_req, res) => res.json({ offers: await subs.listOffers() })));
subscriptionsRouter.post("/subscriptions/offers", h(async (req, res) => res.status(201).json({ offer: await subs.saveOffer(null, subs.offerSchema.parse(req.body)) })));
subscriptionsRouter.patch("/subscriptions/offers/:id", h(async (req, res) => res.json({ offer: await subs.saveOffer(id(req), z.object({ name: z.string().trim().min(2).max(120), percent_off: z.number().int().min(1).max(100), plan_codes: z.array(z.string().trim().min(1).max(30)).max(20), min_students: z.number().int().min(1).nullable(), valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), is_active: z.boolean() }).partial().strict().parse(req.body)) })));
subscriptionsRouter.delete("/subscriptions/offers/:id", h(async (req, res) => res.json(await subs.deleteOffer(id(req)))));

subscriptionsRouter.get("/subscriptions/special-pricing", h(async (_req, res) => res.json({ items: await subs.listSpecialPricing() })));
subscriptionsRouter.post("/subscriptions/special-pricing", h(async (req, res) => res.status(201).json({ item: await subs.addSpecialPricing(subs.specialSchema.parse(req.body), await actorName(req)) })));
subscriptionsRouter.delete("/subscriptions/special-pricing/:id", h(async (req, res) => res.json(await subs.endSpecialPricing(id(req), await actorName(req)))));

// ── billing settings ──
subscriptionsRouter.get("/subscriptions/billing-settings", h(async (_req, res) => res.json(await subs.getBillingSettings())));
subscriptionsRouter.put(
  "/subscriptions/billing-settings",
  h(async (req, res) => res.json(await subs.updateBillingSettings(z.object({ values: z.record(z.string(), z.unknown()) }).parse(req.body).values, req.user?.profileId)))
);
