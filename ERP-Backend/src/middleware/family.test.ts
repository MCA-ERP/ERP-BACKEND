import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ profile: {} as Record<string, unknown>, authUser: {} as Record<string, unknown> }));
vi.mock("../../db/client", () => ({
  supabasePublic: { auth: { getUser: async () => ({ data: { user: h.authUser }, error: null }) } },
  supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.profile }) }) }) }) },
}));
vi.mock("../lib/sessions", () => ({ checkSession: async () => "ok", sessionIdOf: () => null }));
vi.mock("../lib/permissions", () => ({ getRolePermissions: async () => [], getRoleModuleLimit: async () => null }));

import { authGuard } from "./authGuard";
import { FAMILY_ROLES, staffOnly } from "./rbacGuard";

async function run(url: string) {
  let out = "next";
  await authGuard({ headers: { authorization: "Bearer t" }, method: "GET", originalUrl: url } as never, { status: (s: number) => ({ json: (b: { code?: string }) => (out = `${s} ${b.code ?? ""}`.trim()) }) } as never, () => {});
  return out;
}

describe("families and temporary passwords", () => {
  it("refuses every family role on staff routes", () => {
    for (const role of FAMILY_ROLES) {
      let status = 0;
      staffOnly({ user: { role } } as never, { status: (s: number) => ({ json: () => (status = s) }) } as never, () => {});
      expect(status).toBe(403);
    }
    let passed = false;
    staffOnly({ user: { role: "Faculty" } } as never, {} as never, () => { passed = true; });
    expect(passed).toBe(true);
  });

  it("opens only the sign-in routes until a temporary password is replaced", async () => {
    h.authUser = { id: "a", email: "x@example.test" };
    h.profile = { id: "p", status: "active", must_change_password: true, institution_id: null, roles: { name: "SupportAgent" } };
    expect(await run("/api/v1/admin/schools")).toBe("403 PASSWORD_CHANGE_REQUIRED");
    expect(await run("/api/v1/auth/me")).toBe("next");
    h.profile.must_change_password = false;
    expect(await run("/api/v1/admin/schools")).toBe("next");
  });

  it("gives the first-administrator shortcut only to a confirmed email", async () => {
    process.env.SUPER_ADMIN_EMAILS = "boss@example.test";
    h.profile = null as never;
    h.authUser = { id: "a", email: "boss@example.test" };
    expect(await run("/api/v1/auth/me")).toBe("403");
    h.authUser = { id: "a", email: "boss@example.test", email_confirmed_at: "2026-01-01" };
    expect(await run("/api/v1/auth/me")).toBe("next");
    delete process.env.SUPER_ADMIN_EMAILS;
  });
});
