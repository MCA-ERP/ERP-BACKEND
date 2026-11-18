import { describe, expect, it, vi } from "vitest";

vi.mock("../billing/billing.service", () => ({ getAnalytics: vi.fn() }));
vi.mock("./security-mgmt.service", () => ({ listAlerts: vi.fn() }));
import { parseRange, previousRange, subscriptionAlerts, summariseSignIns } from "./dashboard.service";

const NOW = Date.parse("2026-11-03T10:00:00Z");

describe("parseRange", () => {
  it("defaults to the last 30 days, counting today", () => {
    const r = parseRange({}, NOW);
    expect(r).toEqual({ from: "2026-10-05", to: "2026-11-03", days: 30 });
  });
  it("uses the days it is given and swaps them when reversed", () => {
    expect(parseRange({ from: "2026-11-01", to: "2026-10-01" }, NOW)).toEqual({ from: "2026-10-01", to: "2026-11-01", days: 32 });
  });
  it("ignores values that are not dates", () => expect(parseRange({ from: "yesterday", to: "soon" }, NOW).days).toBe(30));
  it("refuses an enormous range", () => expect(() => parseRange({ from: "2020-01-01", to: "2026-01-01" }, NOW)).toThrow(/two years/));
});

describe("previousRange", () => {
  it("is the same length straight before", () => {
    expect(previousRange({ from: "2026-10-05", to: "2026-11-03", days: 30 })).toEqual({ from: "2026-09-05", to: "2026-10-04", days: 30 });
  });
});

describe("summariseSignIns", () => {
  const ev = (iso: string, ua: string, user: string, success = true, reason = "ok") => ({ created_at: iso, user_agent: ua, user_profile_id: user, success, reason });
  it("works out peak hour (India time), mobile share and failures", () => {
    const events = [
      ev("2026-11-03T02:30:00Z", "Chrome Android Mobile", "a"), // 08:00 IST
      ev("2026-11-03T02:40:00Z", "Safari iPhone", "b"),         // 08:10 IST
      ev("2026-11-03T05:00:00Z", "Chrome Windows", "a"),        // 10:30 IST
      ev("2026-11-03T02:50:00Z", "Chrome", "c", false, "bad_password"),
    ];
    const s = summariseSignIns(events, { from: "2026-11-03", to: "2026-11-03", days: 1 });
    expect(s.signed_in).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.peak_hour).toBe(8);
    expect(s.mobile_share).toBe(67);
    expect(s.daily_active_users).toBe(2);
  });
  it("copes with no sign-ins", () => {
    const s = summariseSignIns([], { from: "2026-11-03", to: "2026-11-03", days: 1 });
    expect(s).toMatchObject({ signed_in: 0, peak_hour: null, mobile_share: null });
  });
});

describe("subscriptionAlerts", () => {
  const school = (o: Record<string, unknown>) => ({ id: "s1", code: "SCH-1", name: "Riverside", status: "Active", plan_code: "standard", plan_name: "Standard", price_per_student_paise: 100, renews_on: null, trial_ends_on: null, students: 100, arr_paise: 1_000_000, ...o }) as never;
  const limits = new Map<string, number | null>([["standard", 1500]]);
  const run = (o: Record<string, unknown>) => subscriptionAlerts([school(o)], limits, "2026-11-03");

  it("warns when a trial is close to ending, and is critical in the last days", () => {
    expect(run({ status: "Trial", trial_ends_on: "2026-11-18" })[0]).toMatchObject({ title: "Trial ends in 15 days", severity: "warning" });
    expect(run({ status: "Trial", trial_ends_on: "2026-11-05" })[0].severity).toBe("critical");
    expect(run({ status: "Trial", trial_ends_on: "2026-12-30" })).toEqual([]);
  });
  it("flags renewals in the next 30 days, urgent within two weeks", () => {
    expect(run({ renews_on: "2026-11-15" })[0]).toMatchObject({ title: "Renewal due in 12 days", severity: "warning" });
    expect(run({ renews_on: "2026-11-30" })[0].severity).toBe("info");
    expect(run({ renews_on: "2027-03-31" })).toEqual([]);
  });
  it("flags an expired subscription as critical", () => expect(run({ status: "Expired", renews_on: "2026-10-15" })[0]).toMatchObject({ title: "Subscription expired", severity: "critical" }));
  it("flags a school near its student limit, with its own id for each step", () => {
    const a = run({ students: 1250 })[0];
    expect(a).toMatchObject({ title: "Student limit 83% used", severity: "info" });
    expect(run({ students: 1450 })[0].severity).toBe("warning");
    expect(run({ students: 1600 })[0].severity).toBe("critical");
    expect(new Set([a.id, run({ students: 1450 })[0].id, run({ students: 1600 })[0].id]).size).toBe(3);
    expect(run({ students: 900 })).toEqual([]);
  });
  it("gives a new alert for the next renewal cycle", () => {
    expect(run({ renews_on: "2026-11-15" })[0].id).not.toBe(run({ renews_on: "2026-11-20" })[0].id);
  });
});
