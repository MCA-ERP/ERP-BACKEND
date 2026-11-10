import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { actorName } from "../../lib/actor";
import * as support from "./support.service";
import * as sm from "./support-mgmt.service";
import * as comms from "./communication.service";
import * as cms from "./cms.service";
import * as settings from "./settings.service";
import * as security from "./security.service";
import * as secMgmt from "./security-mgmt.service";
import * as system from "./system.service";
import { sessionIdOf } from "../../lib/sessions";
import * as messaging from "../messaging/messaging.service";

/** Support, communication, website content, settings and security. Access is enforced by adminAccess. */
export const opsRouter = Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const uuid = (req: Request) => z.string().uuid("Invalid id.").parse(req.params.id);

// ── support ─────────────────────────────────────────────────
opsRouter.get("/support/tickets", h(async (req, res) => {
  const r = await support.listTickets(req.query);
  res.json({ ...r, items: await sm.decorateSla(r.items as any[]) });
}));
opsRouter.get("/support/agents", h(async (_req, res) => res.json({ agents: await support.listAgents() })));
opsRouter.get("/support/workload", h(async (_req, res) => res.json(await sm.workload())));
opsRouter.get("/support/tickets/:id", h(async (req, res) => {
  const r = await support.getTicket(uuid(req));
  const [withSla] = await sm.decorateSla([r.ticket as any]);
  res.json({ ...r, ticket: withSla, escalations: await sm.ticketEscalations(uuid(req)) });
}));

// categories, assignment, targets and escalations
opsRouter.get("/support/categories", h(async (_req, res) => res.json({ categories: await sm.listCategories() })));
opsRouter.post("/support/categories", h(async (req, res) => res.status(201).json({ category: await sm.saveCategory(null, sm.categorySchema.parse(req.body)) })));
opsRouter.patch("/support/categories/:id", h(async (req, res) => res.json({ category: await sm.saveCategory(uuid(req), sm.categorySchema.partial().strict().parse(req.body)) })));
opsRouter.post(
  "/support/assign",
  h(async (req, res) => {
    const b = z.object({ ticket_ids: z.array(z.string().uuid()).min(1).max(200), agent_id: z.string().uuid() }).parse(req.body);
    res.json(await sm.assignTickets(b.ticket_ids, b.agent_id, await actorName(req)));
  })
);
opsRouter.post(
  "/support/reassign",
  h(async (req, res) => {
    const b = z.object({ from_agent_id: z.string().uuid(), to_agent_id: z.string().uuid(), ticket_ids: z.array(z.string().uuid()).max(200).optional() }).parse(req.body);
    res.json(await sm.reassignTickets(b.from_agent_id, b.to_agent_id, b.ticket_ids, await actorName(req)));
  })
);
opsRouter.get("/support/sla", h(async (_req, res) => res.json({ policies: await sm.getSla() })));
opsRouter.put(
  "/support/sla/:priority",
  h(async (req, res) => {
    const b = z.object({ first_response_hours: z.number().int().min(1).max(720), resolution_hours: z.number().int().min(1).max(2160) }).parse(req.body);
    res.json({ policies: await sm.setSla(String(req.params.priority), b.first_response_hours, b.resolution_hours) });
  })
);
opsRouter.post(
  "/support/tickets/:id/escalate",
  h(async (req, res) => res.json(await sm.escalateTicket(uuid(req), z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body).note, await actorName(req))))
);
opsRouter.get("/support/escalations", h(async (req, res) => res.json(await sm.listEscalations(req.query))));

