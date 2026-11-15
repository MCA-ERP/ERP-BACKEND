import { describe, expect, it } from "vitest";
import { maskId } from "./service-status";

describe("maskId", () => {
  it("keeps the mode prefix and the last characters of a Razorpay key", () => expect(maskId("rzp_live_AbCdEf1234kQe9")).toBe("rzp_live_••••kQe9"));
  it("hides short values completely", () => expect(maskId("abc")).toBe("••••"));
  it("shows a dash when nothing is set", () => expect(maskId(undefined)).toBe("—"));
  it("never shows the middle of a long id", () => expect(maskId("1234567890123456789")).not.toContain("567890"));
});
