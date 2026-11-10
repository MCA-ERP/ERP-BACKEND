import { describe, expect, it, vi } from "vitest";

vi.mock("../modules/admin/settings.service", () => ({ getSettings: vi.fn() }));
import { maintenanceFrom } from "./maintenance";

const now = new Date("2026-11-09T01:30:00Z").getTime();

describe("maintenanceFrom", () => {
  it("is off by default", () => expect(maintenanceFrom({}, now).active).toBe(false));
  it("is on when switched on by hand, with the message", () => {
    const m = maintenanceFrom({ "maintenance.enabled": true, "maintenance.message": "Back at 3." }, now);
    expect(m.active).toBe(true);
    expect(m.message).toBe("Back at 3.");
  });
  it("turns itself on and off with a planned window", () => {
    const s = { "maintenance.starts_at": "2026-11-09T01:00:00Z", "maintenance.ends_at": "2026-11-09T03:00:00Z" };
    expect(maintenanceFrom(s, now).active).toBe(true);
    expect(maintenanceFrom(s, now).ends_at).toBe("2026-11-09T03:00:00.000Z");
    expect(maintenanceFrom(s, new Date("2026-11-09T03:00:01Z").getTime()).active).toBe(false);
    expect(maintenanceFrom(s, new Date("2026-11-08T12:00:00Z").getTime()).active).toBe(false);
  });
  it("tells schools about a window that has not started", () => {
    const m = maintenanceFrom({ "maintenance.starts_at": "2026-11-09T01:00:00Z", "maintenance.ends_at": "2026-11-09T03:00:00Z" }, new Date("2026-11-08T12:00:00Z").getTime());
    expect(m.upcoming_at).toBe("2026-11-09T01:00:00.000Z");
  });
  it("ignores a half-set window", () => expect(maintenanceFrom({ "maintenance.starts_at": "2026-11-09T01:00:00Z" }, now).active).toBe(false));
});
