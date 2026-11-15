import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

const str = (max = 200) => z.string().trim().max(max);

/** Every setting the platform understands, with its validator. Unknown keys are rejected. */
export const SETTING_SCHEMAS: Record<string, z.ZodTypeAny> = {
  "general.platform_name": str(100).min(1),
  "general.short_name": str(20),
  "general.tagline": str(150),
  "general.company": str(150),
  "general.main_domain": str(150),
  "contact.whatsapp": str(30),
  "contact.hours": str(100),
  "contact.sales_email": z.union([str(200).email(), z.literal("")]),
  "contact.address": str(400),
  "branding.mark_url": z.union([str(500).url(), z.literal("")]),
  "branding.favicon_url": z.union([str(500).url(), z.literal("")]),
  "branding.invoice_logo_url": z.union([str(500).url(), z.literal("")]),
  "regional.countries": z.array(z.enum(["IN", "AE", "NP", "LK", "BD"])).min(1, "Keep at least one country."),
  "locale.week_start": z.enum(["Monday", "Sunday"]),
  "locale.financial_year": z.enum(["April - March", "January - December"]),
  "locale.time_format": z.enum(["12h", "24h"]),
  "locale.show_seconds": z.boolean(),
  "maintenance.enabled": z.boolean(),
  "maintenance.message": str(500).min(1, "Write the message schools will see."),
  "maintenance.starts_at": z.union([z.string().datetime({ offset: true }), z.literal("")]),
  "maintenance.ends_at": z.union([z.string().datetime({ offset: true }), z.literal("")]),
  "app.self_signup": z.boolean(),
  "notify.reply_to": z.union([str(200).email(), z.literal("")]),
  "general.support_email": z.union([str(200).email(), z.literal("")]),
  "general.support_phone": str(30),
  "general.trial_days": z.number().int().min(0).max(90),
  "general.gst_number": str(20),
  "branding.logo_url": z.union([str(500).url(), z.literal("")]),
  "branding.primary_color": str(9).regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #0294CE."),
  "locale.timezone": str(60).min(1),
  "locale.currency": str(3).length(3),
  "locale.date_format": str(30).min(1),
  "notify.email_from_name": str(100),
  "notify.email_from_address": z.union([str(200).email(), z.literal("")]),
  "notify.sms_sender_id": str(11),
  "communication.track_email_opens": z.boolean(),
  "website.site_url": z.union([str(300).url(), z.literal("")]),
  "website.sitemap_include_blog": z.boolean(),
  "billing.gst_rate_percent": z.number().min(0).max(100),
  "billing.payment_terms_days": z.number().int().min(0).max(120),
  "billing.grace_days": z.number().int().min(0).max(90),
  "billing.default_cycle": z.enum(["annual", "quarterly"]),
  "billing.invoice_footer": str(500),
  "modules.allow_addons": z.boolean(),
  "payments.online_enabled": z.boolean(),
  "payments.manual_methods": z.array(z.string()).min(1).max(20),
  "billing.supplier_state": str(60),
  "billing.sac_code": str(20),
  "modules.show_locked": z.boolean(),
  "security.min_password_length": z.number().int().min(8).max(64),
  "security.session_timeout_minutes": z.number().int().min(15).max(10080),
  "security.require_2fa_staff": z.boolean(),
  "security.require_2fa_school_admins": z.boolean(),
  "security.password_require_number": z.boolean(),
  "security.password_require_symbol": z.boolean(),
  "security.password_block_common": z.boolean(),
  "security.remember_device_days": z.number().int().min(0).max(90),
  "security.single_session_staff": z.boolean(),
  "retention.login_events_days": z.number().int().min(30).max(3650),
  "retention.audit_logs_days": z.number().int().min(180).max(3650),
  "security.max_failed_logins": z.number().int().min(3).max(20),
  "security.lockout_minutes": z.number().int().min(1).max(1440),
  "accounts.student_login_domain": z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a domain like students.myschool.in."),
  "accounts.parent_login_domain": z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a domain like parents.myschool.in."),
};

const TTL_MS = 30_000;
let cache: { at: number; values: Record<string, unknown> } | null = null;

export async function getSettings(): Promise<Record<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const rows = check(await supabaseAdmin.from("platform_settings").select("key, value")) as { key: string; value: unknown }[];
  const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = { at: Date.now(), values };
  return values;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const v = (await getSettings())[key];
  return (v === undefined ? fallback : v) as T;
}

export async function updateSettings(values: Record<string, unknown>, actorProfileId?: string) {
  const rows = Object.entries(values).map(([key, raw]) => {
    const schema = SETTING_SCHEMAS[key];
    if (!schema) throw new HttpError(400, `Unknown setting '${key}'.`);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, `${key}: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
    return { key, value: parsed.data, updated_by: actorProfileId ?? null, updated_at: new Date().toISOString() };
  });
  if (!rows.length) return getSettings();
  if (values["security.require_2fa_staff"] === true || values["security.require_2fa_school_admins"] === true) {
    const { deliveryAvailable } = await import("../auth/otp");
    const d = await deliveryAvailable();
    if (!d.ok) throw new HttpError(400, "Sign-in codes cannot be delivered yet. Set up SMS (with the Sign-in code template id) or email first, otherwise nobody could sign in.");
  }

  check(await supabaseAdmin.from("platform_settings").upsert(rows, { onConflict: "key" }).select("key"));
  cache = null;
  return getSettings();
}
