import crypto from "crypto";
import { supabaseAdmin, testDbConnection } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { assertPublicUrl } from "../../lib/net-guard";
import { razorpayConfigured } from "../../lib/razorpay";
import { emailConfigured } from "../../lib/mailer";
import { smsConfigured } from "../../lib/sms";
import { whatsappConfigured } from "../../lib/whatsapp";
import { EVENTS, deliver, makeEnvelope, type Hook } from "./events";

export const SCOPES = ["schools:read", "invoices:read"] as const;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ─────────────────────────────────────────────
//  Connected services
// ─────────────────────────────────────────────
type Status = "Connected" | "Not configured" | "Planned";
interface Service {
  group: string;
  key: string;
  name: string;
  description: string;
  status: Status;
  link?: string;
}

export async function listServices() {
  const db = await testDbConnection();
  const planned = (group: string, key: string, name: string, description: string): Service => ({ group, key, name, description, status: "Planned" });

  const services: Service[] = [
    { group: "Payments", key: "razorpay", name: "Razorpay", description: "Online fee and subscription payments", status: razorpayConfigured() ? "Connected" : "Not configured", link: "/admin/payments" },
    { group: "Core", key: "supabase", name: "Supabase", description: "Database, sign-in and file storage", status: db.ok ? "Connected" : "Not configured" },
    { group: "Messaging", key: "sms", name: "SMS (MSG91)", description: "Reminders and announcements with DLT-approved templates", status: smsConfigured() ? "Connected" : "Not configured", link: "/admin/integrations" },
    { group: "Messaging", key: "whatsapp", name: "WhatsApp Business", description: "Template messages through Meta's WhatsApp Business Cloud API", status: whatsappConfigured() ? "Connected" : "Not configured", link: "/admin/communication" },
    { group: "Messaging", key: "email", name: "Email (SMTP)", description: "Invoices, reminders and announcements through any SMTP provider", status: emailConfigured() ? "Connected" : "Not configured", link: "/admin/settings" },
    planned("Learning & productivity", "google", "Google Workspace", "Sign in with Google, Classroom sync"),
    planned("Learning & productivity", "zoom", "Zoom", "Live online classes"),
    planned("Learning & productivity", "microsoft", "Microsoft 365", "Teams classes, Outlook sign-in"),
    planned("Accounts & compliance", "tally", "Tally Prime", "Export invoices and receipts"),
    planned("Accounts & compliance", "digilocker", "DigiLocker", "Issue certificates to students"),
    planned("Accounts & compliance", "gps", "GPS devices", "Live bus tracking (AIS-140)"),
    planned("Accounts & compliance", "maps", "Maps", "Routes and stops on Google Maps or Mappls"),
    planned("Accounts & compliance", "biometric", "Biometric devices", "Fingerprint and face attendance"),
    planned("Payments", "other-gateways", "Cashfree, PayU, PhonePe", "Backup payment gateways"),
  ];

  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [keys, hooks, failed] = await Promise.all([
    supabaseAdmin.from("api_keys").select("*", { count: "exact", head: true }).eq("status", "active"),
    supabaseAdmin.from("webhooks").select("*", { count: "exact", head: true }).eq("active", true),
    supabaseAdmin.from("webhook_deliveries").select("*", { count: "exact", head: true }).eq("success", false).gte("attempted_at", since),
  ]);

  return {
    services,
    stats: {
      connected: services.filter((s) => s.status === "Connected").length,
      available: services.length,
      activeKeys: keys.count ?? 0,
      activeWebhooks: hooks.count ?? 0,
      failedDeliveries24h: failed.count ?? 0,
    },
  };
}

// ─────────────────────────────────────────────
//  API keys
// ─────────────────────────────────────────────
const KEY_FIELDS = "id, name, key_prefix, key_last4, scopes, status, use_count, last_used_at, created_at, revoked_at";

export async function listApiKeys() {
  return check(await supabaseAdmin.from("api_keys").select(KEY_FIELDS).order("created_at", { ascending: false }));
}

/** Creates a key. The full key is returned here once and can never be read again. */
export async function createApiKey(input: { name: string; scopes: string[] }, actorProfileId?: string) {
  const key = `mca_live_${crypto.randomBytes(32).toString("base64url")}`;
  const row = check(
    await supabaseAdmin
      .from("api_keys")
      .insert({
        name: input.name,
        scopes: input.scopes,
        key_prefix: key.slice(0, 12),
        key_last4: key.slice(-4),
        key_hash: sha256(key),
        created_by: actorProfileId ?? null,
      })
      .select(KEY_FIELDS)
      .single()
  );
  return { key, apiKey: row };
}

