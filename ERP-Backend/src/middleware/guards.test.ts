import { describe, expect, it } from "vitest";
import { requireModule, requirePermission } from "./rbacGuard";
import { redact } from "./auditLogger";
import { parsePage, safeSearch } from "../lib/query";
import { slugify } from "../modules/admin/cms.service";
import { SETTING_SCHEMAS } from "../modules/admin/settings.service";

function check(mw: (req: never, res: never, next: () => void) => void, user: unknown) {
  let out = "next";
  mw({ user } as never, { status: (s: number) => ({ json: (b: { code?: string }) => (out = `${s} ${b.code ?? ""}`.trim()) }) } as never, () => {});
  return out;
}

describe("requirePermission", () => {
  const mw = requirePermission("sis.student.create", "sis.student.view");
  it("needs a user", () => expect(check(mw, undefined)).toBe("401"));
  it("needs every listed permission", () => {
    expect(check(mw, { role: "Faculty", permissions: ["sis.student.view"], modules: [] })).toBe("403");
    expect(check(mw, { role: "Registrar", permissions: ["sis.student.view", "sis.student.create"], modules: [] })).toBe("next");
  });
  it("lets a Super Administrator through", () => expect(check(mw, { role: "SuperAdmin", permissions: [], modules: [] })).toBe("next"));
});

describe("requireModule", () => {
  const mw = requireModule("timetable");
  it("blocks a school whose plan lacks the module", () => {
    expect(check(mw, { role: "Principal", permissions: [], modules: ["student_information"] })).toBe("403 MODULE_NOT_IN_PLAN");
  });
  it("allows a school that has it, and Super Administrators", () => {
    expect(check(mw, { role: "Principal", permissions: [], modules: ["timetable"] })).toBe("next");
    expect(check(mw, { role: "SuperAdmin", permissions: [], modules: [] })).toBe("next");
  });
});

describe("redact (audit log)", () => {
  it("hides secrets at any depth", () => {
    const out = redact({ email: "a@b.c", password: "x", admin: { Password: "y", token: "t", name: "n" }, list: [{ api_key: "k", ok: 1 }] });
    expect(out).toEqual({ email: "a@b.c", password: "[REDACTED]", admin: { Password: "[REDACTED]", token: "[REDACTED]", name: "n" }, list: [{ api_key: "[REDACTED]", ok: 1 }] });
  });
});

describe("query helpers", () => {
  it("strips characters that would break a PostgREST filter", () => {
    expect(safeSearch("a,b(c)%d*e\\f")).toBe("a b c  d e f");
    expect(safeSearch(undefined)).toBe("");
    expect(safeSearch("x".repeat(200))).toHaveLength(80);
  });
  it("clamps paging", () => {
    expect(parsePage({})).toMatchObject({ page: 1, pageSize: 20, from: 0, to: 19 });
    expect(parsePage({ page: "3", pageSize: "10" })).toMatchObject({ from: 20, to: 29 });
    expect(parsePage({ page: "-5", pageSize: "100000" })).toMatchObject({ page: 1, pageSize: 100 });
    expect(parsePage({ page: "abc", pageSize: "0" })).toMatchObject({ page: 1, pageSize: 20 });
  });
  it("makes URL-safe slugs", () => {
    expect(slugify("Hello World & Friends!")).toBe("hello-world-friends");
    expect(slugify("  --  ")).toBe("item");
  });
});

describe("settings validation", () => {
  const ok = (key: string, v: unknown) => SETTING_SCHEMAS[key].safeParse(v).success;
  it("accepts valid values and rejects bad ones", () => {
    expect(ok("general.trial_days", 14)).toBe(true);
    expect(ok("general.trial_days", -1)).toBe(false);
    expect(ok("general.trial_days", "14")).toBe(false);
    expect(ok("branding.primary_color", "#0294CE")).toBe(true);
    expect(ok("branding.primary_color", "red")).toBe(false);
    expect(ok("security.min_password_length", 4)).toBe(false);
    expect(ok("billing.gst_rate_percent", 18)).toBe(true);
    expect(ok("general.support_email", "")).toBe(true);
    expect(ok("general.support_email", "not-an-email")).toBe(false);
  });
});
