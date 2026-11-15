import { describe, expect, it, vi } from "vitest";

vi.mock("./security.service", () => ({
  clientIp: () => "203.0.113.5",
  isIpAllowed: vi.fn(async () => true),
  isIpBlocked: vi.fn(async () => false),
}));

import { adminAccess, requiredPermission } from "./admin.access";
import { isIpAllowed } from "./security.service";

describe("requiredPermission", () => {
  it.each([
    ["GET", "/schools", "platform.schools.view"],
    ["POST", "/schools", "platform.schools.create"],
    ["PATCH", "/schools/abc", "platform.schools.edit"],
    ["POST", "/schools/abc/status", "platform.schools.edit"],
    ["POST", "/schools/abc/status-action", "platform.schools.edit"],
    ["POST", "/schools/abc/approve", "platform.schools.edit"],
    ["POST", "/schools/abc/primary-admin", "platform.schools.edit"],
    ["POST", "/schools/abc/admins", "platform.schools.create"],
    ["POST", "/schools/abc/documents/d1/review", "platform.schools.edit"],
    ["GET", "/schools/abc/history/audit", "platform.schools.view"],
    ["PATCH", "/campuses/abc", "platform.schools.edit"],
    ["GET", "/applications", "platform.schools.view"],
    ["GET", "/support/categories", "platform.support.view"],
    ["POST", "/support/categories", "platform.support.create"],
    ["POST", "/support/assign", "platform.support.edit"],
    ["POST", "/support/reassign", "platform.support.edit"],
    ["PUT", "/support/sla/High", "platform.support.edit"],
    ["POST", "/support/tickets/abc/escalate", "platform.support.create"],
    ["DELETE", "/support/kb/abc", "platform.support.delete"],
    ["PATCH", "/support/features/abc", "platform.support.edit"],
    ["GET", "/payments/refund-requests", "platform.payments.view"],
    ["POST", "/payments/abc/refund-requests", "platform.payments.create"],
    ["POST", "/payments/refund-requests/abc/decide", "platform.payments.edit"],
    ["POST", "/payments/gateway/test", "platform.payments.edit"],
    ["PUT", "/payments/settings", "platform.payments.edit"],
    ["GET", "/payments/tax-report", "platform.payments.view"],
    ["GET", "/role-config/roles", "platform.roles.view"],
    ["POST", "/role-config/roles", "platform.roles.create"],
    ["PATCH", "/role-config/roles/abc", "platform.roles.edit"],
    ["DELETE", "/role-config/roles/abc", "platform.roles.delete"],
    ["POST", "/role-config/roles/abc/assign", "platform.roles.edit"],
    ["POST", "/role-config/roles/abc/restore", "platform.roles.edit"],
    ["PUT", "/role-config/module-access/abc", "platform.roles.edit"],
    ["GET", "/user-directory", "platform.users.view"],
    ["POST", "/user-directory/abc/reset-password", "platform.users.edit"],
    ["POST", "/user-directory/abc/state", "platform.users.edit"],
    ["GET", "/login-activity/failed", "platform.users.view"],
    ["POST", "/login-activity/sessions/abc/end", "platform.users.edit"],
    ["POST", "/student-accounts", "platform.users.create"],
    ["POST", "/parent-accounts", "platform.users.create"],
    ["GET", "/module-config/modules/exams", "platform.modules.view"],
    ["PUT", "/module-config/dependencies/exams", "platform.modules.edit"],
    ["POST", "/module-config/flags", "platform.modules.create"],
    ["PATCH", "/module-config/pricing/exams", "platform.modules.edit"],
    ["DELETE", "/module-config/bundles/abc", "platform.modules.delete"],
    ["PUT", "/schools/abc/modules", "platform.modules.edit"],
    ["GET", "/subscriptions/plans", "platform.subscriptions.view"],
    ["POST", "/subscriptions/coupons", "platform.subscriptions.create"],
    ["PATCH", "/subscriptions/plans/abc", "platform.subscriptions.edit"],
    ["DELETE", "/subscriptions/coupons/abc", "platform.subscriptions.delete"],
    ["POST", "/subscriptions/schools/abc/renew", "platform.subscriptions.create"],
    ["POST", "/subscriptions/schools/abc/cancel", "platform.subscriptions.edit"],
    ["POST", "/subscriptions/requests/abc/decide", "platform.subscriptions.edit"],
    ["POST", "/subscriptions/schools/abc/extend-trial", "platform.subscriptions.edit"],
    ["POST", "/applications/abc/convert", "platform.schools.edit"],
    ["POST", "/schools/abc/plan", "platform.subscriptions.edit"],
    ["GET", "/schools/abc/modules", "platform.modules.view"],
    ["PUT", "/schools/abc/modules/transport", "platform.modules.edit"],
    ["PUT", "/plans/basic/modules", "platform.modules.edit"],
    ["GET", "/plans", "platform.subscriptions.view"],
    ["PUT", "/roles/abc/permissions", "platform.roles.edit"],
    ["GET", "/audit-logs", "platform.security.view"],
    ["DELETE", "/ip-allowlist/abc", "platform.security.delete"],
    ["DELETE", "/cms/items/abc", "platform.cms.delete"],
    ["GET", "/cms/sitemap", "platform.cms.view"],
    ["GET", "/security/alerts", "platform.security.view"],
    ["POST", "/system/releases", "platform.settings.create"],
    ["GET", "/system/info", "platform.settings.view"],
    ["POST", "/security/incidents", "platform.security.create"],
    ["PATCH", "/security/incidents/abc", "platform.security.edit"],
    ["DELETE", "/security/devices/abc", "platform.security.delete"],
    ["POST", "/ip-blocklist", "platform.security.create"],
    ["PUT", "/security/retention", "platform.security.edit"],
    ["PUT", "/cms/sitemap", "platform.cms.edit"],
    ["PUT", "/settings", "platform.settings.edit"],
    ["POST", "/payments/invoices", "platform.payments.create"],
    ["POST", "/payments/invoices/abc/void", "platform.payments.edit"],
    ["POST", "/payments/abc/refund", "platform.payments.edit"],
    ["GET", "/payments/analytics", "platform.payments.view"],
  ])("%s %s needs %s", (method, path, expected) => {
    expect(requiredPermission(method, path)).toBe(expected);
  });

  it("denies unknown paths and methods", () => {
    expect(requiredPermission("GET", "/nothing")).toBeNull();
    expect(requiredPermission("GET", "/")).toBeNull();
    expect(requiredPermission("TRACE", "/schools")).toBeNull();
  });
});

