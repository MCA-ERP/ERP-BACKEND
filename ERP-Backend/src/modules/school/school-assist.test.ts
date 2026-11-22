import { describe, expect, it } from "vitest";
import { menuFor } from "./school-assist";
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
