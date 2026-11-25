import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { HR_MAY_CREATE, mayCreate, mayManage } from "./staff-roles";

const ROLES = ["InstitutionAdmin", "Chairman", "Principal", "VicePrincipal", "HR", "Accountant", "JuniorAccountant", "Student", "Parent", "Applicant", ...HR_MAY_CREATE];
const can = (actor: string, role: string) => mayCreate(actor, role, ROLES);

describe("who may create which staff login", () => {
  it("keeps senior and approver logins away from the Vice Principal and HR", () => {
    for (const actor of ["VicePrincipal", "HR"]) {
      for (const role of ["InstitutionAdmin", "Chairman", "Principal", "VicePrincipal", "HR", "Accountant", "JuniorAccountant"]) expect(can(actor, role), `${actor} > ${role}`).toBe(false);
      for (const role of HR_MAY_CREATE) expect(can(actor, role), `${actor} > ${role}`).toBe(true);
    }
  });

  it("stops the Principal creating a role above their own", () => {
    expect(can("Principal", "InstitutionAdmin")).toBe(false);
    expect(can("Principal", "Chairman")).toBe(false);
    for (const role of ["Principal", "VicePrincipal", "HR", "Accountant", "Faculty"]) expect(can("Principal", role)).toBe(true);
  });

  it("lets the School Admin create any staff role of the school", () => {
    for (const role of ["InstitutionAdmin", "Principal", "HR", "JuniorAccountant"]) expect(can("InstitutionAdmin", role)).toBe(true);
  });

  it("never creates platform, student, parent or applicant accounts, whoever asks", () => {
    for (const actor of ["SuperAdmin", "InstitutionAdmin", "Principal", "VicePrincipal", "HR"]) {
      for (const role of ["SuperAdmin", "Student", "Parent", "Applicant", "PlatformManager", "SupportAgent"]) expect(can(actor, role), `${actor} > ${role}`).toBe(false);
    }
  });

  it("refuses any other actor", () => {
    for (const actor of ["", "Faculty", "Registrar", "Accountant"]) expect(can(actor, "Faculty")).toBe(false);
  });

  it("is enforced before an account is created", () => {
    const hr2 = fs.readFileSync(path.join(__dirname, "hr2.service.ts"), "utf8");
    const body = hr2.slice(hr2.indexOf("async function makeEmployee"));
    expect(body.indexOf("assertMayCreate(")).toBeGreaterThan(-1);
    expect(body.indexOf("assertMayCreate(")).toBeLessThan(body.indexOf("createUser("));
  });
});

describe("who may turn a staff account on or off", () => {
  it("stops the Vice Principal touching senior or approver accounts", () => {
    for (const role of ["InstitutionAdmin", "Chairman", "Principal", "VicePrincipal", "HR", "Accountant", "JuniorAccountant", ""]) expect(mayManage("VicePrincipal", role), role).toBe(false);
    for (const role of [...HR_MAY_CREATE, "HOD", "Driver"]) expect(mayManage("VicePrincipal", role), role).toBe(true);
  });

  it("stops the Principal touching the School Admin or Chairman", () => {
    expect(mayManage("Principal", "InstitutionAdmin")).toBe(false);
    expect(mayManage("Principal", "Chairman")).toBe(false);
    for (const role of ["VicePrincipal", "HR", "Accountant", "Faculty", "JuniorAccountant"]) expect(mayManage("Principal", role)).toBe(true);
  });

  it("lets the School Admin manage everyone and nobody else manage anyone", () => {
    expect(mayManage("InstitutionAdmin", "Principal")).toBe(true);
    for (const actor of ["", "HR", "Faculty", "Registrar"]) expect(mayManage(actor, "Faculty")).toBe(false);
  });

  it("is enforced before the account is changed", () => {
    const s = fs.readFileSync(path.join(__dirname, "settings2.service.ts"), "utf8");
    const body = s.slice(s.indexOf("export async function setUser"));
    expect(body.indexOf("mayManage(")).toBeGreaterThan(-1);
    expect(body.indexOf("mayManage(")).toBeLessThan(body.indexOf(".update("));
    expect(fs.readFileSync(path.join(__dirname, "school.routes.ts"), "utf8")).toContain("req.user?.profileId, req.user?.role)");
  });
});
