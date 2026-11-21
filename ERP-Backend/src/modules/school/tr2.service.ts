import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { routes, stops } from "./transport.service";

/** Transport operations (trips, driver app, bus attendance, maintenance, settings, planner) and the library's books. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const nowHm = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const ttypeNow = () => (Number(nowHm().slice(0, 2)) >= 12 ? "Afternoon" : "Morning");
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

async function tell(inst: string, studentIds: string[], subject: string, body: string) {
  if (!studentIds.length) return 0;
  const g = check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, relation, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).in("student_id", studentIds)) as { student_id: string; guardian_id: string; relation: string }[];
  const rows = studentIds.flatMap((s) => { const k = g.filter((x) => x.student_id === s); const p = k.find((x) => x.relation === "Father") ?? k[0]; return p ? [{ institution_id: inst, kind: "notification", guardian_id: p.guardian_id, student_id: s, subject, body }] : []; });
  if (rows.length) check(await supabaseAdmin.from("parent_messages").insert(rows).select("id"));
  return rows.length;
}
async function vehicleOf(inst: string, routeName: string) { return (check(await supabaseAdmin.from("tr_vehicles").select("id, reg_no").eq("institution_id", inst).eq("route", routeName).limit(1)) as { id: string; reg_no: string }[])[0] ?? null; }

// ═════════════ trips, live tracking, driver app ═════════════
export async function trips(inst: string) {
  const [t, r] = await Promise.all([supabaseAdmin.from("tr_trips").select("id, code, route_id, ttype, trip_on, started_at, ended_at, status").eq("institution_id", inst).order("trip_on", { ascending: false }).order("code", { ascending: false }).limit(1000), routes(inst)]);
  const veh = check(await supabaseAdmin.from("tr_vehicles").select("reg_no, route").eq("institution_id", inst)) as { reg_no: string; route: string }[];
  return { items: (check(t) as { id: string; code: string; route_id: string; ttype: string; trip_on: string; started_at: string | null; ended_at: string | null; status: string }[]).map((x) => { const rt = r.items.find((y) => y.id === x.route_id); return { ...x, route: rt?.name ?? "", vehicle: veh.find((v) => v.route === rt?.name)?.reg_no ?? "—", started: x.started_at?.slice(0, 5) ?? "", ended: x.ended_at?.slice(0, 5) ?? "", distance_km: rt?.distance_km ?? 0 }; }) };
}
export async function live(inst: string) {
  const type = ttypeNow(); const [r, st, tr, dr, vh] = await Promise.all([routes(inst), stops(inst), supabaseAdmin.from("tr_trips").select("route_id, ttype, status, arrived, started_at").eq("institution_id", inst).eq("trip_on", today()).eq("ttype", type), supabaseAdmin.from("tr_drivers").select("name, vehicle_id").eq("institution_id", inst), supabaseAdmin.from("tr_vehicles").select("id, reg_no, route, status").eq("institution_id", inst)]);
  const T = check(tr) as { route_id: string; status: string; arrived: string[]; started_at: string | null }[]; const D = check(dr) as { name: string; vehicle_id: string | null }[]; const V = check(vh) as { id: string; reg_no: string; route: string; status: string }[];
  const cards = r.items.filter((x) => x.status === "Active").map((x) => { const t = T.find((y) => y.route_id === x.id); const v = V.find((y) => y.route === x.name); const ss = st.items.filter((y) => y.route_id === x.id); const done = t?.arrived.length ?? 0; const late = t?.status === "Delayed" || (t?.status === "Running" && !!x.first_pickup && !!t.started_at && mins(t.started_at) > mins(x.first_pickup) + 10);
    return { route: x.name, vehicle: v?.reg_no ?? "—", driver: D.find((d) => d.vehicle_id === v?.id)?.name ?? "—", state: !t ? "Not started" : t.status === "Completed" ? "Completed" : late ? "Delayed" : "On time", last: done ? ss[done - 1]?.name ?? "" : "", next: ss[done]?.name ?? "", progress: ss.length ? Math.round((done / ss.length) * 100) : 0, running: t?.status === "Running" }; });
  return { type, on_road: cards.filter((c) => c.running).length, routes: cards.length, delayed: cards.filter((c) => c.state === "Delayed").length, maint: V.filter((v) => v.status === "In maintenance").map((v) => v.reg_no), items: cards };
}
export async function driverTrip(inst: string, routeId: string) {
  const [r, s, al] = await Promise.all([routes(inst), stops(inst), supabaseAdmin.from("tr_allocations").select("stop_id").eq("institution_id", inst)]);
  const rt = r.items.find((x) => x.id === routeId); if (!rt) throw new HttpError(404, "Route not found.");
  const type = ttypeNow(); const t = check(await supabaseAdmin.from("tr_trips").select("id, status, arrived").eq("route_id", routeId).eq("trip_on", today()).eq("ttype", type).maybeSingle()) as { id: string; status: string; arrived: string[] } | null;
  const v = await vehicleOf(inst, rt.name); const d = v ? (check(await supabaseAdmin.from("tr_drivers").select("name").eq("vehicle_id", v.id).limit(1)) as { name: string }[])[0] : null;
  const A = check(al) as { stop_id: string | null }[]; const ss = s.items.filter((x) => x.route_id === routeId).map((x) => ({ id: x.id, name: x.name, due: type === "Morning" ? x.pickup : x.drop, students: A.filter((y) => y.stop_id === x.id).length, arrived: !!t?.arrived.includes(x.id) }));
  const alerts = t ? (check(await supabaseAdmin.from("tr_alerts").select("id, stop_name, families, at").eq("trip_id", t.id).order("at", { ascending: false })) as { id: string; stop_name: string; families: number; at: string }[]) : [];
  return { routes: r.items.filter((x) => x.status === "Active").map((x) => ({ id: x.id, name: x.name })), route: rt.name, type, driver: d?.name ?? "", vehicle: v?.reg_no ?? "", trip: t ? { id: t.id, status: t.status } : null, school_due: rt.at_school, stops: ss, alerts };
}
export async function startTrip(inst: string, routeId: string) {
  if (!check(await supabaseAdmin.from("tr_routes").select("id").eq("id", routeId).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Route not found.");
  const type = ttypeNow(); const ex = check(await supabaseAdmin.from("tr_trips").select("id").eq("route_id", routeId).eq("trip_on", today()).eq("ttype", type).maybeSingle()); if (ex) throw new HttpError(409, "That trip has already started.");
  return check(await supabaseAdmin.from("tr_trips").insert({ institution_id: inst, route_id: routeId, ttype: type, started_at: nowHm() }).select("id").single());
}
export async function arrive(inst: string, tripId: string, input: unknown) {
  const { stop_id } = z.object({ stop_id: uid }).strict().parse(input);
  const t = check(await supabaseAdmin.from("tr_trips").select("id, route_id, ttype, status, arrived").eq("id", tripId).eq("institution_id", inst).maybeSingle()) as { id: string; route_id: string; ttype: string; status: string; arrived: string[] } | null; if (!t) throw new HttpError(404, "Trip not found.");
  if (t.status !== "Running") throw new HttpError(409, "That trip is over.");
  const stop = check(await supabaseAdmin.from("tr_stops").select("id, name").eq("id", stop_id).eq("route_id", t.route_id).maybeSingle()) as { id: string; name: string } | null; if (!stop) throw new HttpError(400, "That stop is not on this route.");
  if (t.arrived.includes(stop_id)) throw new HttpError(409, "Already marked arrived.");
  const kids = (check(await supabaseAdmin.from("tr_allocations").select("student_id").eq("stop_id", stop_id)) as { student_id: string }[]).map((x) => x.student_id);
  const sent = await tell(inst, kids, "Bus alert", t.ttype === "Morning" ? `The school bus has reached ${stop.name}.` : `The school bus has reached ${stop.name} to drop your child.`);
  check(await supabaseAdmin.from("tr_alerts").insert({ institution_id: inst, trip_id: tripId, stop_id, stop_name: stop.name, families: sent }).select("id"));
  const arrived = [...t.arrived, stop_id]; const total = (check(await supabaseAdmin.from("tr_stops").select("id").eq("route_id", t.route_id)) as unknown[]).length;
  const row: Record<string, unknown> = { arrived }; if (arrived.length >= total) { const rt = check(await supabaseAdmin.from("tr_routes").select("at_school").eq("id", t.route_id).single()) as { at_school: string | null }; row.ended_at = nowHm(); row.status = t.ttype === "Morning" && rt.at_school && mins(nowHm()) > mins(rt.at_school) + 10 ? "Delayed" : "Completed"; }
  check(await supabaseAdmin.from("tr_trips").update(row).eq("id", tripId).select("id"));
  return { families: sent, done: arrived.length >= total };
}

// ═════════════ bus attendance ═════════════
export async function busRoster(inst: string, routeId: string, ttype: string) {
  const type = z.enum(["Morning", "Afternoon"]).parse(ttype); const d = today();
  const [r, s, al, bd, ro, tr] = await Promise.all([routes(inst), stops(inst), supabaseAdmin.from("tr_allocations").select("student_id, stop_id").eq("institution_id", inst).eq("route_id", routeId), supabaseAdmin.from("tr_boardings").select("student_id, status, at").eq("institution_id", inst).eq("trip_on", d).eq("ttype", type), roster(inst), supabaseAdmin.from("tr_trips").select("id, status, started_at, ended_at").eq("route_id", routeId).eq("trip_on", d).eq("ttype", type).maybeSingle()]);
  const rt = r.items.find((x) => x.id === routeId); if (!rt) throw new HttpError(404, "Route not found.");
  const K = new Map(ro.items.map((x) => [x.id, x])); const B = new Map((check(bd) as { student_id: string; status: string; at: string }[]).map((x) => [x.student_id, x])); const A = check(al) as { student_id: string; stop_id: string | null }[];
  const ss = s.items.filter((x) => x.route_id === routeId).map((x) => ({ id: x.id, name: x.name, time: type === "Morning" ? x.pickup : x.drop, students: A.filter((y) => y.stop_id === x.id).map((y) => ({ id: y.student_id, name: K.get(y.student_id)?.name ?? "", class_label: K.get(y.student_id)?.class_label ?? "", status: B.get(y.student_id)?.status ?? (tr.data ? "Expected" : "Expected"), at: B.get(y.student_id)?.at ?? null })) }));
  const all = ss.flatMap((x) => x.students); const t = tr.data as { id: string; status: string; started_at: string | null; ended_at: string | null } | null;
  return { routes: r.items.filter((x) => x.status === "Active").map((x) => ({ id: x.id, name: x.name })), route: rt.name, type, trip: t ? { status: t.status, started: t.started_at?.slice(0, 5) ?? "", ended: t.ended_at?.slice(0, 5) ?? "" } : null, expected: all.length, boarded: all.filter((x) => x.status.startsWith("Boarded")).length, by_attendant: all.filter((x) => x.status === "Boarded, no card").length, missing: all.filter((x) => ["Missing at stop", "Absent, parent told"].includes(x.status)).length, stops: ss };
}
export async function markBoarding(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, ttype: z.enum(["Morning", "Afternoon"]), status: z.enum(["Boarded", "Boarded, no card", "Missing at stop", "Absent, parent told"]), note: z.string().trim().max(160).optional() }).strict().parse(input);
  const a = check(await supabaseAdmin.from("tr_allocations").select("student_id").eq("student_id", i.student_id).eq("institution_id", inst).maybeSingle()); if (!a) throw new HttpError(404, "That student is not on transport.");
  check(await supabaseAdmin.from("tr_boardings").upsert({ trip_on: today(), ttype: i.ttype, student_id: i.student_id, institution_id: inst, status: i.status, note: i.note ?? null, at: new Date().toISOString() }, { onConflict: "trip_on,ttype,student_id" }).select("student_id"));
  if (["Missing at stop", "Absent, parent told"].includes(i.status)) await tell(inst, [i.student_id], "Bus alert", i.status === "Missing at stop" ? "Your child was not at the stop when the bus arrived. The transport desk will call you." : "Your child was marked absent on the school bus today.");
  return { ok: true };
}
export async function missed(inst: string) {
  const [b, ro, al, s, r] = await Promise.all([supabaseAdmin.from("tr_boardings").select("student_id, ttype, status, note").eq("institution_id", inst).eq("trip_on", today()).in("status", ["Missing at stop", "Absent, parent told"]), roster(inst), supabaseAdmin.from("tr_allocations").select("student_id, route_id, stop_id").eq("institution_id", inst), stops(inst), routes(inst)]);
  const K = new Map(ro.items.map((x) => [x.id, x])); const A = new Map((check(al) as { student_id: string; route_id: string | null; stop_id: string | null }[]).map((x) => [x.student_id, x]));
  return { items: (check(b) as { student_id: string; ttype: string; status: string; note: string | null }[]).map((x) => { const a = A.get(x.student_id); return { student_id: x.student_id, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "", trip: `${r.items.find((y) => y.id === a?.route_id)?.name ?? ""} · ${x.ttype.toLowerCase()}`, stop: s.items.find((y) => y.id === a?.stop_id)?.name ?? "—", status: x.status, resolution: x.note ?? "—" }; }) };
}

// ═════════════ maintenance ═════════════
export async function maintenance(inst: string, type?: string) {
  const [m, v] = await Promise.all([supabaseAdmin.from("tr_maintenance").select("id, vehicle_id, mtype, details, vendor, due_on, cost, status").eq("institution_id", inst).order("due_on", { ascending: false }).limit(1000), supabaseAdmin.from("tr_vehicles").select("id, reg_no").eq("institution_id", inst).order("reg_no")]);
  const V = check(v) as { id: string; reg_no: string }[];
  const items = (check(m) as { id: string; vehicle_id: string; mtype: string; details: string; vendor: string; due_on: string; cost: number; status: string }[]).map((x) => ({ ...x, vehicle: V.find((y) => y.id === x.vehicle_id)?.reg_no ?? "" }));
  return { vehicles: V, items: type ? items.filter((x) => x.mtype === type) : items };
}
export async function addMaintenance(inst: string, input: unknown) {
  const i = z.object({ vehicle_id: uid, mtype: z.enum(["Service schedule", "Repairs", "Insurance"]), details: z.string().trim().max(200).optional(), vendor: z.string().trim().max(100).optional(), due_on: date, cost: z.number().int().min(0).max(10_000_000) }).strict().parse(input);
  if (!check(await supabaseAdmin.from("tr_vehicles").select("id").eq("id", i.vehicle_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Vehicle not found.");
  return check(await supabaseAdmin.from("tr_maintenance").insert({ institution_id: inst, ...i, details: i.details ?? "", vendor: i.vendor ?? "" }).select("id").single());
}
export async function setMaintenance(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Scheduled", "In progress", "Done"]) }).strict().parse(input);
  const m = check(await supabaseAdmin.from("tr_maintenance").select("id, vehicle_id, mtype").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; vehicle_id: string; mtype: string } | null; if (!m) throw new HttpError(404, "Not found.");
  check(await supabaseAdmin.from("tr_maintenance").update({ status }).eq("id", id).select("id"));
  if (m.mtype === "Repairs") check(await supabaseAdmin.from("tr_vehicles").update({ status: status === "In progress" ? "In maintenance" : "Active" }).eq("id", m.vehicle_id).select("id"));
  return { ok: true };
}

// ═════════════ settings and planner ═════════════
const SDEF = { seats_rule: "As per fitness certificate", standing: false, warn_pct: 90, waitlist: true, n_10min: true, n_delay: true, n_board: false, n_speed: true, max_trip_min: 75, pickup_window: "06:20 – 07:40 am", female_attendant: true, stop_change: "Parent request + approval" };
export async function trSettings(inst: string) { const r = check(await supabaseAdmin.from("tr_settings").select("seats_rule, standing, warn_pct, waitlist, n_10min, n_delay, n_board, n_speed, max_trip_min, pickup_window, female_attendant, stop_change").eq("institution_id", inst).maybeSingle()) as typeof SDEF | null; return { options: { seats_rule: ["As per fitness certificate", "Seats minus 2"], warn_pct: [70, 80, 90, 95, 100], stop_change: ["Parent request + approval", "Transport desk only"] }, ...(r ?? SDEF) }; }
export async function saveTrSettings(inst: string, input: unknown) {
  const i = z.object({ seats_rule: z.enum(["As per fitness certificate", "Seats minus 2"]), standing: z.boolean(), warn_pct: z.number().int().min(50).max(100), waitlist: z.boolean(), n_10min: z.boolean(), n_delay: z.boolean(), n_board: z.boolean(), n_speed: z.boolean(), max_trip_min: z.number().int().min(10).max(300), pickup_window: z.string().trim().min(3).max(30), female_attendant: z.boolean(), stop_change: z.enum(["Parent request + approval", "Transport desk only"]) }).strict().parse(input);
  check(await supabaseAdmin.from("tr_settings").upsert({ institution_id: inst, ...i }, { onConflict: "institution_id" }).select("institution_id")); return trSettings(inst);
}
export async function planner(inst: string, seats: number, longest: number) {
  const [r, v] = await Promise.all([routes(inst), supabaseAdmin.from("tr_vehicles").select("route, seats, status").eq("institution_id", inst)]);
  const V = check(v) as { route: string; seats: number; status: string }[];
  const items = r.items.filter((x) => x.status === "Active").map((x) => { const ride = x.first_pickup && x.at_school ? mins(x.at_school) - mins(x.first_pickup) : 0; const have = V.filter((y) => y.route === x.name && y.status === "Active").reduce((n, y) => n + y.seats, 0); const buses = Math.max(1, Math.ceil(x.students / seats)); return { name: x.name, area: x.area, stops: x.stops, students: x.students, seats, have, buses, ride, ok: ride <= longest && x.students <= (have || seats), note: x.students > (have || seats) ? "Over capacity" : ride > longest ? "Ride too long" : "Fits" }; });
  const rides = items.filter((x) => x.ride > 0).map((x) => x.ride);
  return { students: items.reduce((n, x) => n + x.students, 0), buses: items.reduce((n, x) => n + x.buses, 0), km_day: r.items.reduce((n, x) => n + x.distance_km * 4, 0), longest: Math.max(0, ...rides), average: rides.length ? Math.round(rides.reduce((a, b) => a + b, 0) / rides.length) : 0, items };
}

// ═════════════ library: books ═════════════
export async function books(inst: string) {
  const b = check(await supabaseAdmin.from("lib_books").select("id, book_no, title, author, category, publisher, copies, available").eq("institution_id", inst).order("book_no")) as { id: string; book_no: string; title: string; author: string; category: string; publisher: string; copies: number; available: number }[];
  const [cs, ps] = await Promise.all([supabaseAdmin.from("lib_categories").select("name").eq("institution_id", inst).eq("status", "Active"), supabaseAdmin.from("lib_publishers").select("name").eq("institution_id", inst).eq("status", "Active")]);
  return { categories: [...new Set([...(check(cs) as { name: string }[]).map((x) => x.name), ...b.map((x) => x.category).filter(Boolean)])], publishers: [...new Set([...(check(ps) as { name: string }[]).map((x) => x.name), ...b.map((x) => x.publisher).filter(Boolean)])], items: b.map((x) => ({ ...x, status: x.available > 0 ? "Available" : "All issued" })).sort((p, q) => p.book_no.localeCompare(q.book_no, undefined, { numeric: true })) };
}
const bookIn = z.object({ book_no: z.string().trim().min(1, "Enter the book number.").max(20), title: z.string().trim().min(1, "Enter the title.").max(200), author: z.string().trim().max(120).optional(), category: z.string().trim().max(80).optional(), publisher: z.string().trim().max(80).optional(), copies: z.number().int().min(0).max(1000), available: z.number().int().min(0).max(1000) }).strict();
export async function addBook(inst: string, input: unknown) {
  const i = bookIn.parse(input); if (i.available > i.copies) throw new HttpError(400, "Available can't be more than copies.");
  const dup = check(await supabaseAdmin.from("lib_books").select("id").eq("institution_id", inst).ilike("book_no", i.book_no)) as unknown[]; if (dup.length) throw new HttpError(409, "That book number is used.");
  return check(await supabaseAdmin.from("lib_books").insert({ institution_id: inst, ...i, author: i.author ?? "", category: i.category ?? "", publisher: i.publisher ?? "" }).select("id").single());
}
export async function updateBook(inst: string, id: string, input: unknown) {
  const i = bookIn.omit({ book_no: true }).parse(input); if (i.available > i.copies) throw new HttpError(400, "Available can't be more than copies.");
  const r = check(await supabaseAdmin.from("lib_books").update({ ...i, author: i.author ?? "", category: i.category ?? "", publisher: i.publisher ?? "" }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
void one;
