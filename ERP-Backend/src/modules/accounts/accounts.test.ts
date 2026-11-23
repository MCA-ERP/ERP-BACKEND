import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/** Reads that are not filtered by institution_id themselves, reviewed by hand: the ids come from rows of this school fetched just before, or the row is an insert whose payload sets institution_id on the line above (invoices, parent notices), or the signed-in person own read mark (profile_id from the session). */
const SCOPED_BY_IDS = new Set(["accounts.service.ts:hr_clearance", "accounts.service.ts:staff_notification_reads", "accounts.service.ts:institutions", "accounts.service.ts:fee_invoices", "accounts.service.ts:parent_messages", "accounts.service.ts:fee_vendors", "accounts.service.ts:acc_accounts", "accounts.service.ts:acc_journal", "accounts.service.ts:acc_bank_marks"]);

describe("the Accounts portal stays on the signed-in accountant's school", () => {
  const dir = __dirname;
  const routes = fs.readFileSync(path.join(dir, "accounts.routes.ts"), "utf8");
  const files = ["accounts.service.ts", "accounts-fees.service.ts", "accounts-billing.service.ts", "accounts-books.service.ts", "accounts-gl.service.ts", "accounts-reports.service.ts"];
  const service = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n\n");

  it("only lets the Accountant role in, and only when the plan has Fee & Finance", () => {
    expect(routes).toMatch(/accountsRouter\.use\(authGuard\)/);
    expect(routes).toMatch(/accountsRouter\.use\(requireRoles\(\.\.\.ACCOUNTS_ROLES\)\)/);
    expect(routes).toMatch(/ACCOUNTS_ROLES = \["Accountant"\]/);
    expect(routes).toMatch(/includes\("fees"\)/);
  });

  it("gates the HR-linked and self-service pages by the plan", () => {
    expect(routes).toMatch(/const hrGate = any\("hr_payroll", "payroll"\)/);
    for (const p of ["/exit-clearance", "/hiring/posts", "/hiring/budget", "/hiring/settlements"]) expect(routes).toMatch(new RegExp(`"${p}[^"]*", hrGate`));
    for (const p of ["/payslips", "/claims"]) expect(routes).toMatch(new RegExp(`"${p}", self`));
  });

  it("takes the school and the person from the session, never from the request", () => {
    expect(routes).toMatch(/req\.user\?\.profileId/);
    expect(routes).not.toMatch(/req\.body\.(profile|staff|owner|institution)_?id/i);
    expect(service).not.toMatch(/input\.institution_id|body\.institution_id/);
  });

  it("filters every read by the school (or by ids found in it) and scopes every write", () => {
    const bad: string[] = [];
    const re = /supabaseAdmin\s*\.from\("(\w+)"\)/g;
    const starts: { i: number; t: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(service))) starts.push({ i: m.index, t: m[1] });
    starts.forEach((s, k) => {
      const seg = service.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : service.length);
      const head = seg.split(/\n\s*\n|\nexport /)[0];
      if (!/institution_id/.test(head) && !SCOPED_BY_IDS.has(`accounts.service.ts:${s.t}`)) bad.push(s.t);
      if (/\.(update|delete)\(/.test(head) && !/\.eq\("(owner_id|profile_id|created_by)"/.test(head)) bad.push(`${s.t}:write-without-owner`);
    });
    expect(bad, bad.join()).toEqual([]);
  });

  it("only writes a task for the signed-in accountant", () => {
    expect(service).toMatch(/owner_id: profile/);
    expect(service).toMatch(/onConflict: "institution_id,owner_id,source_key"/);
  });
});
