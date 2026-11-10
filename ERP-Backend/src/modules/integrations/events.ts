import crypto from "crypto";
import { supabaseAdmin } from "../../../db/client";
import { assertPublicUrl } from "../../lib/net-guard";

/** Events a webhook can subscribe to. */
export const EVENTS = [
  "school.registered",
  "school.status_changed",
  "subscription.changed",
  "invoice.created",
  "payment.received",
  "payment.refunded",
  "ticket.created",
] as const;
export type EventType = (typeof EVENTS)[number];

export interface Hook {
  id: string;
  url: string;
  secret: string;
}

export interface DeliveryResult {
  success: boolean;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
}

const TIMEOUT_MS = 5_000;

/** HMAC-SHA256 over "<timestamp>.<body>"; receivers recompute it with the shared secret. */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function makeEnvelope(type: string, data: unknown) {
  return { id: `evt_${crypto.randomUUID()}`, type, created_at: new Date().toISOString(), data };
}

/** One delivery attempt. Always records the outcome; never throws. */
export async function deliver(hook: Hook, envelope: ReturnType<typeof makeEnvelope>): Promise<DeliveryResult> {
  const started = Date.now();
  let result: DeliveryResult;
  try {
    const url = await assertPublicUrl(hook.url);
    const body = JSON.stringify(envelope);
    const ts = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        redirect: "manual", // a redirect could point at an internal address
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "MyClassAssist-Webhooks/1.0",
          "X-MCA-Event": envelope.type,
          "X-MCA-Delivery": envelope.id,
          "X-MCA-Signature": `t=${ts},v1=${signPayload(hook.secret, ts, body)}`,
        },
        body,
      });
      result = {
        success: res.status >= 200 && res.status < 300,
        status_code: res.status,
        error: res.status >= 200 && res.status < 300 ? null : `The endpoint answered ${res.status}.`,
        duration_ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    result = {
      success: false,
      status_code: null,
      error: aborted ? "The endpoint did not answer within 5 seconds." : err instanceof Error ? err.message : "Delivery failed.",
      duration_ms: Date.now() - started,
    };
  }

  await supabaseAdmin.from("webhook_deliveries").insert({
    webhook_id: hook.id,
    event: envelope.type,
    payload: envelope,
    status_code: result.status_code,
    success: result.success,
    error: result.error,
    duration_ms: result.duration_ms,
  });
  return result;
}

/**
 * Tell every active webhook subscribed to this event. Fire and forget: callers never wait for,
 * or fail because of, a slow or broken receiver.
 */
export function emitEvent(type: EventType, data: unknown): void {
  void (async () => {
    const { data: hooks } = await supabaseAdmin.from("webhooks").select("id, url, secret").eq("active", true).contains("events", [type]);
    if (!hooks?.length) return;
    const envelope = makeEnvelope(type, data);
    await Promise.all(hooks.map((h) => deliver(h as Hook, envelope)));
  })().catch((err) => console.error("Webhook dispatch failed:", err instanceof Error ? err.message : err));
}
