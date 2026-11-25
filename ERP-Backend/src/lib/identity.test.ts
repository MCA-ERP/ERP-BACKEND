import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { aadhaarOk, hideAadhaar, maskAadhaar } from "./identity";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("Aadhaar on admission applications", () => {
  it("keeps only the last four digits", () => {
    expect(maskAadhaar("4105 3432 1778")).toBe("XXXX XXXX 1778");
    expect(maskAadhaar("XXXX XXXX 1778")).toBe("XXXX XXXX 1778");
    expect(maskAadhaar("12")).toBe("");
    expect(hideAadhaar({ dob: "2015-01-01", aadhaar: "410534321778" })).toEqual({ dob: "2015-01-01", aadhaar: "XXXX XXXX 1778" });
    expect(hideAadhaar(null)).toBeNull();
  });
  it("takes a whole number or nothing", () => {
    for (const ok of ["", "410534321778", "4105 3432 1778", "4105-3432-1778"]) expect(aadhaarOk(ok)).toBe(true);
    for (const bad of ["1778", "41053432177", "abcd34321778"]) expect(aadhaarOk(bad)).toBe(false);
  });
  it("is masked when saved and when read", () => {
    const office = read("../modules/school/front-office.service.ts");
    expect(office).toContain("transform(hideAadhaar)");
    expect(office).toContain('name === "adm-applications"');
    expect(office.match(/appRow\(/g)!.length).toBeGreaterThanOrEqual(3);
    expect(read("../modules/admissions/admissions.service.ts")).toContain("details: hideAadhaar(x.details)");
  });
});
