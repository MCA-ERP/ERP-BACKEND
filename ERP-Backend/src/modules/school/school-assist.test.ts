import { describe, expect, it } from "vitest";
import { mayUseTool, menuFor } from "./school-assist";
const heads = (s: string) => s.split("\n").filter((l) => !l.startsWith(" "));
describe("assistant follows the school's plan", () => {
  it("shows everything to Super Admin", () => { expect(heads(menuFor(null))).toContain("Hostel Management"); });
  it("drops modules the plan lacks and keeps the rest", () => {
    const h = heads(menuFor(["fees", "student_information", "admissions"]));
    expect(h).toContain("Fee & Finance Management"); expect(h).toContain("Student Management"); expect(h).toContain("Dashboard"); expect(h).toContain("School Settings");
    expect(h).not.toContain("Hostel Management"); expect(h).not.toContain("Transport Management"); expect(h).not.toContain("Payroll Management");
    expect(menuFor(["fees"])).not.toContain("/school/hostel/");
  });
  it("changes straight away when the plan changes", () => { expect(heads(menuFor(["hostel"]))).toContain("Hostel Management"); expect(heads(menuFor([]))).not.toContain("Hostel Management"); });
});

describe("assistant follows the person's role", () => {
  it("keeps money, staff contacts and the audit trail from ordinary staff", () => {
    for (const role of ["Librarian", "Faculty", "CanteenOperator", "TransportManager", "SomeCustomRole", ""]) for (const tool of ["fee_summary", "fees_overdue", "staff", "recent_activity"]) expect(mayUseTool(role, tool)).toBe(false);
  });
  it("gives leaders everything and each office its own area", () => {
    for (const tool of ["fee_summary", "fees_overdue", "staff", "recent_activity", "admissions_summary"]) expect(mayUseTool("InstitutionAdmin", tool)).toBe(true);
    expect(mayUseTool("Accountant", "fees_overdue")).toBe(true); expect(mayUseTool("Accountant", "staff")).toBe(false);
    expect(mayUseTool("HR", "staff")).toBe(true); expect(mayUseTool("Librarian", "students")).toBe(true);
  });
});
