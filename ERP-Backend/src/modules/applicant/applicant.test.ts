import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { DOC_TYPES, MAX_FILE } from "./applicant.service";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
const routes = read("applicant.routes.ts");
const service = read("applicant.service.ts");
const account = read("applicant.account.ts");
/** The family's own read marks are keyed by the signed-in profile, not by school. */
const BY_PROFILE = new Set(["applicant_notification_reads", "user_profiles", "institutions", "roles", "fee_structure", "grade_subjects"]);

describe("the Applicant portal stays inside one family of one school", () => {
  it("lets only the Applicant role in, and only when the plan has admissions", () => {
    expect(routes).toMatch(/applicantRouter\.use\(authGuard\)/);
    expect(routes).toMatch(/APPLICANT_ROLES = \["Applicant"\]/);
    expect(routes).toMatch(/includes\("online_admissions"\)/);
    // a Super Admin has no family: the role check does not wave them through the way requireRoles does
    expect(routes).not.toMatch(/requireRoles/);
  });

  it("takes the school and the family from the session, never from the request", () => {
    expect(routes).toMatch(/req\.user\?\.profileId/);
    expect(routes).not.toMatch(/req\.body\.(profile|family|institution)_?id/i);
    expect(routes).not.toMatch(/req\.query\.institution_id/);
    expect(service).not.toMatch(/input.institution_id|body.institution_id|i.institution_id/);
  });

  it("names the school in every query (the staff-side reply also checks the family belongs to it)", () => {
    const bad: string[] = [];
    const re = /supabaseAdmin\s*\.(?:from|storage)\("?(\w[\w-]*)"?\)/g;
    const starts: { i: number; t: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(service))) starts.push({ i: m.index, t: m[1] });
    starts.forEach((s, k) => {
      const seg = service.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : service.length);
      const head = seg.split(/\n\s*\n|\nexport |\n  const |\n  check\(/)[0];
      if (!/institution_id/.test(head) && !BY_PROFILE.has(s.t) && !/\.storage/.test(head) && s.t !== BUCKETISH) bad.push(s.t);
    });
    expect([...new Set(bad)]).toEqual([]);
  });

  it("looks up every id from the client together with the family and the school", () => {
    expect(service).toMatch(/\.eq\("family_id", me\)\.maybeSingle\(\)/);
    for (const fn of ["documentLink", "uploadDocument", "bookAssessment", "acceptOffer", "payVerify", "sendMessage"]) expect(service).toContain(`async function ${fn}(`);
    // payments: the amount is worked out on the server and the gateway signature settles it
    expect(service).toMatch(/verifyCheckoutSignature\(/);
    expect(service).not.toMatch(/amount:\s*i\.amount|i\.amount/);
  });

  it("checks uploads by type, signature and size, and keeps the file in a private bucket", () => {
    expect(MAX_FILE).toBe(5 * 1024 * 1024);
    expect(service).toMatch(/public: false/);
    expect(service).toMatch(/%PDF-/);
    expect(service).toMatch(/Upload a PDF, JPG or PNG file/);
    expect(routes).toMatch(/limit: a\.MAX_FILE/);
  });

  it("asks for seven documents, six of them required", () => {
    expect(DOC_TYPES).toHaveLength(7);
    expect(DOC_TYPES.filter((d) => d.required)).toHaveLength(6);
  });

  it("creates only Applicant accounts from the public page, with the sign-up limited", () => {
    expect(account).toMatch(/role: "Applicant"/);
    expect(routes).toMatch(/applicantSignupLimiter/);
    expect(routes).toMatch(/applicantLinkLimiter/);
  });

  it("lets a family link an office-made application only with its number and mobile", () => {
    expect(account).toMatch(/tail10\(row\.mobile\) !== tail10\(i\.mobile\)/);
    expect(account).toMatch(/row\.family_id && row\.family_id !== me/);
  });
});

const BUCKETISH = "applicant-docs";

describe("every portal's assistant stays in its portal", () => {
  const assist = read("applicant-assist.ts");
  it("the Applicant assistant reads only the family's own records and public admission information, and changes nothing", () => {
    expect(assist).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(assist).toMatch(/scopeRule\("Applicant portal"/);
    // no tool reaches staff, other families or school-wide books
    expect(assist).not.toMatch(/staffThreads|staffSlots|staffReply|meritList|from\("user_profiles"\)/);
    expect(routes).toMatch(/"\/assist\/chat", assistOn/);
  });
  it("the other portals' assistants carry the same scope rule", () => {
    for (const f of ["../teacher/teacher-assist.ts", "../accounts/accounts-assist.ts", "../admissions/admissions-assist.ts", "../school/school-assist.ts"]) expect(read(f)).toMatch(/scopeRule\(/);
  });
});