// help centre, feedback and feature requests
opsRouter.get("/support/kb", h(async (req, res) => res.json({ items: await sm.listKb(req.query) })));
opsRouter.post("/support/kb", h(async (req, res) => res.status(201).json({ item: await sm.saveKb(null, sm.kbSchema.parse(req.body), await actorName(req)) })));
opsRouter.patch("/support/kb/:id", h(async (req, res) => res.json({ item: await sm.saveKb(uuid(req), sm.kbSchema.partial().strict().parse(req.body), await actorName(req)) })));
opsRouter.delete("/support/kb/:id", h(async (req, res) => res.json(await sm.deleteKb(uuid(req)))));
opsRouter.get("/support/feedback", h(async (req, res) => res.json(await sm.listFeedback(req.query))));
opsRouter.get("/support/features", h(async (_req, res) => res.json({ items: await sm.listFeatures() })));
opsRouter.patch(
  "/support/features/:id",
  h(async (req, res) => res.json(await sm.updateFeature(uuid(req), z.object({ status: z.enum(sm.FEATURE_STATUSES), response: z.string().trim().max(1000).nullable() }).partial().strict().parse(req.body))))
);
opsRouter.patch(
  "/support/tickets/:id",
  h(async (req, res) => {
    const patch = z
      .object({
        status: z.enum(support.STATUSES),
        priority: z.enum(support.PRIORITIES),
        assigned_to: z.string().uuid().nullable(),
      })
      .partial()
      .parse(req.body);
    res.json(await support.updateTicket(uuid(req), patch));
  })
);
opsRouter.post(
  "/support/tickets/:id/messages",
  h(async (req, res) => {
    const { body, internal } = z.object({ body: z.string().trim().min(1, "Write a message.").max(5000), internal: z.boolean().optional() }).parse(req.body);
    res.status(201).json(await support.addStaffMessage(uuid(req), await actorName(req), body, internal ?? false));
  })
);

// ── communication ───────────────────────────────────────────
const audience = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("plans"), plans: z.array(z.string().min(1)).min(1, "Choose at least one plan.") }),
  z.object({ type: z.literal("schools"), school_ids: z.array(z.string().uuid()).min(1, "Choose at least one school.") }),
  z.object({ type: z.literal("segment"), segment: z.enum(comms.SEGMENTS) }),
]);
const announcementBase = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(255),
  body: z.string().trim().min(1, "Write the announcement.").max(5000),
  audience,
  channels: z.array(z.enum(comms.CHANNELS)).min(1, "Choose a channel."),
  kind: z.enum(comms.KINDS).optional(),
  scheduled_for: z.string().datetime({ offset: true }).nullable().optional(),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
});

opsRouter.get("/communication/announcements", h(async (_req, res) => res.json({ announcements: await comms.listAnnouncements() })));
opsRouter.post(
  "/communication/announcements",
  h(async (req, res) => res.status(201).json({ announcement: await comms.createAnnouncement(announcementBase.parse(req.body), req.user?.profileId) }))
);
opsRouter.patch(
  "/communication/announcements/:id",
  h(async (req, res) => res.json({ announcement: await comms.updateAnnouncement(uuid(req), announcementBase.partial().parse(req.body)) }))
);
opsRouter.get("/communication/history", h(async (req, res) => res.json(await comms.listHistory(req.query))));
opsRouter.get("/communication/campaigns", h(async (_req, res) => res.json({ campaigns: await comms.listCampaigns() })));
opsRouter.post("/communication/announcements/:id/unschedule", h(async (req, res) => res.json({ announcement: await comms.unscheduleAnnouncement(uuid(req)) })));
opsRouter.post("/communication/announcements/:id/end", h(async (req, res) => res.json({ announcement: await comms.endAnnouncement(uuid(req)) })));
opsRouter.delete("/communication/announcements/:id", h(async (req, res) => res.json(await comms.deleteAnnouncement(uuid(req)))));
// "send" is a create-type action on the announcement
opsRouter.post("/communication/announcements/:id/send", h(async (req, res) => res.json(await comms.sendAnnouncement(uuid(req), req.user?.profileId))));

opsRouter.get("/communication/templates", h(async (_req, res) => res.json({ templates: await comms.listTemplates() })));
opsRouter.post(
  "/communication/templates",
  h(async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(150),
        channel: z.enum(comms.CHANNELS),
        subject: z.string().trim().max(255).nullable().optional(),
        body: z.string().trim().min(1).max(5000),
        provider_template_id: z.string().trim().max(80).nullable().optional(),
      })
      .parse(req.body);
    res.status(201).json({ template: await comms.saveTemplate(input) });
  })
);
opsRouter.patch(
  "/communication/templates/:id",
  h(async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(150),
        channel: z.enum(comms.CHANNELS),
        subject: z.string().trim().max(255).nullable().optional(),
        body: z.string().trim().min(1).max(5000),
        provider_template_id: z.string().trim().max(80).nullable().optional(),
      })
      .parse(req.body);
    res.json({ template: await comms.saveTemplate({ ...input, id: uuid(req) }) });
  })
);
opsRouter.patch(
  "/communication/templates/:id/active",
  h(async (req, res) => res.json({ template: await comms.setTemplateActive(uuid(req), z.object({ is_active: z.boolean() }).parse(req.body).is_active) }))
);
opsRouter.delete("/communication/templates/:id", h(async (req, res) => res.json(await comms.deleteTemplate(uuid(req)))));

