import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { termFees } from "./transport-parents.service";

const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");
const service = read("transport-parents.service.ts");

describe("parent updates and fees stay on the signed-in person's school", () => {
  it("filters every read by the school and scopes every write", () => {
    const bad: string[] = [];
    const re = /supabaseAdmin\s*\.from\("(\w+)"\)/g;
    const starts: { i: number; t: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(service))) starts.push({ i: m.index, t: m[1] });
    starts.forEach((s, k) => {
      const seg = service.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : service.length);
      const head = seg.split(/\n\s*\n|\nexport |\n  const |\n  check\(|\n  if /)[0];
      // message and reminder rows carry the school in each row (checked below)
      if (!/institution_id/.test(head) && !/\.insert\((rows\.slice|part\.map)/.test(head)) bad.push(s.t);
    });
    expect(starts.length).toBeGreaterThan(12);
    expect([...new Set(bad)]).toEqual([]);
    expect(service).toMatch(/const rows = \[\.\.\.parents\]\.map\(\(\[student_id, p\]\) => \(\{ institution_id: inst,/);
    expect(service).toMatch(/part\.map\(\(s\) => \(\{ institution_id: inst, student_id: s\.id/);
    expect(service).toMatch(/\.eq\("guardians\.institution_id", inst\)/);
  });

  it("sends texts only when the plan and the provider allow it", () => {
    expect(service).toMatch(/channelState\(mods\)/);
    expect(service).toMatch(/state\[c\]\);\n  if \(blocked\) throw/);
    expect(read("../messaging/messaging.service.ts")).toMatch(/!!t\.provider_template_id && configured\(t\.channel\)/);
  });

  it("reminds a family once a day at most", () => {
    expect(service).toMatch(/s\.reminded_on !== today\(\)/);
  });
});

describe("transport fee by term", () => {
  const due = ["2026-04-10", "2026-08-10", "2026-12-10"];
  it("splits the year, bills the terms that have fallen due, and shows what is paid", () => {
    expect(termFees(27000, [34, 33, 33], due, [9180], "2026-11-25")).toEqual([
      { amount: 9180, paid: 9180, billed: true, state: "Paid" },
      { amount: 8910, paid: 0, billed: true, state: "Overdue" },
      { amount: 8910, paid: 0, billed: false, state: "Not due" },
    ]);
  });
  it("marks part payment and a term due today, and gives the last term the rounding", () => {
    const t = termFees(10000, [33, 33, 34], due, [100, 0, 0], "2026-08-10");
    expect(t.map((x) => x.amount)).toEqual([3300, 3300, 3400]);
    expect(t.map((x) => x.state)).toEqual(["Overdue", "Due", "Not due"]);
    expect(termFees(0, [100], ["2026-04-10"], [], "2026-11-25")[0].state).toBe("");
  });
});
