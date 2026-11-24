import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/** Reads that do not name institution_id themselves, reviewed by hand: the signed-in person's own read marks, and rows fetched by ids that were just read from this school. */
const BY_IDS = new Set(["staff_notification_reads", "student_guardians"]);

describe("the Admissions portal stays on the signed-in Admissions Head's school", () => {
  const dir = __dirname;
  const routes = fs.readFileSync(path.join(dir, "admissions.routes.ts"), "utf8");
  const service = ["admissions.service.ts", "admissions-selection.service.ts", "admissions-onboard.service.ts"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n\n");
  const assist = fs.readFileSync(path.join(dir, "admissions-assist.ts"), "utf8");

  it("only lets the Admissions Head in, and only when the plan has Admissions", () => {
    expect(routes).toMatch(/admissionsRouter\.use\(authGuard\)/);
    expect(routes).toMatch(/admissionsRouter\.use\(requireRoles\(\.\.\.ADMISSIONS_ROLES\)\)/);
    expect(routes).toMatch(/ADMISSIONS_ROLES = \["AdmissionsHead"\]/);
    expect(routes).toMatch(/\["admissions", "online_admissions"\]/);
  });

  it("gates self-service and the fee plan by the plan", () => {
    for (const p of ["/payslips", "/claims"]) expect(routes).toMatch(new RegExp(`"${p}", self`));
    for (const p of ["/fee-plans", "/fee-plans/:id"]) expect(routes).toMatch(new RegExp(`"${p}", fees`));
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
      if (!/institution_id/.test(head) && !BY_IDS.has(s.t)) bad.push(s.t);
    });
    expect([...new Set(bad)]).toEqual([]);
  });

  it("never lets a child or family id from the client reach another school's row", () => {
    // every lookup by an id from the URL goes through a function that also names the school
    for (const fn of ["enquiryOf(inst: string, id: string", "createLead(inst: string", "logFollowup(inst: string", "sendApplication(inst: string", "markLost(inst: string", "assignFeePlan(inst: string", "createPortalAccounts(inst: string", "confirmAdmission(inst: string"]) expect(service).toContain(fn);
    expect(service).toMatch(/eq\("id", g\.id\)\.eq\("institution_id", inst\)/);
  });

  it("the assistant changes data only through the service functions", () => {
    expect(assist).not.toMatch(/\.(insert|update|upsert|delete)\(/);
  });
});

describe("the approval chain", () => {
  const fo = fs.readFileSync(path.join(__dirname, "../school/front-office.service.ts"), "utf8");
  const school = fs.readFileSync(path.join(__dirname, "../school/school.routes.ts"), "utf8");
  it("leaves the last level to the Principal or the School Admin and passes the signed-in role", () => {
    expect(fo).toMatch(/3: \["InstitutionAdmin", "Principal", "VicePrincipal"\]/);
    expect(school).toMatch(/fo\.advance\(inst, uuid\(req\), req\.body, req\.user\?\.role\)/);
  });
  it("refuses a full section", () => {
    expect(fo).toMatch(/seated >= sec\.capacity/);
  });
});
