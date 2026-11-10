import { describe, expect, it } from "vitest";
import { bucketIndex, moduleOfPath, percentile, routeGroup } from "./telemetry";

describe("routeGroup", () => {
  it.each([
    ["/api/v1/admin/schools/6cba1969-0201-4aa0-835b-4646ef53a7d6/status", "admin/schools"],
    ["/api/v1/admin/subscriptions/plans", "admin/subscriptions"],
    ["/api/v1/school/billing/invoices", "school/billing"],
    ["/api/v1/sis/students", "sis"],
    ["/api/v1/auth/login/verify", "auth"],
    ["/api/v1/admin", "admin"],
  ])("%s -> %s", (path, group) => {
    expect(routeGroup(path)).toBe(group);
  });
  it("maps built modules", () => {
    expect(moduleOfPath("/api/v1/sis/stats")).toBe("student_information");
    expect(moduleOfPath("/api/v1/admin/schools")).toBeNull();
  });
});

describe("latency buckets", () => {
  it("puts a time in the bucket whose upper edge covers it", () => {
    expect([10, 50, 51, 100, 250, 500, 1000, 2500, 2501, 99999].map(bucketIndex)).toEqual([0, 0, 1, 1, 2, 3, 4, 5, 6, 6]);
  });
  it("estimates percentiles from the counts", () => {
    // 90 fast (<=50ms), 9 medium (<=250ms), 1 slow (<=1000ms)
    const b = [90, 0, 9, 0, 1, 0, 0];
    expect(percentile(b, 0.5)).toBe(50);
    expect(percentile(b, 0.95)).toBe(250);
    expect(percentile(b, 1)).toBe(1000);
    expect(percentile([0, 0, 0, 0, 0, 0, 0], 0.95)).toBe(0);
  });
});
