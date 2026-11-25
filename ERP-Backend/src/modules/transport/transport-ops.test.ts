import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { askedFor, lateBy, moveStops, usable } from "./transport-ops.service";
import { km, makeStops, plan } from "./planner";
import { runOrder } from "../school/tr2.service";

const service = fs.readFileSync(path.join(__dirname, "transport-ops.service.ts"), "utf8").replace(/\r\n/g, "\n");

describe("the new transport screens stay on the signed-in person's school", () => {
  it("filters every read by the school and scopes every write", () => {
    const bad: string[] = [];
    const re = /supabaseAdmin\s*\.from\(("(\w+)"|[\w.]+)\)/g;
    const starts: { i: number; t: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(service))) starts.push({ i: m.index, t: m[2] ?? m[1] });
    starts.forEach((s, k) => {
      const seg = service.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : service.length);
      const head = seg.split(/\n\s*\n|\nexport |\n  const |\n  check\(|\n  if /)[0];
      // these two write rows built with the school in each row (checked below)
      if (!/institution_id/.test(head) && !/\.(insert\(rows\)|upsert\(list)/.test(head)) bad.push(s.t);
    });
    expect(starts.length).toBeGreaterThan(40);
    expect(bad).toEqual([]);
    expect(service).toMatch(/const rows = i\.stops\.map\(\(s, k\) => \(\{ institution_id: inst,/);
    expect(service).toMatch(/rows\.set\(id, \{ student_id: id, institution_id: inst,/);
  });

  it("checks verification, documents and seats before a route is changed", () => {
    expect(service).toMatch(/d\.police !== "Verified"\) throw/);
    expect(service).toMatch(/a\.police !== "Verified"\) throw/);
    expect(service).toMatch(/v\.block\) throw/);
    expect(service).toMatch(/cur\.used > seats\) throw/);
    expect(service).toMatch(/used >= seats\) throw/);
  });
});

describe("timetable", () => {
  const stops = [{ id: "a", pickup: "07:00", drop: "", offset: null }, { id: "b", pickup: "", drop: "", offset: 20 }, { id: "c", pickup: "", drop: "", offset: null }];
  it("moves stop times with the route, dropping the farthest stop last", () => {
    expect(moveStops(stops, "07:00", { start: "07:10", at_school: "08:00", departure: "14:35" })).toEqual([
      { id: "a", pickup: "07:10", drop: "15:25", offset: 0 },
      { id: "b", pickup: "07:30", drop: "15:05", offset: 20 },
      { id: "c", pickup: "", drop: "", offset: null },
    ]);
  });
  it("orders the afternoon the other way round", () => {
    const l = [{ ord: 1, drop: "15:40" }, { ord: 2, drop: "15:10" }];
    expect(runOrder(l, "Morning").map((x) => x.ord)).toEqual([1, 2]);
    expect(runOrder(l, "Afternoon").map((x) => x.ord)).toEqual([2, 1]);
    expect(runOrder([{ ord: 1 }, { ord: 2 }, { ord: 3 }], "Afternoon").map((x) => x.ord)).toEqual([3, 2, 1]);
  });
  it("measures lateness from the last stop reached, or what was reported", () => {
    expect(lateBy({ startedAt: "15:00", reachedAt: "15:30", reachedDue: "15:18", firstDue: "14:35", reported: 0 })).toBe(12);
    expect(lateBy({ startedAt: "07:14", reachedAt: "", reachedDue: "", firstDue: "07:00", reported: 0 })).toBe(14);
    expect(lateBy({ startedAt: "06:55", reachedAt: "", reachedDue: "", firstDue: "07:00", reported: 5 })).toBe(5);
  });
});

describe("parent requests and seats", () => {
  const rs = [{ id: "r1", name: "Route 1" }, { id: "r10", name: "Route 10" }];
  const ss = [{ id: "s1", route_id: "r1", name: "Indira Nagar" }, { id: "s2", route_id: "r10", name: "JNTU" }];
  it("reads the route and stop a request names", () => {
    expect(askedFor("Route 10 · JNTU", rs, ss)).toMatchObject({ route: { id: "r10" }, stop: { id: "s2" } });
    expect(askedFor("Please move to Indira Nagar from December", rs, ss)).toMatchObject({ route: { id: "r1" }, stop: { id: "s1" } });
    expect(askedFor("Route 1", rs, ss)).toMatchObject({ route: { id: "r1" }, stop: undefined });
    expect(askedFor("a different bus please", rs, ss)).toEqual({ route: undefined, stop: undefined });
  });
  it("keeps two seats free when the school says so", () => {
    expect(usable(24, "As per fitness certificate")).toBe(24);
    expect(usable(24, "Seats minus 2")).toBe(22);
  });
});

describe("route planner", () => {
  const school = { lat: 17.45, lng: 78.35 };
  const homes = Array.from({ length: 60 }, (_, i) => ({ lat: 17.45 + (i % 6) * 0.01 + 0.01, lng: 78.35 + Math.floor(i / 6) * 0.004, area: `Area ${i % 6}` }));
  it("puts homes within walking distance on one stop, never more than a bus holds", () => {
    const s = makeStops(school, homes, 500, 24);
    expect(s.reduce((n, x) => n + x.homes, 0)).toBe(60);
    expect(Math.max(...s.map((x) => x.homes))).toBeLessThanOrEqual(24);
    expect(km(school, school)).toBe(0);
  });
  it("keeps every bus within its seats and the longest ride", () => {
    const p = plan(school, homes, { seats: 24, longest: 50, walk: 500 });
    expect(p.routes.reduce((n, r) => n + r.students, 0)).toBe(60);
    expect(p.routes.every((r) => r.students <= 24)).toBe(true);
    expect(p.routes.every((r) => r.ride <= 50 || r.stops.length === 1)).toBe(true);
    expect(p.buses).toBe(p.routes.length);
    expect(p.routes[0].stops[0].minutes).toBe(0);
  });
});
