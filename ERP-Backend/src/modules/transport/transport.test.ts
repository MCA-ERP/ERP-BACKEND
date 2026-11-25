import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { DOC_TYPES, MAX_FILE, attentionList, checkScan, clearanceCheck, currentDocs, docState, groupMessages, routeBlock } from "./transport-portal.service";

/** Reads that name the signed-in person (from the session) instead of the school: their own read marks. */
const BY_PROFILE = new Set(["staff_notification_reads"]);
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");

describe("the Transport portal stays on the signed-in person's school", () => {
  const routes = read("transport.routes.ts");
  const service = read("transport-portal.service.ts");
  const school = read("../school/school.routes.ts");
  const server = read("../../server.ts");

  it("only lets the Transport Manager in, and only when the plan has Transport", () => {
    expect(routes).toMatch(/transportRouter\.use\(authGuard\)/);
    expect(routes).toMatch(/TRANSPORT_ROLES = \["TransportManager"\]/);
    expect(routes).toMatch(/transportRouter\.use\(requireRoles\(\.\.\.TRANSPORT_ROLES\)\)/);
    expect(routes).toMatch(/\(u\.modules \?\? \[\]\)\.includes\("transport"\)/);
    expect(server).toMatch(/app\.use\("\/api\/v1\/transport", transportRouter\)/);
  });

  it("gates self-service, exit clearance and the assistant by the plan", () => {
    for (const p of ["payslips", "claims"]) expect(routes).toMatch(new RegExp(`"/${p}", self`));
    expect(routes).toMatch(/"\/exit-clearance", any\("hr_payroll"\)/);
    expect(routes).toMatch(/"\/assist\/chat", any\("school_assistant"\)/);
  });

  it("takes the school and the person from the session, never from the request", () => {
    expect(routes).toMatch(/req\.user\?\.profileId/);
    expect(routes).not.toMatch(/req\.body\.(profile|staff|owner|institution)_?id/i);
    expect(service).not.toMatch(/input\.institution_id|body\.institution_id|\bi\.institution_id/);
  });

  it("filters every read by the school and scopes every write", () => {
    const bad: string[] = [];
    const re = /supabaseAdmin\s*\.from\("(\w+)"\)/g;
    const starts: { i: number; t: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(service))) starts.push({ i: m.index, t: m[1] });
    starts.forEach((s, k) => {
      const seg = service.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : service.length);
      const head = seg.split(/\n\s*\n|\nexport |\n  const |\n  check\(|\n  if /)[0];
      // hr_clearance has no school column: it is read for this school's exits only
      if (!/institution_id/.test(head) && !BY_PROFILE.has(s.t) && s.t !== "hr_clearance") bad.push(s.t);
    });
    expect(starts.length).toBeGreaterThan(10);
    expect([...new Set(bad)]).toEqual([]);
    expect(service).toMatch(/from\("hr_exits"\)\.select\("id, staff_id, last_day"\)\.eq\("institution_id", inst\)/);
  });

  it("lets the manager work the transport records but not the settings", () => {
    expect(school).toMatch(/const trDesk = requireRoles\("InstitutionAdmin", "Principal", "VicePrincipal", "TransportManager"\)/);
    expect(school).toContain('put("/tr/settings", adminOnly');
    expect(school).toContain('post("/tr/vehicles", adminOnly');
    expect(school).toContain('post("/tr/maintenance", adminOnly');
    for (const r of ["vehicles", "drivers", "attendants"]) expect(school).toContain(`patch("/tr/${r}/:id", trDesk, statusOnly`);
    // saves that need the portal's checks are not open here
    for (const r of ['post("/tr/allocations"', 'patch("/tr/allocations/:id"', 'post("/tr/drivers"', 'post("/tr/attendants"', 'post("/tr/routes"', 'post("/tr/stops"']) expect(school).toContain(`${r}, adminOnly`);
    expect(school).toContain('get("/lib/books", adminOnly');
    // declared before the first route that uses it
    expect(school.indexOf("const trDesk")).toBeLessThan(school.indexOf(", trDesk,"));
  });

  it("never lets anyone clear their own exit", () => {
    expect(service).toMatch(/row\.staff_id === profile\) throw new HttpError\(403/);
  });
});

