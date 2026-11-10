import crypto from "crypto";
import { HttpError } from "./http-error";

const API = "https://api.razorpay.com/v1";

export const razorpayConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
export const webhookConfigured = () => Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);

function auth(): string {
  if (!razorpayConfigured()) throw new HttpError(503, "Online payments are not configured yet. Ask the platform team to add the Razorpay keys.");
  return "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
}

async function call<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: auth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, "Could not reach the payment gateway. Please try again.");
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new HttpError(502, data?.error?.description || `The payment gateway rejected the request (${res.status}).`);
  return data as T;
}

export function createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
  return call<{ id: string; amount: number; currency: string }>("/orders", {
    amount: input.amountPaise,
    currency: "INR",
    receipt: input.receipt.slice(0, 40),
    notes: input.notes,
  });
}

export function createRefund(paymentId: string, amountPaise: number, notes: Record<string, string>) {
  return call<{ id: string }>(`/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, notes });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Signature Razorpay Checkout returns to the browser: HMAC_SHA256(order_id|payment_id, key_secret). */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, secret = process.env.RAZORPAY_KEY_SECRET): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqual(expected, signature);
}

/** Webhook signature: HMAC_SHA256(raw request body, webhook secret). */
export function verifyWebhookSignature(rawBody: Buffer, signature: string, secret = process.env.RAZORPAY_WEBHOOK_SECRET): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}