// delivery log, retry and test sends
opsRouter.get("/communication/messages", h(async (req, res) => res.json(await messaging.listMessages(req.query))));
opsRouter.post(
  "/communication/messages/retry",
  h(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).parse(req.body ?? {});
    res.json(await messaging.retryFailed(ids));
  })
);
opsRouter.post(
  "/communication/messages/cancel",
  h(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(500).optional() }).parse(req.body ?? {});
    res.json(await messaging.cancelQueued(ids));
  })
);
opsRouter.post("/communication/messages/:id/resend", h(async (req, res) => res.json(await messaging.resendMessage(uuid(req)))));
opsRouter.post(
  "/communication/test",
  h(async (req, res) => {
    const input = z
      .object({ channel: z.enum(["email", "sms", "whatsapp"]), to: z.string().trim().min(5).max(200), templateKey: z.string().trim().max(60).optional() })
      .parse(req.body);
    res.json({ message: await messaging.sendTest(input, req.user?.profileId), providers: messaging.messagingStatus() });
  })
);

// ── website content ─────────────────────────────────────────
const cmsFields = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(255),
  slug: z.string().trim().max(150).optional(),
  body: z.string().max(100_000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
  starts_at: z.string().datetime({ offset: true }).nullable().optional(),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
});
const cmsType = (req: Request) => z.enum(cms.CMS_TYPES).parse(req.params.type);

// the addresses search engines crawl, and where the live sitemap is served
opsRouter.get("/cms/sitemap", h(async (_req, res) => res.json({ urls: await cms.sitemapUrls(), site_url: await settings.getSetting<string>("website.site_url", ""), include_blog: await settings.getSetting<boolean>("website.sitemap_include_blog", true) })));
opsRouter.put(
  "/cms/sitemap",
  h(async (req, res) => {
    const v = z.object({ site_url: z.string().trim().max(300).optional(), include_blog: z.boolean().optional() }).parse(req.body);
    const values: Record<string, unknown> = {};
    if (v.site_url !== undefined) values["website.site_url"] = v.site_url.replace(/\/$/, "");
    if (v.include_blog !== undefined) values["website.sitemap_include_blog"] = v.include_blog;
    await settings.updateSettings(values, req.user?.profileId);
    res.json({ urls: await cms.sitemapUrls(), site_url: await settings.getSetting<string>("website.site_url", ""), include_blog: await settings.getSetting<boolean>("website.sitemap_include_blog", true) });
  })
);
opsRouter.get("/cms/:type", h(async (req, res) => res.json({ items: await cms.listItems(cmsType(req)) })));
opsRouter.post(
  "/cms/:type",
  h(async (req, res) => res.status(201).json({ item: await cms.createItem({ ...cmsFields.parse(req.body), type: cmsType(req) }, req.user?.profileId) }))
);
opsRouter.patch("/cms/items/:id", h(async (req, res) => res.json({ item: await cms.updateItem(uuid(req), cmsFields.partial().parse(req.body)) })));
opsRouter.delete("/cms/items/:id", h(async (req, res) => res.json(await cms.deleteItem(uuid(req)))));

// ── settings ────────────────────────────────────────────────
opsRouter.get("/settings", h(async (_req, res) => res.json({ settings: await settings.getSettings() })));
opsRouter.put(
  "/settings",
  h(async (req, res) => {
    const { values } = z.object({ values: z.record(z.string(), z.unknown()) }).parse(req.body);
    res.json({ settings: await settings.updateSettings(values, req.user?.profileId) });
  })
);