export async function revokeApiKey(id: string) {
  const row = check(
    await supabaseAdmin
      .from("api_keys")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "active")
      .select(KEY_FIELDS)
      .maybeSingle()
  );
  if (!row) throw new HttpError(404, "Key not found, or already revoked.");
  return row;
}

/** Looks up an active key by the secret a partner presented. */
export async function authenticateApiKey(presented: string) {
  if (!/^mca_live_[A-Za-z0-9_-]{20,}$/.test(presented)) return null;
  const row = check(
    await supabaseAdmin.from("api_keys").select("id, name, scopes").eq("key_hash", sha256(presented)).eq("status", "active").maybeSingle()
  ) as { id: string; name: string; scopes: string[] } | null;
  if (row) void supabaseAdmin.rpc("touch_api_key", { p_id: row.id }).then(() => undefined, () => undefined);
  return row;
}

// ─────────────────────────────────────────────
//  Webhooks
// ─────────────────────────────────────────────
const HOOK_FIELDS = "id, url, description, events, active, created_at";
const newSecret = () => `whsec_${crypto.randomBytes(24).toString("hex")}`;

export async function listWebhooks() {
  const hooks = check(await supabaseAdmin.from("webhooks").select(HOOK_FIELDS).order("created_at", { ascending: false })) as { id: string }[];
  if (!hooks.length) return [];
  // latest delivery per endpoint
  const recent = check(
    await supabaseAdmin
      .from("webhook_deliveries")
      .select("webhook_id, success, status_code, error, attempted_at")
      .in("webhook_id", hooks.map((h) => h.id))
      .order("attempted_at", { ascending: false })
      .limit(500)
  ) as { webhook_id: string; success: boolean; status_code: number | null; error: string | null; attempted_at: string }[];
  return hooks.map((h) => ({ ...h, last_delivery: recent.find((r) => r.webhook_id === h.id) ?? null }));
}

export async function createWebhook(input: { url: string; events: string[]; description?: string | null }, actorProfileId?: string) {
  await assertPublicUrl(input.url);
  const secret = newSecret();
  const hook = check(
    await supabaseAdmin
      .from("webhooks")
      .insert({ url: input.url, events: input.events, description: input.description ?? null, secret, created_by: actorProfileId ?? null })
      .select(HOOK_FIELDS)
      .single()
  );
  return { webhook: hook, secret };
}

export async function updateWebhook(id: string, patch: { url?: string; events?: string[]; description?: string | null; active?: boolean }) {
  if (patch.url) await assertPublicUrl(patch.url);
  const row = check(await supabaseAdmin.from("webhooks").update(patch).eq("id", id).select(HOOK_FIELDS).maybeSingle());
  if (!row) throw new HttpError(404, "Webhook not found.");
  return row;
}

export async function rotateWebhookSecret(id: string) {
  const secret = newSecret();
  const row = check(await supabaseAdmin.from("webhooks").update({ secret }).eq("id", id).select(HOOK_FIELDS).maybeSingle());
  if (!row) throw new HttpError(404, "Webhook not found.");
  return { webhook: row, secret };
}

export async function deleteWebhook(id: string) {
  check(await supabaseAdmin.from("webhooks").delete().eq("id", id).select("id"));
  return { success: true };
}

async function loadHook(id: string): Promise<Hook> {
  const hook = check(await supabaseAdmin.from("webhooks").select("id, url, secret").eq("id", id).maybeSingle()) as Hook | null;
  if (!hook) throw new HttpError(404, "Webhook not found.");
  return hook;
}

export async function sendTestEvent(id: string) {
  const hook = await loadHook(id);
  return deliver(hook, makeEnvelope("ping", { message: "This is a test event from My Class Assist." }));
}

export async function listDeliveries(webhookId: string) {
  return check(
    await supabaseAdmin
      .from("webhook_deliveries")
      .select("id, event, status_code, success, error, duration_ms, attempted_at")
      .eq("webhook_id", webhookId)
      .order("attempted_at", { ascending: false })
      .limit(50)
  );
}

/** Send a past delivery again (same event id, so receivers can de-duplicate). */
export async function redeliver(webhookId: string, deliveryId: string) {
  const hook = await loadHook(webhookId);
  const original = check(
    await supabaseAdmin.from("webhook_deliveries").select("payload").eq("id", deliveryId).eq("webhook_id", webhookId).maybeSingle()
  ) as { payload: ReturnType<typeof makeEnvelope> } | null;
  if (!original) throw new HttpError(404, "Delivery not found.");
  return deliver(hook, original.payload);
}

export { EVENTS };
