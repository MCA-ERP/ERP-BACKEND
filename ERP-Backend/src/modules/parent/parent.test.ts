import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * A small in-memory stand-in for the database: two schools, three families. Every filter the services use is applied, so
 * a missing check in a service shows up here as another family's row coming back or being changed.
 */
const h = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, unknown>[]>, writes: [] as { table: string; op: string; rows: Record<string, unknown>[] }[] }));

vi.mock("../../../db/client", () => {
  type Row = Record<string, unknown>;
  const builder = (table: string) => {
    const filters: ((r: Row) => boolean)[] = []; let op: "select" | "insert" | "update" | "upsert" | "delete" = "select"; let payload: Row[] = []; let single = false; let max = Infinity;
    const run = () => {
      const all = (h.tables[table] ??= []);
      let rows: Row[];
      if (op === "insert" || op === "upsert") { rows = payload.map((p, i) => ({ id: `${table}-new-${all.length + i}`, code: "NEW-1", receipt_no: "RCT-NEW", ...p })); all.push(...rows); h.writes.push({ table, op, rows }); }
      else { rows = all.filter((r) => filters.every((f) => f(r))); if (op === "update") { rows.forEach((r) => Object.assign(r, payload[0])); h.writes.push({ table, op, rows }); } }
      rows = rows.slice(0, max);
      return { data: single ? rows[0] ?? null : rows, error: null, count: rows.length };
    };
    const api: Record<string, unknown> = {
      select: () => api, order: () => api, range: () => api,
      limit: (n: number) => { max = n; return api; },
      eq: (c: string, v: unknown) => { if (!c.includes(".")) filters.push((r) => r[c] === v); return api; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return api; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return api; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return api; },
      not: () => api, or: () => api,
      gte: (c: string, v: string) => { filters.push((r) => String(r[c] ?? "") >= v); return api; },
      lte: (c: string, v: string) => { filters.push((r) => String(r[c] ?? "") <= v); return api; },
      like: (c: string, v: string) => { filters.push((r) => String(r[c] ?? "").startsWith(v.replace(/%$/, ""))); return api; },
      ilike: () => api,
      insert: (p: Row | Row[]) => { op = "insert"; payload = Array.isArray(p) ? p : [p]; return api; },
      upsert: (p: Row | Row[]) => { op = "upsert"; payload = Array.isArray(p) ? p : [p]; return api; },
      update: (p: Row) => { op = "update"; payload = [p]; return api; },
      maybeSingle: () => { single = true; return Promise.resolve(run()); },
      single: () => { single = true; return Promise.resolve(run()); },
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return api;
  };
  return { supabaseAdmin: { from: builder }, supabasePublic: { from: builder }, testDbConnection: async () => ({ ok: true }) };
});

import { childOf, family, forFamily } from "./parent-core";
import * as home from "./parent-home.service";
import * as profile from "./parent-profile.service";
import * as learn from "./parent-learning.service";
import * as fees from "./parent-fees.service";
import * as school from "./parent-school.service";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SCHOOL = id(1), OTHER_SCHOOL = id(2);
const REDDY = id(10), RAO = id(11), FAR = id(12);            // signed-in profiles
const G_REDDY = id(20), G_RAO = id(21), G_FAR = id(22);      // guardian records
const AARAV = id(30), DIYA = id(31), ISHAAN = id(32), STRANGER = id(33);
const MODS = ["parent_app", "attendance", "exams", "fees", "transport", "library", "health_welfare", "homework", "certificates", "cafeteria", "notifications"];

beforeEach(() => {
  h.writes.length = 0;
  const guardian = (gid: string, inst: string, me: string, name: string) => ({ id: gid, institution_id: inst, user_profile_id: me, full_name: name, phone: "9000000000", login_status: "Active" });
  const student = (sid: string, inst: string, first: string) => ({ id: sid, institution_id: inst, first_name: first, last_name: "X", registration_no: first, deleted_at: null, date_of_birth: "2013-01-01" });
  h.tables = {
    guardians: [guardian(G_REDDY, SCHOOL, REDDY, "Prakash Reddy"), guardian(G_RAO, SCHOOL, RAO, "Meena Rao"), guardian(G_FAR, OTHER_SCHOOL, FAR, "Far Parent")],
    // the last link is a wrong one across schools: it must never open that child
    student_guardians: [{ guardian_id: G_REDDY, student_id: AARAV, relation: "Father" }, { guardian_id: G_REDDY, student_id: DIYA, relation: "Father" }, { guardian_id: G_RAO, student_id: ISHAAN, relation: "Mother" }, { guardian_id: G_FAR, student_id: STRANGER, relation: "Father" }, { guardian_id: G_REDDY, student_id: STRANGER, relation: "Father" }],
    students: [student(AARAV, SCHOOL, "Aarav"), student(DIYA, SCHOOL, "Diya"), student(ISHAAN, SCHOOL, "Ishaan"), student(STRANGER, OTHER_SCHOOL, "Stranger")],
    fee_payments: [{ id: id(40), institution_id: SCHOOL, student_id: ISHAAN, status: "Paid", created_by: RAO, collected_at: "Online", reference: "order_RAOPAID1" }, { id: id(41), institution_id: SCHOOL, student_id: ISHAAN, status: "Pending", created_by: RAO, collected_at: "Online", reference: "order_RAOOPEN1", receipt_no: "R", total: 10 }],
    parent_messages: [{ id: id(50), institution_id: SCHOOL, guardian_id: G_RAO, student_id: ISHAAN, direction: "out", status: "Delivered", subject: "Private", kind: "message", created_by: id(99) }],
    ptm_slots: [{ id: id(60), session_id: id(61), status: "Booked", student_id: ISHAAN, guardian_id: G_RAO }],
    ptm_sessions: [],
  };
});

const notFound = { status: 404 };

describe("a parent only reaches their own children", () => {
  it("finds the children from the signed-in account, within the school", async () => {
    expect((await family(SCHOOL, REDDY)).children.map((c) => c.id).sort()).toEqual([AARAV, DIYA].sort());
    expect((await family(SCHOOL, RAO)).children.map((c) => c.id)).toEqual([ISHAAN]);
    await expect(family(SCHOOL, FAR)).rejects.toMatchObject({ status: 403 });
    await expect(family(SCHOOL, id(77))).rejects.toMatchObject({ status: 403 });
  });

  it("stops a parent whose app access was switched off", async () => {
    h.tables.guardians[0].login_status = "Inactive";
    await expect(family(SCHOOL, REDDY)).rejects.toMatchObject({ status: 403 });
  });

  it("answers another family's child, and another school's, as not found", async () => {
    await expect(childOf(SCHOOL, REDDY, ISHAAN)).rejects.toMatchObject(notFound);
    await expect(childOf(SCHOOL, REDDY, STRANGER)).rejects.toMatchObject(notFound);
    await expect(childOf(SCHOOL, RAO, AARAV)).rejects.toMatchObject(notFound);
    await expect(childOf(SCHOOL, REDDY, "not-an-id")).rejects.toThrow();
  });

  const reads: [string, () => Promise<unknown>][] = [
    ["dashboard", () => home.dashboard(SCHOOL, REDDY, MODS, "overview", ISHAAN)],
    ["dashboard attendance", () => home.dashboard(SCHOOL, REDDY, MODS, "attendance", ISHAAN)],
    ["dashboard results", () => home.dashboard(SCHOOL, REDDY, MODS, "performance", ISHAAN)],
    ["house points", () => home.housePoints(SCHOOL, REDDY, ISHAAN)],
    ["report cards", () => learn.records(SCHOOL, REDDY, ISHAAN, "report-cards")],
    ["exam seat", () => learn.records(SCHOOL, REDDY, ISHAAN, "seat")],
    ["holistic card", () => learn.records(SCHOOL, REDDY, ISHAAN, "holistic")],
    ["syllabus", () => learn.syllabus(SCHOOL, REDDY, ISHAAN)],
    ["timetable", () => learn.timetable(SCHOOL, REDDY, ISHAAN)],
    ["competitive", () => learn.competitive(SCHOOL, REDDY, ISHAAN)],
    ["attendance", () => learn.attendance(SCHOOL, REDDY, ISHAAN)],
    ["homework", () => learn.homework(SCHOOL, REDDY, ISHAAN)],
    ["online learning", () => learn.online(SCHOOL, REDDY, ISHAAN)],
    ["fees", () => fees.fees(SCHOOL, REDDY, ISHAAN)],
    ["requests", () => school.requests(SCHOOL, REDDY, MODS, ISHAAN)],
    ["messages", () => school.messages(SCHOOL, REDDY, ISHAAN)],
    ["meetings", () => school.ptm(SCHOOL, REDDY, ISHAAN)],
    ["notices", () => school.notices(SCHOOL, REDDY, ISHAAN)],
    ["bus", () => school.transport(SCHOOL, REDDY, ISHAAN)],
    ["health", () => school.health(SCHOOL, REDDY, ISHAAN)],
    ["library", () => school.library(SCHOOL, REDDY, ISHAAN)],
    ["mess", () => school.mess(SCHOOL, REDDY, ISHAAN)],
  ];
  it.each(reads)("refuses to read another child's %s", async (_name, call) => {
    await expect(call()).rejects.toMatchObject(notFound);
  });

  const writes: [string, () => Promise<unknown>][] = [
    ["pay a fee", () => fees.payOrder(SCHOOL, REDDY, { student_id: ISHAAN, line_keys: ["T1:fees"] })],
    ["ask a concession", () => fees.askConcession(SCHOOL, REDDY, { student_id: ISHAAN, ctype: "Sibling", reason: "Please", amount: 100 })],
    ["apply leave", () => school.raise(SCHOOL, REDDY, MODS, { type: "leave", student_id: ISHAAN, leave_type: "Sick leave", from_date: "2099-01-05", to_date: "2099-01-05" })],
    ["ask a certificate", () => school.raise(SCHOOL, REDDY, MODS, { type: "certificate", student_id: ISHAAN, kind: "Bonafide", purpose: "Passport" })],
    ["send a health note", () => school.raise(SCHOOL, REDDY, MODS, { type: "medical", student_id: ISHAAN, kind: "Medical note", details: "A note" })],
    ["message a teacher", () => school.sendMessage(SCHOOL, REDDY, { student_id: ISHAAN, teacher_id: id(99), subject: "Hello", body: "Hello there" })],
    ["book a meeting", () => school.bookSlot(SCHOOL, REDDY, { student_id: ISHAAN, slot_id: id(60) })],
    ["cancel a meeting", () => school.cancelSlot(SCHOOL, REDDY, ISHAAN, id(60))],
    ["raise a help request", () => home.raiseTicket(SCHOOL, REDDY, { student_id: ISHAAN, category: "Fees", subject: "Hello", details: "Hello there" })],
    ["use a privacy right for them", () => profile.useRight(SCHOOL, REDDY, { kind: "Grievance", details: "Details", student_id: ISHAAN })],
  ];
  it.each(writes)("refuses to %s for another child, and writes nothing", async (_name, call) => {
    await expect(call()).rejects.toMatchObject(notFound);
    expect(h.writes).toEqual([]);
  });

  it("does not reach another family's records by their own ids", async () => {
    await expect(fees.feeReceipt(SCHOOL, REDDY, id(40))).rejects.toMatchObject(notFound);
    await expect(school.sendMessage(SCHOOL, REDDY, { student_id: AARAV, reply_to: id(50), body: "Reading yours" })).rejects.toMatchObject(notFound);
    await expect(school.cancelSlot(SCHOOL, REDDY, AARAV, id(60))).rejects.toMatchObject(notFound);
    await school.readMessage(SCHOOL, REDDY, id(50));
    await home.markRead(SCHOOL, REDDY, ["parent_app"], { keys: [id(50)] });
    expect(h.tables.parent_messages[0].status).toBe("Delivered");
    expect(h.tables.ptm_slots[0]).toMatchObject({ status: "Booked", student_id: ISHAAN });
  });

  it("will not confirm another family's payment, even with a correct signature", async () => {
    process.env.RAZORPAY_KEY_SECRET = "test-secret";
    const sig = crypto.createHmac("sha256", "test-secret").update("order_RAOOPEN1|pay_1").digest("hex");
    await expect(fees.payVerify(SCHOOL, REDDY, { razorpay_order_id: "order_RAOOPEN1", razorpay_payment_id: "pay_1", razorpay_signature: sig })).rejects.toMatchObject(notFound);
    expect(h.tables.fee_payments[1].status).toBe("Pending");
  });

  it("marks a fee paid only when the gateway's signature checks out", async () => {
    process.env.RAZORPAY_KEY_SECRET = "test-secret";
    const body = { razorpay_order_id: "order_RAOOPEN1", razorpay_payment_id: "pay_1", razorpay_signature: "0".repeat(64) };
    await expect(fees.payVerify(SCHOOL, RAO, body)).rejects.toMatchObject({ status: 400 });
    expect(h.tables.fee_payments[1].status).toBe("Pending");
    await fees.payVerify(SCHOOL, RAO, { ...body, razorpay_signature: crypto.createHmac("sha256", "test-secret").update("order_RAOOPEN1|pay_1").digest("hex") });
    expect(h.tables.fee_payments[1]).toMatchObject({ status: "Paid", reference: "order_RAOOPEN1 pay_1" });
  });

  it("never takes an amount or a mobile number from the browser", async () => {
    await expect(fees.payOrder(SCHOOL, REDDY, { student_id: AARAV, line_keys: ["T1:fees"], amount: 1 })).rejects.toThrow();
    await expect(profile.saveProfile(SCHOOL, REDDY, { mobile: "9999999999" })).rejects.toThrow();
    await expect(profile.setConsent(SCHOOL, REDDY, { key: "health", choice: "Withdrawn" })).rejects.toThrow();
  });
});

describe("what a family is shown", () => {
  it("matches class audiences to the family's own classes and hides staff ones", () => {
    const kids = [{ grade_name: "Grade 7", section_name: "B" }, { grade_name: "Grade 3", section_name: "A" }];
    expect(forFamily("Everyone", kids)).toBe(true);
    expect(forFamily("Class 7", kids)).toBe(true);
    expect(forFamily("Classes 1 – 5", kids)).toBe(true);
    expect(forFamily("Class 9", kids)).toBe(false);
    expect(forFamily("Teaching staff", kids)).toBe(false);
    expect(forFamily("Parents", kids)).toBe(true);
  });
});

describe("the Parent portal's routes", () => {
  const dir = __dirname;
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  const routes = read("parent.routes.ts");

  it("only lets a Parent in, with the Parent app in the plan", () => {
    expect(routes).toMatch(/parentRouter\.use\(requireRoles\(\.\.\.PARENT_ROLES\)\)/);
    expect(routes).toMatch(/PARENT_ROLES = \["Parent"\]/);
    expect(routes).toMatch(/parentRouter\.use\(any\("parent_app"\)\)/);
    expect(read("../../server.ts")).toMatch(/app\.use\("\/api\/v1\/parent", parentRouter\)/);
  });

  it("takes the school from the session only", () => {
    expect(routes).toMatch(/requireInstitutionId\(req\)/);
    expect(routes).not.toMatch(/institution_id/);
  });

  it.each([["/academics/records", "exams"], ["/fees", "fees"], ["/transport", "transport"], ["/health", "health"], ["/library", "library"], ["/mess", "mess"], ["/homework", "homework"], ["/attendance", "attendance"], ["/messages", "talk"], ["/events", "events"], ["/house-points", "house"]])("gates %s by the plan", (route, gate) => {
    expect(routes).toContain(`parentRouter.get("${route}", ${gate},`);
  });

  it("keeps families out of the staff routes", () => {
    expect(read("../school/school.routes.ts")).toMatch(/schoolRouter\.use\(staffOnly\)/);
    expect(read("../academics/academics.routes.ts")).toMatch(/authGuard, staffOnly/);
  });
});