// ── security ────────────────────────────────────────────────
opsRouter.get(
  "/ip-allowlist",
  h(async (req, res) => res.json({ entries: await security.listAllowlist(), yourIp: security.clientIp(req) }))
);
opsRouter.post(
  "/ip-allowlist",
  h(async (req, res) => {
    const { cidr, label } = z.object({ cidr: z.string().trim().min(1, "Enter an address."), label: z.string().trim().max(150).optional() }).parse(req.body);
    res.status(201).json({ entry: await security.addAllowlist(cidr, label || null, security.clientIp(req), req.user?.profileId) });
  })
);
opsRouter.delete("/ip-allowlist/:id", h(async (req, res) => res.json(await security.removeAllowlist(uuid(req), security.clientIp(req)))));
// system information and release history
opsRouter.get("/system/info", h(async (_req, res) => res.json(await system.systemInfo())));
opsRouter.get("/system/releases", h(async (_req, res) => res.json({ releases: await system.listReleases() })));
opsRouter.post(
  "/system/releases",
  h(async (req, res) => {
    const input = z.object({ version: z.string().trim().min(5).max(30), released_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), notes: z.string().max(2000).optional() }).parse(req.body);
    res.status(201).json({ release: await system.addRelease(input, req.user?.profileId) });
  })
);
opsRouter.delete("/system/releases/:id", h(async (req, res) => res.json(await system.deleteRelease(uuid(req)))));

opsRouter.get("/ip-blocklist", h(async (_req, res) => res.json({ entries: await security.listBlocklist() })));
opsRouter.post(
  "/ip-blocklist",
  h(async (req, res) => {
    const { cidr, reason } = z.object({ cidr: z.string().trim().min(3).max(50), reason: z.string().trim().max(200).optional() }).parse(req.body);
    res.status(201).json({ entry: await security.addBlock(cidr, reason || null, security.clientIp(req), req.user?.profileId) });
  })
);
opsRouter.delete("/ip-blocklist/:id", h(async (req, res) => res.json(await security.removeBlock(uuid(req)))));

// alerts, incidents, devices, data changes, retention
opsRouter.get("/security/alerts", h(async (_req, res) => res.json({ alerts: await secMgmt.listAlerts() })));
opsRouter.get("/security/incidents", h(async (_req, res) => res.json({ incidents: await secMgmt.listIncidents() })));
opsRouter.post(
  "/security/incidents",
  h(async (req, res) => {
    const input = z.object({ title: z.string().trim().min(3, "Describe what happened.").max(200), severity: z.enum(secMgmt.SEVERITIES), notes: z.string().max(5000).optional() }).parse(req.body);
    res.status(201).json({ incident: await secMgmt.createIncident(input, req.user?.profileId) });
  })
);
opsRouter.patch(
  "/security/incidents/:id",
  h(async (req, res) => {
    const input = z.object({ title: z.string().trim().min(3).max(200).optional(), severity: z.enum(secMgmt.SEVERITIES).optional(), status: z.enum(secMgmt.INCIDENT_STATUSES).optional(), notes: z.string().max(5000).optional() }).parse(req.body);
    res.json({ incident: await secMgmt.updateIncident(uuid(req), input) });
  })
);
opsRouter.get("/security/devices", h(async (_req, res) => res.json({ devices: await secMgmt.listDevices() })));
opsRouter.delete("/security/devices/:id", h(async (req, res) => res.json(await secMgmt.removeDevice(uuid(req)))));
opsRouter.post(
  "/security/sessions/end-others",
  h(async (req, res) => {
    const token = (req.headers.authorization || "").replace(/^Bearers+/i, "");
    res.json(await secMgmt.endOtherSessionsOfEveryone(sessionIdOf(token), req.user?.profileId));
  })
);
opsRouter.get("/security/data-changes", h(async (req, res) => res.json(await secMgmt.listDataChanges(req.query))));
opsRouter.get("/security/mfa", h(async (_req, res) => res.json(await secMgmt.staffMfaStatus())));
opsRouter.get("/security/retention", h(async (_req, res) => res.json(await secMgmt.retentionStatus())));
opsRouter.put(
  "/security/retention",
  h(async (req, res) => {
    const v = z.object({ login_events_days: z.number().int().optional(), audit_logs_days: z.number().int().optional() }).parse(req.body);
    const values: Record<string, unknown> = {};
    if (v.login_events_days !== undefined) values["retention.login_events_days"] = v.login_events_days;
    if (v.audit_logs_days !== undefined) values["retention.audit_logs_days"] = v.audit_logs_days;
    await settings.updateSettings(values, req.user?.profileId);
    res.json(await secMgmt.retentionStatus());
  })
);
opsRouter.get("/backups", h(async (_req, res) => res.json(await security.getBackupInfo())));
