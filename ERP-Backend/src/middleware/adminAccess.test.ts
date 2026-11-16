import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ supabaseAdmin: {}, supabasePublic: {} }));
vi.mock("../lib/permissions", () => ({ getRolePermissions: vi.fn(), getRoleModuleLimit: vi.fn() }));
vi.mock("../lib/sessions", () => ({ checkSession: vi.fn(), sessionIdOf: vi.fn() }));
vi.mock("../lib/maintenance", () => ({ maintenanceState: vi.fn() }));
vi.mock("../modules/billing/entitlements", () => ({ getEntitlements: vi.fn() }));
import { limitAdminPermissions } from "./authGuard";

const all = ["admin.users.manage", "admin.settings.manage", "finance.fees.manage", "finance.payment.collect", "finance.reports.view", "sis.student.view"];

describe("limitAdminPermissions", () => {
  it("leaves everyone alone when nothing was switched off", () => {
    expect(limitAdminPermissions(all, "InstitutionAdmin", {})).toEqual(all);
    expect(limitAdminPermissions(all, "InstitutionAdmin", null)).toEqual(all);
    expect(limitAdminPermissions(all, "InstitutionAdmin", { users: true, fees: true })).toEqual(all);
  });
  it("removes the permissions of an area that is off, and only those", () => {
    expect(limitAdminPermissions(all, "InstitutionAdmin", { fees: false })).toEqual(["admin.users.manage", "admin.settings.manage", "finance.reports.view", "sis.student.view"]);
    expect(limitAdminPermissions(all, "InstitutionAdmin", { users: false, settings: false, reports: false })).toEqual(["finance.fees.manage", "finance.payment.collect", "sis.student.view"]);
  });
  it("ignores data export, which has no permission of its own yet", () => {
    expect(limitAdminPermissions(all, "InstitutionAdmin", { data_export: false })).toEqual(all);
  });
  it("only ever applies to school administrators", () => {
    expect(limitAdminPermissions(all, "Faculty", { fees: false })).toEqual(all);
    expect(limitAdminPermissions(all, "SuperAdmin", { users: false })).toEqual(all);
  });
});
