import { HttpError } from "./http-error";
import { normalizePhone } from "./sms";

/**
 * WhatsApp through Meta's WhatsApp Business Cloud API. Business-started messages must use a template that
 * Meta has approved, so each message names the template and fills its numbered slots in order.
 *   WHATSAPP_TOKEN            a permanent access token from your Meta business account
 *   WHATSAPP_PHONE_NUMBER_ID  the id of the WhatsApp Business number that sends
 *   WHATSAPP_LANGUAGE         optional, the template language code (default en)
 *   WHATSAPP_API_VERSION      optional, default v20.0
 */
export const whatsappConfigured = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);

/** Names inside {{ }} in the order they first appear: the order of the template's numbered slots. */
export function placeholderOrder(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

export async function sendWhatsApp(input: { to: string; templateName: string; params: string[] }): Promise<string> {
  if (!whatsappConfigured()) throw new HttpError(503, "WhatsApp is not connected. Add WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID to the backend .env.");
  const to = normalizePhone(input.to);
  if (!to) throw new Error(`"${input.to}" is not a valid mobile number.`);
  if (!input.templateName) throw new Error("This WhatsApp template has no Meta template name. Add it under Communication → WhatsApp → Templates.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v20.0"}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: input.templateName,
          language: { code: process.env.WHATSAPP_LANGUAGE || "en" },
          components: input.params.length ? [{ type: "body", parameters: input.params.map((text) => ({ type: "text", text: text.slice(0, 1000) })) }] : [],
        },
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message || `WhatsApp answered ${res.status}.`);
    return body.messages?.[0]?.id ?? "";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("WhatsApp did not answer in time.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
