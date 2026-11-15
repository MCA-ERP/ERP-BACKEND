import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { verifyCheckoutSignature, verifyWebhookSignature } from "./razorpay";

const hmac = (secret: string, data: string | Buffer) => crypto.createHmac("sha256", secret).update(data).digest("hex");

describe("verifyCheckoutSignature", () => {
  const secret = "key_secret";
  it("accepts the signature of order_id|payment_id", () => {
    expect(verifyCheckoutSignature("order_1", "pay_1", hmac(secret, "order_1|pay_1"), secret)).toBe(true);
  });
  it("rejects tampering, wrong secrets and empty input", () => {
    expect(verifyCheckoutSignature("order_1", "pay_2", hmac(secret, "order_1|pay_1"), secret)).toBe(false);
    expect(verifyCheckoutSignature("order_1", "pay_1", hmac("other", "order_1|pay_1"), secret)).toBe(false);
    expect(verifyCheckoutSignature("order_1", "pay_1", "", secret)).toBe(false);
    expect(verifyCheckoutSignature("order_1", "pay_1", "short", secret)).toBe(false);
    expect(verifyCheckoutSignature("order_1", "pay_1", hmac(secret, "order_1|pay_1"), "")).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "whsec";
  const body = Buffer.from('{"event":"payment.captured"}');
  it("accepts the signature of the exact raw body", () => {
    expect(verifyWebhookSignature(body, hmac(secret, body), secret)).toBe(true);
  });
  it("rejects a changed body or a missing secret", () => {
    expect(verifyWebhookSignature(Buffer.from('{"event":"payment.failed"}'), hmac(secret, body), secret)).toBe(false);
    expect(verifyWebhookSignature(body, hmac(secret, body), "")).toBe(false);
  });
});
