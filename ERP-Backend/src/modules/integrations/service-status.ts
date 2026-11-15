import dns from "dns/promises";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { emailConfigured, verifyEmail } from "../../lib/mailer";
import { razorpayConfigured, webhookConfigured } from "../../lib/razorpay";
import { smsConfigured } from "../../lib/sms";
import { whatsappConfigured } from "../../lib/whatsapp";
import { getSetting } from "../admin/settings.service";

export const DETAIL_SERVICES = ["razorpay", "sms", "whatsapp", "email"] as const;
export type DetailService = (typeof DETAIL_SERVICES)[number];

/** Shows only the end of a secret-ish identifier, like rzp_live_••••4kQe. */
export function maskId(value: string | undefined, keep = 4): string {
  if (!value) return "—";
  if (value.length <= keep + 4) return "••••";
  const prefix = /^[a-z]+_(live|test)_/i.exec(value)?.[0] ?? "";
  return `${prefix}••••${value.slice(-keep)}`;
}

const since30 = () => new Date(Date.now() - 30 * 86_400_000).toISOString();

async function messageStats(channel: "email" | "sms" | "whatsapp") {
  const count = (status: string) => supabaseAdmin.from("message_log").select("*", { count: "exact", head: true }).eq("channel", channel).eq("status", status).gte("created_at", since30());
  const [sent, failed, queued] = await Promise.all([count("sent"), count("failed"), count("queued")]);
  const s = sent.count ?? 0;
  const f = failed.count ?? 0;
  return { sent: s, failed: f, queued: queued.count ?? 0, success_rate: s + f ? Math.round((s / (s + f)) * 1000) / 10 : null };
}

const apiBase = () => (process.env.API_PUBLIC_URL || "").replace(/\/$/, "");

export async function serviceDetail(service: DetailService) {
  if (service === "razorpay") {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const orders = check(await supabaseAdmin.from("payment_orders").select("status").gte("created_at", since30()).limit(20000)) as { status: string }[];
    const paid = orders.filter((o) => o.status === "paid").length;
    const failed = orders.filter((o) => o.status === "failed").length;
    return {
      key: service, configured: razorpayConfigured(),
      mode: keyId?.startsWith("rzp_live_") ? "Live" : keyId?.startsWith("rzp_test_") ? "Test" : null,
      fields: [
        { label: "Key ID", value: maskId(keyId) },
        { label: "Key secret", value: razorpayConfigured() ? "Set in the backend .env" : "Not set" },
        { label: "Webhook secret", value: webhookConfigured() ? "Set in the backend .env" : "Not set" },
        { label: "Webhook URL", value: apiBase() ? `${apiBase()}/api/v1/webhooks/razorpay` : "Set API_PUBLIC_URL, then give Razorpay <API address>/api/v1/webhooks/razorpay" },
      ],
      stats: [
        { label: "Payments (30 days)", value: String(orders.length), sub: orders.length ? `${Math.round((paid / Math.max(1, paid + failed)) * 1000) / 10}% of settled orders paid` : "No payments yet" },
        { label: "Paid", value: String(paid) },
        { label: "Failed", value: String(failed) },
      ],
      env: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"],
      canTest: true,
    };
  }
  if (service === "sms") {
    const templates = check(await supabaseAdmin.from("message_templates").select("provider_template_id").eq("channel", "sms").eq("is_active", true)) as { provider_template_id: string | null }[];
    return {
      key: service, configured: smsConfigured(), mode: null,
      fields: [
        { label: "Provider", value: "MSG91" },
        { label: "Auth key", value: smsConfigured() ? "Set in the backend .env" : "Not set" },
        { label: "Sender ID", value: (await getSetting<string>("notify.sms_sender_id", "")) || "Not set (Settings → Email & SMS)" },
        { label: "Templates with an MSG91 id", value: `${templates.filter((t) => t.provider_template_id).length} of ${templates.length}` },
      ],
      stats: await smsStats(),
      env: ["MSG91_AUTH_KEY"],
      canTest: false,
      testNote: "MSG91 has no free check, so use Settings → Email & SMS → Send a test to prove it works end to end.",
    };
  }
  if (service === "whatsapp") {
    const templates = check(await supabaseAdmin.from("message_templates").select("provider_template_id").eq("channel", "whatsapp").eq("is_active", true)) as { provider_template_id: string | null }[];
    return {
      key: service, configured: whatsappConfigured(), mode: null,
      fields: [
        { label: "Provider", value: "Meta WhatsApp Business Cloud API" },
        { label: "Phone number ID", value: maskId(process.env.WHATSAPP_PHONE_NUMBER_ID) },
        { label: "Access token", value: process.env.WHATSAPP_TOKEN ? "Set in the backend .env" : "Not set" },
        { label: "Templates with a Meta name", value: `${templates.filter((t) => t.provider_template_id).length} of ${templates.length}` },
      ],
      stats: await smsStats("whatsapp"),
      env: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"],
      canTest: true,
    };
  }
  const [from, opens, track] = await Promise.all([
    getSetting<string>("notify.email_from_address", ""),
    supabaseAdmin.from("message_log").select("*", { count: "exact", head: true }).eq("channel", "email").not("opened_at", "is", null).gte("created_at", since30()),
    getSetting<boolean>("communication.track_email_opens", true),
  ]);
  return {
    key: service, configured: emailConfigured(), mode: null,
    fields: [
      { label: "Host", value: process.env.SMTP_HOST || "Not set" },
      { label: "Port", value: `${process.env.SMTP_PORT || 587}${process.env.SMTP_SECURE === "true" ? " (SSL/TLS)" : " (STARTTLS)"}` },
      { label: "Username", value: maskId(process.env.SMTP_USER, 6) },
      { label: "Password", value: process.env.SMTP_PASS ? "Set in the backend .env" : "Not set" },
      { label: "Sends from", value: from || process.env.MAIL_FROM || "Not set" },
      { label: "Open tracking", value: track ? `On (${opens.count ?? 0} opens in 30 days)` : "Off" },
    ],
    stats: await smsStats("email"),
    env: ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"],
    canTest: true,
  };
}

