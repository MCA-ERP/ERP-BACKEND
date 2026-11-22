import { describe, expect, it } from "vitest";
import { moduleGate } from "./portal-modules";
const run = (modules: string[], path: string, role = "InstitutionAdmin") => { let out = "next"; const res = { status: (c: number) => ({ json: () => { out = String(c); } }) }; moduleGate({ user: { role, modules }, path } as never, res as never, () => { out = "next"; }); return out; };
describe("plan gate for the school portal", () => {
  it("blocks a module the plan lacks", () => { expect(run(["fees"], "/hostel/hostels")).toBe("403"); expect(run(["fees"], "/inv/items")).toBe("403"); });
  it("allows a module the plan has, and always-on parts", () => { expect(run(["fees"], "/fees/payments")).toBe("next"); expect(run([], "/dashboard/x")).toBe("next"); expect(run([], "/settings-group/fee_rules")).toBe("next"); });
  it("lets Super Admin through", () => { expect(run([], "/hostel/hostels", "SuperAdmin")).toBe("next"); });
});
