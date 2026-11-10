import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "../../../db/client";
import { HttpError } from "../../lib/http-error";
import { emailConfigured, sendEmail } from "../../lib/mailer";
import { normalizePhone, sendSms, smsConfigured } from "../../lib/sms";
import { getSetting } from "../admin/settings.service";

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const TRUST_DAYS = 30;

const pepper = () => process.env.OTP_PEPPER || process.env.SUPABASE_SERVICE_ROLE_KEY || "dev-only-pepper";

/** A keyed hash, so a leaked table cannot be used to work out codes. */
export function hashCode(code: string, challengeId: string): string {
  return createHmac("sha256", pepper()).update(`${challengeId}:${code}`).digest("hex");
}
export const newCode = () => String(randomInt(100_000, 1_000_000));
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newDeviceToken = () => randomBytes(32).toString("base64url");

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "+91 •••••345" or "r•••@example.com". */
export function maskPhone(raw: string): string {
  const n = normalizePhone(raw);
  if (!n) return "your mobile number";
  const cc = n.length > 10 ? `+${n.slice(0, n.length - 10)} ` : "";
  return `${cc}•••••${n.slice(-3)}`;
}
export function maskEmail(email: string): string {
  const [u, d] = email.split("@");
  return `${u.slice(0, 1)}•••@${d}`;
}

export interface Delivery { channel: "sms" | "email" | "console"; sent_to: string }

/** Whether a code could be delivered at all right now (used before the setting is switched on). */
export async function deliveryAvailable(): Promise<{ ok: boolean; sms: boolean; email: boolean }> {
  const tpl = (await supabaseAdmin.from("message_templates").select("provider_template_id").eq("key", "login_otp").eq("channel", "sms").eq("is_active", true).maybeSingle()).data as { provider_template_id: string | null } | null;
  const sms = smsConfigured() && !!tpl?.provider_template_id;
  const email = emailConfigured();
  return { ok: sms || email || process.env.NODE_ENV !== "production", sms, email };
}

/**
 * Sends the code to the person's mobile number. If SMS is not set up (or they have no number on file) it goes to
 * their email instead. With neither, it is printed to the server console, outside production only.
 */
export async function deliverCode(profile: { email: string; first_name: string; phone: string | null }, code: string): Promise<Delivery> {
  const platform = await getSetting<string>("general.platform_name", "My Class Assist");
  const { sms } = await deliveryAvailable();

  if (sms && profile.phone && normalizePhone(profile.phone)) {
    const tpl = (await supabaseAdmin.from("message_templates").select("provider_template_id").eq("key", "login_otp").eq("channel", "sms").single()).data as { provider_template_id: string };
    try {
      await sendSms({ to: profile.phone, templateId: tpl.provider_template_id, variables: { platform_name: platform, otp: code } });
      return { channel: "sms", sent_to: maskPhone(profile.phone) };
    } catch (err) {
      console.error("Sign-in code SMS failed, trying email:", err instanceof Error ? err.message : err);
    }
  }
  if (emailConfigured()) {
    await sendEmail({
      to: profile.email,
      subject: `${code} is your ${platform} sign-in code`,
      text: `Hello ${profile.first_name},\n\nYour sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not try to sign in, change your password now and tell your administrator.\n\n${platform}`,
    });
    return { channel: "email", sent_to: maskEmail(profile.email) };
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[DEV ONLY] Sign-in code for ${profile.email}: ${code}`);
    return { channel: "console", sent_to: "the backend console (development only)" };
  }
  throw new HttpError(503, "Sign-in codes cannot be sent right now. Ask the platform team to set up SMS or email.");
}
