import { describe, expect, it } from "vitest";
import { passwordProblem } from "../../lib/password-policy";
import { burstsByIp, incidentCode } from "./security-mgmt.service";

const rules = { minLength: 10, number: true, symbol: false, blockCommon: true };

describe("passwordProblem", () => {
  it("accepts a password that meets the rules", () => expect(passwordProblem("river-stone-42", rules)).toBeNull());
  it("checks length first", () => expect(passwordProblem("short1", rules)).toMatch(/at least 10/));
  it("asks for a number when the policy says so", () => expect(passwordProblem("onlyletterslong", rules)).toMatch(/number/));
  it("asks for a symbol only when required", () => {
    expect(passwordProblem("river42stone9", rules)).toBeNull();
    expect(passwordProblem("river42stone9", { ...rules, symbol: true })).toMatch(/symbol/);
  });
  it("blocks common passwords and the person's own name or email", () => {
    expect(passwordProblem("password123", { ...rules, minLength: 8 })).toMatch(/too common/);
    expect(passwordProblem("Asha.Rao.2026", rules, ["asha.rao.2026"])).toMatch(/name, email or school/);
    expect(passwordProblem("password123", { ...rules, minLength: 8, blockCommon: false })).toBeNull();
  });
});

describe("burstsByIp", () => {
  it("reports addresses at or over the threshold, busiest first", () => {
    const events = [..."aaaaaabbbbbbbbc"].map((ch) => ({ ip_address: ch === "a" ? "1.1.1.1" : ch === "b" ? "2.2.2.2" : "3.3.3.3" }));
    expect(burstsByIp(events, 5)).toEqual([{ ip: "2.2.2.2", count: 8 }, { ip: "1.1.1.1", count: 6 }]);
  });
  it("ignores events with no address", () => expect(burstsByIp([{ ip_address: null }, { ip_address: null }], 1)).toEqual([]));
});

describe("incidentCode", () => {
  it("pads the number", () => expect(incidentCode(7)).toBe("INC-007"));
});
