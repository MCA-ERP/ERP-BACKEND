import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("HR cannot change the School Admin's, Principal's or Vice Principal's records", () => {
  const routes = read("school.routes.ts");
  const guarded = (verb: string, url: string) => routes.split("\n").some((l) => l.startsWith(`schoolRouter.${verb}("${url}",`) && l.includes("notSenior("));

  it("protects those three roles", () => {
    expect(read("protected-staff.ts")).toMatch(/SENIOR_ROLES = \["InstitutionAdmin", "Principal", "VicePrincipal"\]/);
  });

  it("guards profile, pay and bank changes", () => {
    for (const [v, u] of [["patch", "/hr/staff/:id"], ["put", "/hr/profile/:id"], ["post", "/hr/profile360/:id/salary"], ["put", "/pay/assign"], ["put", "/pay/assign-employee"], ["put", "/pay/other-deduction/:id"], ["put", "/pay/bank/:id"]]) expect(guarded(v, u), u).toBe(true);
  });

  it("guards every other route that changes one person's record", () => {
    const person = /^schoolRouter\.(post|put|patch|delete)\("(\/hr\/(staff|profile|profile360|qualifications|experience|comp-offs|documents|appraisals|feedback360|competency|cycle\/:id|increments\/:id|exits|clearance|exit-interviews|probation)[^"]*|\/pay\/(assign[^"]*|other-deduction[^"]*|bank[^"]*))", (hrDesk|exitDesk), /;
    const open = routes.split("\n").filter((l) => person.test(l) && !l.includes("notSenior("));
    expect(open).toEqual([]);
  });

  it("also applies to HR's verification queue", () => {
    expect(read("../hr/hr-portal.service.ts").match(/assertHrMayChange\("HR", inst, [a-z]\.(staff|profile)_id\)/g)).toHaveLength(2);
  });

  it("compares own-record ids without regard to capitals", () => {
    expect(routes).toMatch(/\.toLowerCase\(\) !== String\(req\.user\.profileId \?\? ""\)\.toLowerCase\(\)/);
  });
});