describe("vehicle documents", () => {
  const now = "2026-11-03";
  it("is expired, expiring within 30 days, or valid", () => {
    expect(docState("2026-11-02", now)).toBe("Expired");
    expect(docState("2026-11-03", now)).toBe("Expiring");
    expect(docState("2026-12-03", now)).toBe("Expiring");
    expect(docState("2026-12-04", now)).toBe("Valid");
    expect(docState(null, now)).toBe("No date");
  });

  it("keeps the longest-running paper of each kind, and counts the vehicle's fitness date", () => {
    const docs = currentDocs([{ id: "v", fitness_until: "2027-01-01" }], [
      { id: "a", vehicle_id: "v", doc_type: "insurance", file_name: "", valid_until: "2026-01-01" },
      { id: "b", vehicle_id: "v", doc_type: "Insurance", file_name: "", valid_until: "2027-01-01" },
    ], now);
    expect(docs.map((d) => [d.id, d.doc_type, d.state])).toEqual([["b", "Insurance", "Valid"], [null, "Fitness certificate", "Valid"]]);
  });

  it("gives a route only when every document is in and none has expired", () => {
    const all = DOC_TYPES.map((doc_type) => ({ doc_type, state: "Valid" as const }));
    expect(routeBlock(all)).toBe("");
    expect(routeBlock(all.slice(1))).toContain("Registration (RC)");
    expect(routeBlock(all.map((d) => (d.doc_type === "Permit" ? { ...d, state: "Expired" as const } : d)))).toContain("Permit");
  });

  it("accepts only a PDF, JPG or PNG up to 5 MB, judged by its first bytes", () => {
    const pdf = Buffer.from("%PDF-1.7 test");
    expect(checkScan("application/pdf", pdf).ext).toBe("pdf");
    expect(() => checkScan("image/png", pdf)).toThrow(/PDF, JPG or PNG/);
    expect(() => checkScan("text/html", Buffer.from("<html>"))).toThrow(/PDF, JPG or PNG/);
    expect(() => checkScan("application/pdf", Buffer.concat([pdf, Buffer.alloc(MAX_FILE)]))).toThrow(/5 MB/);
    expect(() => checkScan("application/pdf", Buffer.alloc(0))).toThrow(/Choose a file/);
  });
});

describe("what needs attention", () => {
  it("lists documents, crew and routes", () => {
    const out = attentionList("2026-11-03", {
      items: [{ id: "v5", name: "Bus 5", route: "Route 5", status: "Active" }],
      docs: [{ vehicle_id: "v5", vehicle: "Bus 5", doc_type: "Pollution (PUC)", valid_until: "2026-10-28", state: "Expired" }],
    }, [{ id: "d", name: "Mr. A", status: "Active", police: "Pending", licence_until: "2026-11-25", vehicle_id: "v5" }], [{ id: "a", name: "Mrs. B", status: "Active", police: "Pending" }], ["Route 5", "Route 6"]);
    expect(out.map((x) => x.text)).toEqual(["Pollution (PUC) expired", "licence expires 25 Nov 2026", "police verification pending", "police verification pending", "Bus 5 has an expired document", "no vehicle assigned"]);
    expect(out.map((x) => x.kind)).toEqual(["document", "crew", "crew", "crew", "route", "route"]);
  });
});

describe("sent messages and exit clearance", () => {
  const m = (student_id: string, status = "Delivered", body = "Bus 4 is late") => ({ sent_on: "2026-11-02", created_at: "2026-11-02T01:40:00Z", subject: "Bus update", body, channel: "App", status, student_id });
  const routes = new Map([["s1", "Route 4"], ["s2", "Route 4"], ["s3", "Route 7"]]);
  it("names the route when everyone is on it, and counts delivery", () => {
    expect(groupMessages([m("s1"), m("s2", "Scheduled")], routes, new Map())[0]).toMatchObject({ to: "Route 4 parents", sent: 2, delivered: 1, status: "Partly delivered" });
    expect(groupMessages([m("s1"), m("s3")], routes, new Map())[0].to).toBe("All bus riders");
    expect(groupMessages([m("s1")], routes, new Map([["s1", "Asha"]]))[0].to).toBe("Parent of Asha");
  });

  it("says what a leaver has to hand over", () => {
    expect(clearanceCheck("TS 07 UB 4421", true)).toBe("Bus TS 07 UB 4421, logbook, fuel card");
    expect(clearanceCheck(undefined, false)).toBe("Vehicle and documents handed over");
  });
});
