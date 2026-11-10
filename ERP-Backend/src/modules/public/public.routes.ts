import { Router } from "express";
import { maintenanceFrom } from "../../lib/maintenance";
import { supabaseAdmin } from "../../../db/client";
import { z } from "zod";
import { sendError } from "../../lib/http-error";
import { PUBLIC_TYPES, listPublished, sitemapFor } from "../admin/cms.service";
import { getSetting, getSettings } from "../admin/settings.service";
import { applicationSchema, createApplication } from "../admin/school-mgmt.service";
import { applicationLimiter } from "../../middleware/security";

/** Unauthenticated, read-only data for the public marketing website. Only published content is exposed. */
export const publicRouter = Router();

publicRouter.get("/cms/:type", async (req, res) => {
  try {
    const type = z.enum(PUBLIC_TYPES).parse(req.params.type);
    res.set("Cache-Control", "public, max-age=60");
    res.json({ items: await listPublished(type) });
  } catch (err) {
    sendError(res, err, "Failed to load content");
  }
});

// The sitemap search engines read. The site address comes from Settings -> Website.
publicRouter.get("/sitemap.xml", async (_req, res) => {
  try {
    const base = (await getSetting<string>("website.site_url", "")).trim();
    if (!base) return void res.status(404).type("text/plain").send("Set the website address first (Website -> SEO -> Sitemap).");
    res.set({ "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" }).send(await sitemapFor(base));
  } catch (err) {
    sendError(res, err, "Failed to build the sitemap");
  }
});

// A one-pixel image inside announcement emails: loading it records that the email was opened.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
publicRouter.get("/t/:id.gif", async (req, res) => {
  const id = String(req.params.id);
  if (/^[0-9a-f-]{36}$/i.test(id)) {
    try {
      const row = (await supabaseAdmin.from("message_log").select("open_count, opened_at").eq("id", id).eq("channel", "email").maybeSingle()).data as { open_count: number; opened_at: string | null } | null;
      if (row) await supabaseAdmin.from("message_log").update({ open_count: row.open_count + 1, opened_at: row.opened_at ?? new Date().toISOString() }).eq("id", id);
    } catch { /* never fail an image */ }
  }
  res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0" }).send(PIXEL);
});

publicRouter.get("/branding", async (_req, res) => {
  try {
    const s = await getSettings();
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      platform_name: s["general.platform_name"],
      support_email: s["general.support_email"],
      support_phone: s["general.support_phone"],
      logo_url: s["branding.logo_url"],
      mark_url: s["branding.mark_url"],
      favicon_url: s["branding.favicon_url"],
      invoice_logo_url: s["branding.invoice_logo_url"],
      primary_color: s["branding.primary_color"],
      short_name: s["general.short_name"],
      tagline: s["general.tagline"],
      company: s["general.company"],
      domain: s["general.main_domain"],
      whatsapp: s["contact.whatsapp"],
      support_hours: s["contact.hours"],
      sales_email: s["contact.sales_email"],
      address: s["contact.address"],
      countries: s["regional.countries"],
      self_signup: s["app.self_signup"] !== false,
      locale: {
        time_zone: s["locale.timezone"], currency: s["locale.currency"], date_format: s["locale.date_format"], week_start: s["locale.week_start"],
        financial_year: s["locale.financial_year"], time_format: s["locale.time_format"], show_seconds: s["locale.show_seconds"] === true,
      },
      maintenance: maintenanceFrom(s),
    });
  } catch (err) {
    sendError(res, err, "Failed to load branding");
  }
});

/** A school asks to join from the website. Rate limited; lands in Schools → Applications. */
publicRouter.post("/applications", applicationLimiter, async (req, res) => {
  try {
    const input = applicationSchema.parse(req.body);
    // demo requests are leads and always welcome; registering a school waits for the switch
    if (req.body?.source !== "demo" && (await getSetting<boolean>("app.self_signup", true)) === false) {
      return void res.status(403).json({ error: "We are not taking new school sign-ups through the website right now. Please contact us and we will help." });
    }
    await createApplication({ ...input, source: req.body?.source === "demo" ? "demo" : "website" });
    res.status(201).json({ success: true });
  } catch (err) {
    sendError(res, err, "Could not send your application");
  }
});
