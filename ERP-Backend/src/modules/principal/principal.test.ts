import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/** Reads that name the signed-in person (from the session) instead of the school: their own read marks. */
const BY_PROFILE = new Set(["staff_notification_reads"]);

describe("the Principal portal stays on the signed-in Principal's school", () => {
  const dir = __dirname;
  const routes = fs.readFileSync(path.join(dir, "principal.routes.ts"), "utf8");
  const service = ["principal.service.ts", "principal-reviews.service.ts"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join(" ");
  const server = fs.readFileSync(path.join(dir, "../../server.ts"), "utf8");

  it("only lets the Principal in", () => {
    expect(routes).toMatch(/principalRouter\.use\(authGuard\)/);
    expect(routes).toMatch(/principalRouter\.use\(requireRoles\(\.\.\.PRINCIPAL_ROLES\)\)/);
    expect(routes).toMatch(/PRINCIPAL_ROLES = \["Principal"\]/);
    expect(server).toMatch(/app\.use\("\/api\/v1\/principal", principalRouter\)/);
  });

  it("gates self-service by the plan", () => {
    expect(routes).toMatch(/"\/payslips", self/);
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
      const head = seg.split(/\n\s*\n|\nexport |\n  const |\n  check\(/)[0];
      if (!/institution_id/.test(head) && !BY_PROFILE.has(s.t)) bad.push(s.t);
    });
    expect([...new Set(bad)]).toEqual([]);
  });

  it("decides only what is waiting for the Principal, then writes through the record's own service and logs it", () => {
    expect(service).toMatch(/loadItems\(inst, profile, mods, kind\)\)\.find\(\(i\) => i\.id === id\)/);
    expect(service).toMatch(/advance\(inst, id, \{ action \}, role\)/);
    expect(service).toMatch(/decideLeaveStep\(inst, id, \{ action \}, role, profile\)/);
    expect(service).toMatch(/from\("principal_decisions"\)\.insert/);
  });

  it("keeps the Principal's own leave out of their approvals and away from their own decision", () => {
    expect(service).toMatch(/own\.has\(i\.id\)/);
    const hr3 = fs.readFileSync(path.join(dir, "../school/hr3.service.ts"), "utf8");
    expect(hr3).toMatch(/You cannot decide your own leave/);
    expect(hr3).toMatch(/goes to the School Admin/);
  });
});
