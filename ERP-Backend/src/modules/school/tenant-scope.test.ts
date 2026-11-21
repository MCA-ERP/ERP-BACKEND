import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/** Every update/delete by row id in a school service must also filter by institution_id, so one school's admin can never change another school's row.
 *  The list below are statements reviewed by hand: the row was already proven to belong to the school in the lines before, or the table has no institution column. */
const REVIEWED = new Set([
  "academic2.service.ts:grade_subjects", "fees.service.ts:fee_section_overrides", "fees4.service.ts:fee_payments", "hr4.service.ts:hr_clearance", "inv.service.ts:inv_po_lines", "pay.service.ts:pay_run_lines", "pay.service.ts:hr_onboard", "results.service.ts:report_card_runs",
  "student-extra.service.ts:student_enrollments", "student-mgmt.service.ts:student_profiles", "student-mgmt.service.ts:student_guardians", "timetable.service.ts:tt_slots", "transport.service.ts:student_fee_plans", "transport.service.ts:tr_allocations", "lib.service.ts:lib_books", "lib2.service.ts:lib_books", "profile.service.ts:user_profiles",
]);
describe("school services stay inside one institution", () => {
  it("scopes every update/delete", () => {
    const dir = __dirname; const bad: string[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".service.ts"))) {
      const s = fs.readFileSync(path.join(dir, f), "utf8"); const re = /supabaseAdmin\.from\("(\w+)"\)\.(update|delete)\(/g; let m: RegExpExecArray | null;
      while ((m = re.exec(s))) { const end = s.indexOf(";", m.index); const seg = s.slice(m.index, end < 0 ? s.length : end); if (!seg.includes("institution_id") && !seg.includes("institutionId") && !REVIEWED.has(`${f}:${m[1]}`)) bad.push(`${f}:${m[1]}`); }
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});