async function run(user: unknown, method: string, path: string) {
  let outcome = "allowed";
  const req = { user, method, path } as never;
  const res = { status: (s: number) => ({ json: () => (outcome = `denied ${s}`) }) } as never;
  await adminAccess(req, res, (err?: unknown) => {
    if (err) outcome = "error";
  });
  return outcome;
}

describe("adminAccess", () => {
  const staff = (permissions: string[], extra = {}) => ({ role: "SupportAgent", permissions, modules: [], ...extra });

  it("requires a signed-in user", async () => {
    expect(await run(undefined, "GET", "/schools")).toBe("denied 401");
  });

  it("lets a Super Administrator through", async () => {
    expect(await run({ role: "SuperAdmin", permissions: [], modules: [] }, "DELETE", "/cms/items/x")).toBe("allowed");
  });

  it("lets staff do what their permissions say and nothing more", async () => {
    const agent = staff(["platform.support.view", "platform.support.edit"]);
    expect(await run(agent, "GET", "/support/tickets")).toBe("allowed");
    expect(await run(agent, "PATCH", "/support/tickets/x")).toBe("allowed");
    expect(await run(agent, "POST", "/schools")).toBe("denied 403");
    expect(await run(agent, "GET", "/unknown-area")).toBe("denied 403");
  });

  it("keeps school users out even if they somehow hold a platform permission", async () => {
    expect(await run(staff(["platform.schools.view"], { institutionId: "school-1" }), "GET", "/schools")).toBe("denied 403");
  });

  it("blocks everyone, including Super Administrators, from a disallowed address", async () => {
    vi.mocked(isIpAllowed).mockResolvedValueOnce(false);
    expect(await run({ role: "SuperAdmin", permissions: [], modules: [] }, "GET", "/schools")).toBe("denied 403");
  });
});

import { pageKeyFor } from "../../lib/role-pages";
describe("pageKeyFor", () => {
  it.each([
    [["applications"], "schools.applications"],
    [["schools", "abc", "approve"], "schools.approval"],
    [["subscriptions", "coupons"], "subscriptions.discounts"],
    [["subscriptions", "schools", "abc", "renew"], "subscriptions.renewals"],
    [["module-config", "pricing", "exams"], "modules.pricing"],
    [["login-activity", "failed"], "users.login_activity"],
    [["plans"], null],
    [["schools"], null],
  ])("%j -> %s", (parts, key) => {
    expect(pageKeyFor(parts as string[])).toBe(key);
  });
});
