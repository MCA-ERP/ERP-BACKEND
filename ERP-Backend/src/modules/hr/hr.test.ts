import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { maskPhone } from "../school/hr2.service";
import { inWindow, isFieldStaff } from "../school/geo-fence.service";

/** Reads that name the signed-in person (from the session) instead of the school: their own read marks. */
const BY_PROFILE = new Set(["staff_notification_reads"]);

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");

describe("the HR portal stays on the signed-in person's school", () => {
  const routes = read("hr.routes.ts");
  const service = read("hr-portal.service.ts");
  const school = read("../school/school.routes.ts");
  const accounts = read("../accounts/accounts.routes.ts");
  const server = read("../../server.ts");

  it("only lets HR in, and only when the plan has HR or Payroll", () => {
    expect(routes).toMatch(/hrRouter\.use\(authGuard\)/);
    expect(routes).toMatch(/hrRouter\.use\(requireRoles\(\.\.\.HR_ROLES\)\)/);
    expect(routes).toMatch(/HR_ROLES = \["HR"\]/);
    expect(routes).toMatch(/\["hr_payroll", "payroll"\]\.some/);
    expect(server).toMatch(/app\.use\("\/api\/v1\/hr", hrRouter\)/);
  });

  it("gates self-service by the plan", () => {
    for (const p of ["profile/employment", "profile/qualifications", "profile/documents", "payslips", "claims"]) expect(routes).toMatch(new RegExp(`"/${p}", self`));
    expect(school).toMatch(/"\/me\/payslips", requireSelf/);
  });

  it("takes the school and the person from the session, never from the request", () => {
    expect(routes).toMatch(/req\.user\?\.profileId/);
    expect(routes).not.toMatch(/req\.body\.(profile|staff|owner|institution)_?id/i);
    expect(service).not.toMatch(/input\.institution_id|body\.institution_id/);
  });

  it("filters every read by the school and scopes every write", () => {
    const bad: string[] = [];
    const re = /supabaseAdmin\s*\.from\("(\w+)"\)/g;
    const starts: { i: number; t: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(service))) starts.push({ i: m.index, t: m[1] });
    starts.forEach((s, k) => {
      const seg = service.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : service.length);
      const head = seg.split(/\n\s*\n|\nexport |\n  const |\n  check\(|\n  if /)[0];
      // a qualification has no school column: it is checked against its owner's school before it is changed
      if (!/institution_id/.test(head) && !BY_PROFILE.has(s.t) && s.t !== "staff_qualifications") bad.push(s.t);
    });
    expect([...new Set(bad)]).toEqual([]);
    expect(service).toMatch(/\.eq\("who\.institution_id", inst\)/);
    expect(service).toMatch(/from\("user_profiles"\)\.select\("id"\)\.eq\("id", q\.profile_id\)\.eq\("institution_id", inst\)/);
  });

  it("lets nobody verify their own record", () => {
    expect(service).toMatch(/d\.staff_id === actor/);
    expect(service).toMatch(/q\.profile_id === actor/);
  });

  it("keeps HR away from its own pay, and from marking salaries paid", () => {
    for (const r of ["/hr/profile360/:id/salary", "/pay/assign", "/pay/assign-employee", "/pay/other-deduction/:id", "/pay/bank/:id", "/hr/increments/:id", "/hr/comp-offs", "/hr/exits/:id/decide", "/hr/probation/:id"]) {
      expect(school).toContain(`"${r}", hrDesk, notOwn(`);
    }
    expect(school).toContain('patch("/pay/payments/:id", adminOnly');
    // declared before the first route that uses it
    expect(school.indexOf("const hrDesk")).toBeLessThan(school.indexOf(", hrDesk,"));
  });

  it("does not let HR create an approver's login", () => {
    const allowed = read("../school/staff-roles.ts").match(/HR_MAY_CREATE = \[([^\]]*)\]/)![1];
    for (const role of ["Principal", "VicePrincipal", "InstitutionAdmin", "Accountant", "\"HR\""]) expect(allowed).not.toContain(role);
    expect(read("../school/hr2.service.ts")).toMatch(/assertMayCreate\(actorRole, role/);
  });

  it("leaves HR verification to HR and approval and payment to Finance", () => {
    const pay2 = read("../school/pay2.service.ts");
    expect(pay2).toMatch(/\["Accountant", "Finance", "Principal", "InstitutionAdmin"\]\.includes\(role\)\) throw new HttpError\(403, "Only a finance officer/);
    expect(pay2).toMatch(/Only accounts or the principal can record salary payments/);
    expect(accounts).toMatch(/"\/pay\/approval", hrGate/);
    expect(read("../school/hr4.service.ts")).toMatch(/role === "HR"\) throw new HttpError\(403, "The Principal or Finance rejects/);
  });
});

describe("what the HR screens are sent", () => {
  it("masks a phone number inside the emergency contact, and keeps the name", () => {
    expect(maskPhone("Asha Rao · +91 98491 30522")).toBe("Asha Rao · +91 98••• •••22");
    expect(maskPhone("Brother, no phone")).toBe("Brother, no phone");
  });

  it("never saves a masked number back over the real one", () => {
    expect(read("../school/hr2.service.ts")).toMatch(/!i\.emergency_contact\.includes\("•"\)/);
  });

  it("shows one employee's assignment from this school only, with the bank account masked", () => {
    const pay2 = read("../school/pay2.service.ts");
    expect(pay2).toMatch(/structures\(inst\)\)\.items\.find\(\(x\) => x\.id === id\)/);
    expect(pay2).toMatch(/\.eq\("profile_id", id\)\.eq\("institution_id", inst\)/);
    expect(pay2).toMatch(/bank_account\.slice\(-4\)/);
    expect(read("../school/school.routes.ts")).toContain('get("/pay/assignment/:id", hrDesk');
  });
});

describe("geo-fence rules", () => {
  const rules = { window: "6:30 – 8:15 am" as const, selfie: true, field_anywhere: true, block_mock: true, home_online_days: false };

  it("keeps the earlier behaviour until a school saves rules", () => {
    expect(inWindow(null, "23:00")).toBe(true);
    expect(inWindow({ ...rules, window: "Any time" }, "23:00")).toBe(true);
  });

  it("applies the saved check-in window, ends included", () => {
    expect(inWindow(rules, "06:30")).toBe(true);
    expect(inWindow(rules, "08:15")).toBe(true);
    expect(inWindow(rules, "06:29")).toBe(false);
    expect(inWindow(rules, "08:16")).toBe(false);
  });

  it("treats drivers and attendants as field staff", () => {
    expect(isFieldStaff("Driver")).toBe(true);
    expect(isFieldStaff("Bus attendant")).toBe(true);
    expect(isFieldStaff("TGT")).toBe(false);
  });

  it("saves settings for this school only, from the HR desk", () => {
    const service = read("../school/geo-fence.service.ts");
    expect(service).toMatch(/\.eq\("id", c\.id\)\.eq\("institution_id", inst\)/);
    expect(read("../school/school.routes.ts")).toContain('put(att + "/geo-settings", hrDesk');
  });
});
