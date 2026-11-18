import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

const str = (max = 200) => z.string().trim().max(max);
/** A web address, or a small image sent from the browser as a data address. */
const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|svg\+xml|webp|x-icon|vnd\.microsoft\.icon);base64,/;
const image = z.union([str(500).url(), z.string().max(600_000).regex(DATA_IMAGE), z.literal("")]);

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
  "branding.mark_url": image,
  "branding.favicon_url": image,
  "branding.invoice_logo_url": image,
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
  "plans.overage_policy": z.enum(["block", "grace10", "warn"]),
  "plans.storage_warn_percent": z.number().int().min(50).max(100),
  "dashboard.kpi_targets": z.record(z.string(), z.number().min(0)),
  "notify.reply_to": z.union([str(200).email(), z.literal("")]),
  "general.support_email": z.union([str(200).email(), z.literal("")]),
  "general.support_phone": str(30),
  "general.trial_days": z.number().int().min(0).max(90),
  "general.gst_number": str(20),
  "branding.logo_url": image,
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
  "billing.cycles_enabled": z.array(z.enum(["annual", "half_yearly", "instalments", "monthly"])).min(1),
  "billing.renewal_invoice_days": z.number().int().min(0).max(120),
  "billing.billed_by": str(150),
  "billing.bank_details": str(500),
  "billing.email_invoices": z.boolean(),
  "billing.attach_pdf": z.boolean(),
  "billing.include_gstin": z.boolean(),
  "billing.prices_include_gst": z.boolean(),
  "billing.split_gst": z.boolean(),
  "billing.allow_tds": z.boolean(),
  "billing.round_tax": z.boolean(),
  "trial.runs_on": z.enum(["chosen", "lowest", "highest"]),
  "trial.student_limit": z.number().int().min(1).max(100000),
  "trial.max_extension_days": z.number().int().min(0).max(60),
  "trial.require_payment_details": z.boolean(),
  "trial.auto_convert": z.boolean(),
  "trial.reminder_emails": z.boolean(),
  "modules.allow_addons": z.boolean(),
  "payments.online_enabled": z.boolean(),
  "payments.manual_methods": z.array(z.string()).min(1).max(20),
  "billing.supplier_state": str(60),
  "billing.sac_code": str(20),
  "modules.show_locked": z.boolean(),
  "modules.admins_toggle": z.boolean(),
  "modules.confirm_addon": z.boolean(),
  "modules.hide_unused": z.boolean(),
  "modules.default_for_new": z.enum(["off", "on"]),
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
  "general.app_store_name": str(60),
  "regional.states": z.array(str(60)).max(100),
  "locale.schools_own_timezone": z.boolean(),
  "locale.show_viewer_timezone": z.boolean(),
  "security.password_expiry_days": z.number().int().min(0).max(365),
  "security.password_history": z.number().int().min(0).max(24),
  "security.require_2fa_principals": z.boolean(),
  "security.mfa_methods": z.enum(["app_or_sms", "sms", "email"]),
  "security.session_timeout_school_minutes": z.number().int().min(15).max(10080),
  "security.session_timeout_app_days": z.number().int().min(1).max(365),
  "security.logout_on_browser_close": z.boolean(),
  "files.max_document_mb": z.number().int().min(1).max(500),
  "files.max_image_mb": z.number().int().min(1).max(100),
  "files.max_video_mb": z.number().int().min(1).max(5000),
  "files.allowed_types": str(300),
  "files.scan_viruses": z.boolean(),
  "files.compress_photos": z.boolean(),
  "files.storage": str(60),
  "files.delivery": str(60),
  "files.cold_storage": z.boolean(),
  "maintenance.parent_read_only": z.boolean(),
  "app.support_impersonation": z.boolean(),
  "app.beta_menu": z.boolean(),
  "app.rate_limit_per_minute": z.number().int().min(10).max(10000),
  "app.debug_logging": z.boolean(),
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