async function smsStats(channel: "sms" | "whatsapp" | "email" = "sms") {
  const m = await messageStats(channel);
  return [
    { label: "Sent (30 days)", value: String(m.sent), sub: m.success_rate === null ? "Nothing sent yet" : `${m.success_rate}% delivered to the provider` },
    { label: "Failed", value: String(m.failed) },
    { label: "Waiting", value: String(m.queued) },
  ];
}

// ── connection tests ────────────────────────────────────────
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = Date.now();
  const value = await fn();
  return { ms: Date.now() - t, value };
}

export async function testService(service: DetailService): Promise<{ ok: boolean; ms: number; message: string }> {
  try {
    if (service === "razorpay") {
      if (!razorpayConfigured()) throw new HttpError(400, "Razorpay keys are not set in the backend .env.");
      const auth = "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
      const { ms } = await timed(async () => {
        const res = await fetch("https://api.razorpay.com/v1/orders?count=1", { headers: { Authorization: auth }, signal: AbortSignal.timeout(10_000) });
        if (res.status === 401) throw new Error("Razorpay rejected the key ID and secret.");
        if (!res.ok) throw new Error(`Razorpay answered ${res.status}.`);
      });
      return { ok: true, ms, message: "Razorpay accepted the keys." };
    }
    if (service === "whatsapp") {
      if (!whatsappConfigured()) throw new HttpError(400, "WhatsApp is not connected. Add WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID to the backend .env.");
      const { ms, value } = await timed(async () => {
        const res = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v20.0"}/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`, {
          headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }, signal: AbortSignal.timeout(10_000),
        });
        const body = (await res.json().catch(() => ({}))) as { display_phone_number?: string; verified_name?: string; quality_rating?: string; error?: { message?: string } };
        if (!res.ok) throw new Error(body.error?.message || `Meta answered ${res.status}.`);
        return body;
      });
      return { ok: true, ms, message: `Connected to ${value.verified_name ?? "your business"} ${value.display_phone_number ?? ""}${value.quality_rating ? `. Quality rating: ${value.quality_rating}` : ""}.`.replace(/\s+/g, " ") };
    }
    if (service === "email") {
      if (!emailConfigured()) throw new HttpError(400, "Email is not configured. Add the SMTP settings to the backend .env.");
      const { ms } = await timed(() => verifyEmail());
      return { ok: true, ms, message: "The mail server accepted the connection and sign-in." };
    }
    throw new HttpError(400, "There is no connection test for this service.");
  } catch (err) {
    return { ok: false, ms: 0, message: err instanceof Error ? err.message : "The test failed." };
  }
}

// ── email DNS ───────────────────────────────────────────────
export interface DnsCheck { name: string; status: "Verified" | "Missing" | "Unknown"; detail: string }

const flat = (rows: string[][]) => rows.map((r) => r.join(""));
const txt = (host: string) => dns.resolveTxt(host).then(flat).catch(() => [] as string[]);

/** Reads the SPF, DMARC and DKIM records of the domain the platform sends email from. */
export async function emailDnsChecks(): Promise<{ domain: string | null; checks: DnsCheck[] }> {
  const from = (await getSetting<string>("notify.email_from_address", "")) || process.env.MAIL_FROM || process.env.SMTP_USER || "";
  const domain = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(from.replace(/^.*</, "").replace(/>$/, ""))?.[1]?.toLowerCase() ?? null;
  if (!domain) return { domain: null, checks: [] };

  const [root, dmarc] = await Promise.all([txt(domain), txt("_dmarc." + domain)]);
  const spf = root.find((r) => /^v=spf1/i.test(r));
  const dm = dmarc.find((r) => /^v=DMARC1/i.test(r));
  const selectors = ["default", "selector1", "selector2", "google", "k1", "s1", "s2", "mail", "dkim", "zoho"];
  const found: string[] = [];
  await Promise.all(selectors.map(async (s) => {
    const host = `${s}._domainkey.${domain}`;
    const [t, c] = await Promise.all([txt(host), dns.resolveCname(host).catch(() => [] as string[])]);
    if (t.some((r) => /v=DKIM1|p=/i.test(r)) || c.length) found.push(s);
  }));

  return {
    domain,
    checks: [
      { name: "SPF", status: spf ? "Verified" : "Missing", detail: spf ?? "No SPF record. Mail may land in spam." },
      { name: "DKIM", status: found.length ? "Verified" : "Unknown", detail: found.length ? `Found for ${found.join(", ")}` : "No record at the usual names. Your provider may use its own; check its dashboard." },
      { name: "DMARC", status: dm ? "Verified" : "Missing", detail: dm ? (/p=(\w+)/i.exec(dm)?.[0] ?? dm) : "No DMARC record at _dmarc." + domain },
    ],
  };
}

// ── deliveries across every webhook ─────────────────────────
export async function allDeliveries(limit = 100) {
  return check(
    await supabaseAdmin
      .from("webhook_deliveries")
      .select("id, event, status_code, success, error, duration_ms, attempted_at, webhooks:webhook_id(url)")
      .order("attempted_at", { ascending: false })
      .limit(Math.min(limit, 200))
  );
}
