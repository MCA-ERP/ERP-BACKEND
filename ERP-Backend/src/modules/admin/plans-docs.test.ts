import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/supabase", () => ({ supabaseAdmin: {} }));
vi.mock("./settings.service", () => ({ getSetting: vi.fn() }));
import { allowedUpTo } from "../../lib/plan-limits";
import { documentStatus } from "./school-mgmt.service";

describe("documentStatus", () => {
  const today = "2026-11-16";
  it("is missing when nothing was uploaded", () => expect(documentStatus(null, today)).toBe("missing"));
  it("is verified when checked and in date", () => expect(documentStatus({ status: "verified", expiry_date: "2027-01-01" }, today)).toBe("verified"));
  it("is expired when past its date, even if verified", () => expect(documentStatus({ status: "verified", expiry_date: "2026-11-15" }, today)).toBe("expired"));
  it("is to review when uploaded but not checked", () => expect(documentStatus({ status: "pending", expiry_date: null }, today)).toBe("review"));
  it("keeps a rejection", () => expect(documentStatus({ status: "rejected", expiry_date: null }, today)).toBe("rejected"));
});

describe("allowedUpTo", () => {
  it("blocks at the limit by default", () => expect(allowedUpTo(100, "block")).toBe(100));
  it("allows 10% more with a grace", () => expect(allowedUpTo(100, "grace10")).toBe(110));
  it("never blocks when only warning", () => expect(allowedUpTo(100, "warn")).toBe(Infinity));
});
