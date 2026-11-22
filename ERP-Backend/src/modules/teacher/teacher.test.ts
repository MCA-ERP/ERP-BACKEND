import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { visibleToTeacher } from "./teacher.service";

describe("what a teacher sees on the school calendar", () => {
  const classes = ["Class 7 B", "Class 9 B", "Class 7"];
  it("shows entries for everyone, staff and teachers", () => {
    expect(visibleToTeacher("Everyone", classes)).toBe(true);
    expect(visibleToTeacher("Staff only", classes)).toBe(true);
    expect(visibleToTeacher("All teachers", classes)).toBe(true);
  });
  it("shows a class entry only when the teacher teaches that class", () => {
    expect(visibleToTeacher("Class 7", classes)).toBe(true);
    expect(visibleToTeacher("Class 8", classes)).toBe(false);
  });
  it("hides entries meant only for parents or students", () => {
    expect(visibleToTeacher("Parents", classes)).toBe(false);
  });
});

/** Statements reviewed by hand: the row is proven to belong to this teacher (their homework or assignment) in the lines before, or it is the teacher own profile row (id is the session id). */
const OWNED_BEFOREHAND = new Set(["teacher-work.service.ts:hw_submissions", "teacher-work.service.ts:assignment_submissions", "teacher-me.service.ts:user_profiles", "teacher-online.service.ts:parent_messages", "teacher-exams.service.ts:exam_papers", "teacher-comm.service.ts:ptm_slots", "teacher-leave.service.ts:leave_requests"]);
describe("the Teacher portal stays on the signed-in teacher", () => {
  const dir = __dirname;
  it("only lets teaching roles in", () => {
    const s = fs.readFileSync(path.join(dir, "teacher.routes.ts"), "utf8");
    expect(s).toMatch(/teacherRouter\.use\(authGuard\)/);
    expect(s).toMatch(/teacherRouter\.use\(requireRoles\(\.\.\.TEACHER_ROLES\)\)/);
    expect(s).toMatch(/TEACHER_ROLES = \["Faculty", "ClassTeacher", "HOD"\]/);
  });
  it("never reads a person or a school from the request body or query", () => {
    const s = fs.readFileSync(path.join(dir, "teacher.routes.ts"), "utf8");
    expect(s).not.toMatch(/req\.body\.(profile|staff|teacher)_?id/i);
    expect(s).toMatch(/req\.user\?\.profileId/);
  });
  it("scopes every update and delete to the school and the person", () => {
    const bad: string[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".service.ts"))) {
      const s = fs.readFileSync(path.join(dir, f), "utf8");
      const re = /supabaseAdmin\s*\.from\("(\w+)"\)\.(update|delete)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const seg = s.slice(m.index, s.indexOf(";", m.index));
        if (!seg.includes("institution_id") && !OWNED_BEFOREHAND.has(`${f}:${m[1]}`)) bad.push(`${f}:${m[1]}`);
        const key = `${f}:${m[1]}`;
        if (!/\.eq\("(staff_id|profile_id|rater_id|created_by|substitute_id|teacher_id|given_by|assigned_by|uploaded_by)"/.test(seg) && !OWNED_BEFOREHAND.has(key)) bad.push(`${key}:no-owner`);
      }
    }
    expect(bad).toEqual([]);
  });
});
