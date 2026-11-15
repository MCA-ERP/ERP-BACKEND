import { HttpError } from "./http-error";

/**
 * SMS through MSG91's Flow API. India requires every SMS text to be a DLT-approved template, so each
 * message is sent by naming a template (created and approved in your MSG91 account) and passing its
 * variables. The variable names in the MSG91 template must match the placeholders used here
 * (for example ##school_name## for {{school_name}}).
 *   MSG91_AUTH_KEY   your account auth key
 *   MSG91_BASE_URL   optional, defaults to https://control.msg91.com
 */
export const smsConfigured = () => Boolean(process.env.MSG91_AUTH_KEY);

const BASE = () => (process.env.MSG91_BASE_URL || "https://control.msg91.com").replace(/\/$/, "");

/**
 * Normalises a phone number to digits with country code. A bare 10-digit number is treated as Indian (91).
 * Returns null when it cannot be a real mobile number.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-().]/g, "").replace(/^\+/, "").replace(/^00/, "");
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91") && /^[6-9]/.test(digits.slice(2))) return digits;
  if (digits.length >= 11 && digits.length <= 15 && !digits.startsWith("91")) return digits;
  return null;
}

export async function sendSms(input: { to: string; templateId: string; variables: Record<string, string> }): Promise<string> {
  if (!smsConfigured()) throw new HttpError(503, "SMS is not configured. Add MSG91_AUTH_KEY to the backend .env.");
  const mobile = normalizePhone(input.to);
  if (!mobile) throw new Error(`"${input.to}" is not a valid mobile number.`);
  if (!input.templateId) throw new Error("This SMS template has no MSG91 template id. Add it under Communication → Templates.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${BASE()}/api/v5/flow/`, {
      method: "POST",
      headers: { authkey: process.env.MSG91_AUTH_KEY!, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ template_id: input.templateId, short_url: "0", recipients: [{ mobiles: mobile, ...input.variables }] }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || (body.type && body.type !== "success")) {
      throw new Error(body.message || `The SMS provider answered ${res.status}.`);
    }
    return String(body.message ?? "");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("The SMS provider did not answer in time.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
