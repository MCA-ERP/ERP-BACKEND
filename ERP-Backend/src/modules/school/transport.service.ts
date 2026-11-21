import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { everyone } from "./fees2.service";
import { feeSettings } from "./fees.service";

/** Transport: routes, stops, drivers, attendants, student allocation and fees. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const time = z.string().regex(/^\d{2}:\d{2}$/, "Use a time like 07:30.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const hm = (t: string | null) => (t ? t.slice(0, 5) : "");
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const own = async (table: string, inst: string, id: string, what: string) => { if (!check(await supabaseAdmin.from(table).select("id").eq("id", id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, `${what} not found.`); };

// ═════════════ routes ═════════════
export async function routes(inst: string) {
  const [r, s, a] = await Promise.all([supabaseAdmin.from("tr_routes").select("id, name, area, distance_km, first_pickup, at_school, status").eq("institution_id", inst).order("name"), supabaseAdmin.from("tr_stops").select("route_id").eq("institution_id", inst), supabaseAdmin.from("tr_allocations").select("route_id").eq("institution_id", inst)]);
  const S = check(s) as { route_id: string }[]; const A = check(a) as { route_id: string | null }[];
  return { items: (check(r) as { id: string; name: string; area: string; distance_km: number; first_pickup: string | null; at_school: string | null; status: string }[]).map((x) => ({ ...x, first_pickup: hm(x.first_pickup), at_school: hm(x.at_school), stops: S.filter((y) => y.route_id === x.id).length, students: A.filter((y) => y.route_id === x.id).length })).sort((a2, b2) => a2.name.localeCompare(b2.name, undefined, { numeric: true })) };
}
export async function addRoute(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the route.").max(60), area: z.string().trim().max(100).optional(), distance_km: z.number().int().min(0).max(500), first_pickup: time.nullable().optional(), at_school: time.nullable().optional() }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("tr_routes").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[]; if (dup.length) throw new HttpError(409, "That route exists.");
  return check(await supabaseAdmin.from("tr_routes").insert({ institution_id: inst, name: i.name, area: i.area ?? "", distance_km: i.distance_km, first_pickup: i.first_pickup ?? null, at_school: i.at_school ?? null }).select("id").single());
}
export async function setRoute(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("tr_routes").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ stops ═════════════
export async function stops(inst: string) {
  const [s, a, r] = await Promise.all([supabaseAdmin.from("tr_stops").select("id, route_id, name, ord, pickup, drop_time, status, rt:route_id(name)").eq("institution_id", inst), supabaseAdmin.from("tr_allocations").select("stop_id").eq("institution_id", inst), routes(inst)]);
  const A = check(a) as { stop_id: string | null }[];
  const items = (check(s) as unknown as { id: string; route_id: string; name: string; ord: number; pickup: string | null; drop_time: string | null; status: string; rt: { name: string } | { name: string }[] | null }[]).map((x) => ({ id: x.id, route_id: x.route_id, name: x.name, route: one(x.rt)?.name ?? "", ord: x.ord, pickup: hm(x.pickup), drop: hm(x.drop_time), status: x.status, students: A.filter((y) => y.stop_id === x.id).length }));
  return { routes: r.items.map((x) => ({ id: x.id, name: x.name })), items: items.sort((p, q) => p.route.localeCompare(q.route, undefined, { numeric: true }) || p.ord - q.ord) };
}
export async function addStop(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the stop.").max(100), route_id: uid, ord: z.number().int().min(1).max(60), pickup: time.nullable().optional(), drop: time.nullable().optional() }).strict().parse(input);
  await own("tr_routes", inst, i.route_id, "Route");
  const dup = check(await supabaseAdmin.from("tr_stops").select("id").eq("route_id", i.route_id).eq("ord", i.ord)) as unknown[]; if (dup.length) throw new HttpError(409, `Stop ${i.ord} already exists on that route.`);
  return check(await supabaseAdmin.from("tr_stops").insert({ institution_id: inst, route_id: i.route_id, name: i.name, ord: i.ord, pickup: i.pickup ?? null, drop_time: i.drop ?? null }).select("id").single());
}
export async function setStop(inst: string, id: string, input: unknown) {
  const i = z.object({ status: z.enum(["Active", "Inactive"]).optional(), pickup: time.nullable().optional(), drop: time.nullable().optional() }).strict().parse(input);
  const row: Record<string, unknown> = {}; if (i.status) row.status = i.status; if (i.pickup !== undefined) row.pickup = i.pickup; if (i.drop !== undefined) row.drop_time = i.drop;
  const r = check(await supabaseAdmin.from("tr_stops").update(row).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function routeDetail(inst: string, id: string) {
  const [r, s] = await Promise.all([routes(inst), stops(inst)]); const x = r.items.find((y) => y.id === id); if (!x) throw new HttpError(404, "Route not found.");
  return { ...x, items: s.items.filter((y) => y.route_id === id) };
}

// ═════════════ drivers and attendants ═════════════
export async function drivers(inst: string) {
  const [d, v] = await Promise.all([supabaseAdmin.from("tr_drivers").select("id, name, licence_no, licence_until, vehicle_id, mobile, police, status, vh:vehicle_id(reg_no)").eq("institution_id", inst).order("name"), supabaseAdmin.from("tr_vehicles").select("id, reg_no").eq("institution_id", inst).order("reg_no")]);
  return { vehicles: check(v) as { id: string; reg_no: string }[], items: (check(d) as unknown as { id: string; name: string; licence_no: string; licence_until: string | null; vehicle_id: string | null; mobile: string | null; police: string; status: string; vh: { reg_no: string } | { reg_no: string }[] | null }[]).map((x) => ({ id: x.id, name: x.name, licence_no: x.licence_no, licence_until: x.licence_until, vehicle_id: x.vehicle_id, vehicle: one(x.vh)?.reg_no ?? "Spare", mobile: x.mobile ?? "", police: x.police, status: x.status })) };
}
export async function addDriver(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the driver.").max(120), licence_no: z.string().trim().toUpperCase().min(5, "Enter the licence number.").max(30), licence_until: date.nullable().optional(), vehicle_id: uid.nullable().optional(), mobile: z.string().trim().max(30).optional(), police: z.enum(["Verified", "Pending"]) }).strict().parse(input);
  if (i.vehicle_id) await own("tr_vehicles", inst, i.vehicle_id, "Vehicle");
  const dup = check(await supabaseAdmin.from("tr_drivers").select("id").eq("institution_id", inst).eq("licence_no", i.licence_no)) as unknown[]; if (dup.length) throw new HttpError(409, "That licence is already registered.");
  return check(await supabaseAdmin.from("tr_drivers").insert({ institution_id: inst, ...i, licence_until: i.licence_until ?? null, vehicle_id: i.vehicle_id ?? null, mobile: i.mobile || null }).select("id").single());
}
export async function setDriver(inst: string, id: string, input: unknown) {
  const i = z.object({ vehicle_id: uid.nullable().optional(), police: z.enum(["Verified", "Pending"]).optional(), status: z.enum(["Active", "Inactive"]).optional() }).strict().parse(input);
  if (i.vehicle_id) await own("tr_vehicles", inst, i.vehicle_id, "Vehicle");
  const r = check(await supabaseAdmin.from("tr_drivers").update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function attendants(inst: string) {
  const [a, r, v] = await Promise.all([supabaseAdmin.from("tr_attendants").select("id, name, route_id, vehicle_id, mobile, shift, status, rt:route_id(name), vh:vehicle_id(reg_no)").eq("institution_id", inst).order("name"), routes(inst), supabaseAdmin.from("tr_vehicles").select("id, reg_no").eq("institution_id", inst).order("reg_no")]);
  return { routes: r.items.map((x) => ({ id: x.id, name: x.name })), vehicles: check(v) as { id: string; reg_no: string }[], items: (check(a) as unknown as { id: string; name: string; mobile: string | null; shift: string; status: string; rt: { name: string } | { name: string }[] | null; vh: { reg_no: string } | { reg_no: string }[] | null }[]).map((x) => ({ id: x.id, name: x.name, route: one(x.rt)?.name ?? "—", vehicle: one(x.vh)?.reg_no ?? "—", mobile: x.mobile ?? "", shift: x.shift, status: x.status })) };
}
export async function addAttendant(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the attendant.").max(120), route_id: uid.nullable().optional(), vehicle_id: uid.nullable().optional(), mobile: z.string().trim().max(30).optional(), shift: z.enum(["Morning + afternoon", "Morning only", "Afternoon only"]) }).strict().parse(input);
  if (i.route_id) await own("tr_routes", inst, i.route_id, "Route"); if (i.vehicle_id) await own("tr_vehicles", inst, i.vehicle_id, "Vehicle");
  return check(await supabaseAdmin.from("tr_attendants").insert({ institution_id: inst, ...i, route_id: i.route_id ?? null, vehicle_id: i.vehicle_id ?? null, mobile: i.mobile || null }).select("id").single());
}
export async function setAttendant(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("tr_attendants").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ student allocation (and the bus fee on the student's fee plan) ═════════════
async function busFee(inst: string) { return check(await supabaseAdmin.from("fee_optional").select("id, amount_year").eq("institution_id", inst).eq("kind", "Transport").eq("status", "Active").order("pos").limit(1)) as { id: string; amount_year: number }[]; }
async function linkFee(inst: string, studentId: string, on: boolean) {
  const f = (await busFee(inst))[0]; if (!f) return;
  const p = check(await supabaseAdmin.from("student_fee_plans").select("student_id").eq("student_id", studentId).maybeSingle());
  if (p) check(await supabaseAdmin.from("student_fee_plans").update({ transport_id: on ? f.id : null }).eq("student_id", studentId).select("student_id"));
  else if (on) check(await supabaseAdmin.from("student_fee_plans").insert({ student_id: studentId, institution_id: inst, transport_id: f.id }).select("student_id"));
}
export async function allocations(inst: string) {
  const [a, ro, r, s, f, set] = await Promise.all([supabaseAdmin.from("tr_allocations").select("student_id, route_id, stop_id, from_on, status").eq("institution_id", inst).order("from_on", { ascending: false }), roster(inst), routes(inst), stops(inst), busFee(inst), feeSettings(inst)]);
  const K = new Map(ro.items.map((x) => [x.id, x])); const per = f[0] ? Math.round(f[0].amount_year / set.terms.length) : 0;
  return { per_term: per, routes: r.items.filter((x) => x.status === "Active").map((x) => ({ id: x.id, name: x.name })), stops: s.items.map((x) => ({ id: x.id, route_id: x.route_id, name: x.name, ord: x.ord })), students: ro.items.filter((x) => x.status === "Enrolled").map((x) => ({ id: x.id, name: x.name, class_label: x.class_label })), items: (check(a) as { student_id: string; route_id: string | null; stop_id: string | null; from_on: string; status: string }[]).map((x) => ({ ...x, student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "", route: r.items.find((y) => y.id === x.route_id)?.name ?? "Not on transport", stop: s.items.find((y) => y.id === x.stop_id)?.name ?? "—", fee_term: per })) };
}
async function checkStop(inst: string, routeId: string, stopId: string | null | undefined) {
  await own("tr_routes", inst, routeId, "Route");
  if (stopId && !check(await supabaseAdmin.from("tr_stops").select("id").eq("id", stopId).eq("route_id", routeId).eq("institution_id", inst).maybeSingle())) throw new HttpError(400, "That stop is not on the chosen route.");
}
export async function assign(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, route_id: uid, stop_id: uid.nullable().optional(), from_on: date }).strict().parse(input);
  if (!(await roster(inst)).items.some((x) => x.id === i.student_id && x.status === "Enrolled")) throw new HttpError(404, "Student not found.");
  await checkStop(inst, i.route_id, i.stop_id);
  check(await supabaseAdmin.from("tr_allocations").upsert({ student_id: i.student_id, institution_id: inst, route_id: i.route_id, stop_id: i.stop_id ?? null, from_on: i.from_on, status: "Active" }, { onConflict: "student_id" }).select("student_id"));
  await linkFee(inst, i.student_id, true);
  return { ok: true, fee_linked: (await busFee(inst)).length > 0 };
}
export async function changeAllocation(inst: string, studentId: string, input: unknown) {
  const i = z.object({ action: z.enum(["request_transfer", "transfer", "assign_stop", "remove"]), route_id: uid.optional(), stop_id: uid.nullable().optional() }).strict().parse(input);
  const a = check(await supabaseAdmin.from("tr_allocations").select("student_id, route_id").eq("student_id", studentId).eq("institution_id", inst).maybeSingle()) as { student_id: string; route_id: string | null } | null; if (!a) throw new HttpError(404, "Not found.");
  if (i.action === "remove") { check(await supabaseAdmin.from("tr_allocations").delete().eq("student_id", studentId).select("student_id")); await linkFee(inst, studentId, false); return { ok: true }; }
  if (i.action === "request_transfer") { check(await supabaseAdmin.from("tr_allocations").update({ status: "Transfer requested" }).eq("student_id", studentId).select("student_id")); return { ok: true }; }
  const route = i.action === "transfer" ? i.route_id : a.route_id; if (!route) throw new HttpError(400, "Choose the new route.");
  await checkStop(inst, route, i.stop_id);
  const row: Record<string, unknown> = { route_id: route, stop_id: i.stop_id ?? null, status: "Active" }; if (i.action === "transfer") row.from_on = today();
  check(await supabaseAdmin.from("tr_allocations").update(row).eq("student_id", studentId).select("student_id"));
  return { ok: true };
}

// ═════════════ transport fees ═════════════
export async function fees(inst: string) {
  const [f, set, al] = await Promise.all([busFee(inst), feeSettings(inst), allocations(inst)]);
  const ids = new Set(al.items.map((x) => x.student_id)); const { rows } = await everyone(inst);
  const pend = rows.filter((x) => ids.has(x.student_id));
  return { annual: f[0]?.amount_year ?? 0, per_term: f[0] ? Math.round(f[0].amount_year / set.terms.length) : 0, terms: set.terms.length, has_fee: f.length > 0, routes: al.routes.length, items: al.items, pending: pend.map((x) => ({ student_id: x.student_id, student: x.student, class_label: x.class_label, father: x.father, mobile: x.mobile, due: x.due, days_overdue: x.days_overdue })) };
}
