import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { newOr, saved } from "../school/tr-columns";
import { addAttendant, addDriver, assign, changeAllocation, routes, stops } from "../school/transport.service";
import { runOrder, tripNow, trSettings } from "../school/tr2.service";
import { directory } from "../school/hr.service";
import { roster } from "../school/student-mgmt.service";
import { listRequests, setRequestStatus } from "../school/parent-extra.service";
import { raiseTicket } from "../teacher/teacher.service";
import { docState, fleet, storeFile, fileLink } from "./transport-portal.service";
import { plan, type Home, type Rules } from "./planner";

/**
 * The Transport portal's crew, routes, timings, allocation, requests, assignments, trips and planner screens. They work
 * on the same tables as the School Admin's Transport module, with the checks the portal promises on screen.
 */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 07:30.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const nowHm = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const istHm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const nice = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const hhmm = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
const hm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "");
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
export const SCHOOL = "School (main gate)";
/** A trip this many minutes behind counts as delayed. */
export const LATE_MIN = 10;

// ═════════════ crew ═════════════
interface CrewRow { id: string; name: string; mobile: string | null; status: string; police?: string; licence_no?: string; licence_until?: string | null; vehicle_id?: string | null; route_id?: string | null; experience_years?: number | null; first_aid?: boolean | null; staff_id?: string | null }
async function crewRows(inst: string) {
  const dBase = "id, name, mobile, status, police, licence_no, licence_until, vehicle_id"; const aBase = "id, name, mobile, status, route_id, vehicle_id";
  const [d, a] = await Promise.all([
    newOr<CrewRow>(() => supabaseAdmin.from("tr_drivers").select(dBase + ", experience_years, first_aid, staff_id").eq("institution_id", inst).order("name"), () => supabaseAdmin.from("tr_drivers").select(dBase).eq("institution_id", inst).order("name")),
    newOr<CrewRow>(() => supabaseAdmin.from("tr_attendants").select(aBase + ", police, experience_years, first_aid, staff_id").eq("institution_id", inst).order("name"), () => supabaseAdmin.from("tr_attendants").select(aBase).eq("institution_id", inst).order("name")),
  ]);
  return { drivers: d.rows, attendants: a.rows, upgraded: d.upgraded && a.upgraded };
}

export async function crew(inst: string) {
  const now = today();
  const [c, f, r, docs] = await Promise.all([crewRows(inst), fleet(inst), routes(inst), supabaseAdmin.from("tr_crew_docs").select("id, driver_id, attendant_id, file_name").eq("institution_id", inst).limit(5000)]);
  const D = (docs.error ? [] : docs.data) as { id: string; driver_id: string | null; attendant_id: string | null; file_name: string }[];
  const routeOfVehicle = (id: string | null | undefined) => f.items.find((v) => v.id === id)?.route || "";
  const common = (x: CrewRow) => ({ id: x.id, name: x.name, mobile: x.mobile ?? "", status: x.status, police: x.police ?? "", experience: x.experience_years ?? null, first_aid: x.first_aid ?? null });
  return {
    upgraded: c.upgraded,
    drivers: c.drivers.map((x) => ({ ...common(x), licence_no: x.licence_no ?? "", licence_until: x.licence_until ?? null, licence_state: docState(x.licence_until ?? null, now), route: x.status === "Active" ? routeOfVehicle(x.vehicle_id) || "Spare" : "Inactive", files: D.filter((d) => d.driver_id === x.id).map((d) => ({ id: d.id, name: d.file_name })) })),
    attendants: c.attendants.map((x) => ({ ...common(x), route: x.status === "Active" ? r.items.find((y) => y.id === x.route_id)?.name ?? "Spare" : "Inactive", files: D.filter((d) => d.attendant_id === x.id).map((d) => ({ id: d.id, name: d.file_name })) })),
  };
}

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);
/** The HR record of the same person: the one active staff member with this mobile number. */
async function staffByMobile(inst: string, mobile: string) {
  if (digits(mobile).length !== 10) return null;
  const hit = (await directory(inst)).items.filter((s) => s.status === "Active" && digits(s.mobile) === digits(mobile));
  return hit.length === 1 ? hit[0].id : null;
}

export async function registerCrew(inst: string, input: unknown) {
  const i = z.object({
    role: z.enum(["Driver", "Attendant"]), name: z.string().trim().min(2, "Enter the full name.").max(120), mobile: z.string().trim().min(10, "Enter the mobile number.").max(20),
    licence_no: z.string().trim().max(30).optional(), licence_until: date.nullable().optional(),
    experience_years: z.number().int().min(0).max(60), first_aid: z.boolean(), police: z.enum(["Verified", "Pending"]),
  }).strict().parse(input);
  if (digits(i.mobile).length !== 10) throw new HttpError(400, "Enter a 10-digit mobile number.");
  if (i.role === "Driver" && (!i.licence_no || i.licence_no.length < 5 || !i.licence_until)) throw new HttpError(400, "A driver needs a licence number and its valid-till date.");
  // the new columns must exist before anything is written
  saved(await supabaseAdmin.from("tr_attendants").select("experience_years, first_aid, staff_id").eq("institution_id", inst).limit(1));
  const staff = await staffByMobile(inst, i.mobile);
  const table = i.role === "Driver" ? "tr_drivers" : "tr_attendants";
  const used = staff ? ((await supabaseAdmin.from(table).select("id").eq("institution_id", inst).eq("staff_id", staff)).data?.length ?? 0) > 0 : false;
  const made = (i.role === "Driver"
    ? await addDriver(inst, { name: i.name, licence_no: i.licence_no, licence_until: i.licence_until, mobile: i.mobile, police: i.police, ...(staff && !used ? { staff_id: staff } : {}) })
    : await addAttendant(inst, { name: i.name, mobile: i.mobile, shift: "Morning + afternoon", police: i.police, ...(staff && !used ? { staff_id: staff } : {}) })) as { id: string };
  saved(await supabaseAdmin.from(table).update({ experience_years: i.experience_years, first_aid: i.first_aid }).eq("id", made.id).eq("institution_id", inst).select("id"));
  return { id: made.id, staff_linked: !!staff && !used };
}

const crewTable = (role: string) => { if (role === "driver") return { table: "tr_drivers" as const, column: "driver_id" as const }; if (role === "attendant") return { table: "tr_attendants" as const, column: "attendant_id" as const }; throw new HttpError(404, "Not found."); };
async function ownCrew(inst: string, table: "tr_drivers" | "tr_attendants", id: string) {
  if (!check(await supabaseAdmin.from(table).select("id").eq("id", uid.parse(id)).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Not found.");
}
export async function verifyPolice(inst: string, role: string, id: string) {
  const t = crewTable(role); await ownCrew(inst, t.table, id);
  saved(await supabaseAdmin.from(t.table).update({ police: "Verified" }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}
export async function updateLicence(inst: string, id: string, input: unknown) {
  const i = z.object({ licence_until: date }).strict().parse(input);
  if (i.licence_until < today()) throw new HttpError(400, "The new date has already passed.");
  await ownCrew(inst, "tr_drivers", id);
  check(await supabaseAdmin.from("tr_drivers").update({ licence_until: i.licence_until }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}
export async function uploadCrewFile(inst: string, role: string, id: string, fileName: string, mime: string, data: Buffer) {
  const t = crewTable(role); await ownCrew(inst, t.table, id);
  saved(await supabaseAdmin.from("tr_crew_docs").select("id").eq("institution_id", inst).limit(1));
  const f = await storeFile(`${inst}/crew/${id}`, fileName, mime, data);
  check(await supabaseAdmin.from("tr_crew_docs").insert({ institution_id: inst, [t.column]: id, file_name: f.name, storage_path: f.path, mime: f.mime }).select("id"));
  return { ok: true };
}
export async function crewFileLink(inst: string, id: string) {
  const d = saved<{ storage_path: string } | null>(await supabaseAdmin.from("tr_crew_docs").select("storage_path").eq("id", uid.parse(id)).eq("institution_id", inst).maybeSingle());
  if (!d) throw new HttpError(404, "Document not found.");
  return fileLink(d.storage_path);
}

// ═════════════ routes, stops and timings ═════════════
interface RouteTime { id: string; departure: string | null }
async function network(inst: string) {
  const [r, s, dep, off] = await Promise.all([
    routes(inst), stops(inst),
    newOr<RouteTime>(() => supabaseAdmin.from("tr_routes").select("id, departure").eq("institution_id", inst), () => supabaseAdmin.from("tr_routes").select("id").eq("institution_id", inst)),
    newOr<{ id: string; offset_min: number | null }>(() => supabaseAdmin.from("tr_stops").select("id, offset_min").eq("institution_id", inst), () => supabaseAdmin.from("tr_stops").select("id").eq("institution_id", inst)),
  ]);
  const D = new Map(dep.rows.map((x) => [x.id, hm(x.departure)])); const O = new Map(off.rows.map((x) => [x.id, x.offset_min ?? null]));
  return { upgraded: dep.upgraded && off.upgraded, routes: r.items.map((x) => ({ ...x, departure: D.get(x.id) ?? "" })), stops: s.items.map((x) => ({ ...x, offset: O.get(x.id) ?? null })) };
}

export async function routeBook(inst: string) {
  const [n, f] = await Promise.all([network(inst), fleet(inst)]);
  const bus = (route: string) => { const on = f.items.filter((v) => v.route === route); return (on.find((v) => v.status === "Active") ?? on[0])?.name ?? ""; };
  return {
    routes: n.routes.map((r) => ({ id: r.id, name: r.name, area: r.area, stops: r.stops, distance_km: r.distance_km, students: r.students, vehicle: bus(r.name), status: r.status })),
    stops: n.routes.filter((r) => r.status === "Active").flatMap((r) => {
      const mine = n.stops.filter((s) => s.route_id === r.id);
      return [...mine.map((s, k) => ({ id: s.id, route: r.name, number: k + 1, name: s.name, children: s.students as number | null })), { id: `school:${r.id}`, route: r.name, number: mine.length + 1, name: SCHOOL, children: null }];
    }),
    next_name: `Route ${n.routes.reduce((m, r) => Math.max(m, Number(r.name.match(/^route\s+(\d+)$/i)?.[1] ?? 0)), 0) + 1}`,
  };
}

export async function createRoute(inst: string, input: unknown) {
  const i = z.object({
    name: z.string().trim().min(2, "Enter the route name.").max(60), area: z.string().trim().max(100), distance_km: z.number().int().min(0).max(500),
    stops: z.array(z.object({ name: z.string().trim().min(2, "Enter each stop's name.").max(100), minutes: z.number().int().min(0).max(300) }).strict()).min(1, "Add at least one stop.").max(60),
  }).strict().parse(input);
  if (i.stops.some((s, k) => k > 0 && s.minutes <= i.stops[k - 1].minutes)) throw new HttpError(400, "Each stop's minutes must be more than the stop before it.");
  saved(await supabaseAdmin.from("tr_stops").select("offset_min").eq("institution_id", inst).limit(1));
  if ((await routes(inst)).items.some((r) => r.name.toLowerCase() === i.name.toLowerCase())) throw new HttpError(409, "That route exists.");
  const r = check(await supabaseAdmin.from("tr_routes").insert({ institution_id: inst, name: i.name, area: i.area, distance_km: i.distance_km }).select("id").single()) as { id: string };
  const rows = i.stops.map((s, k) => ({ institution_id: inst, route_id: r.id, name: s.name, ord: k + 1, offset_min: s.minutes }));
  const made = await supabaseAdmin.from("tr_stops").insert(rows).select("id");
  if (made.error) { await supabaseAdmin.from("tr_routes").delete().eq("id", r.id).eq("institution_id", inst); throw new HttpError(500, made.error.message); }
  return { id: r.id };
}
/** A route the planner drafted is put into use. */
export async function activateRoute(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("tr_routes").update({ status: "Active" }).eq("id", uid.parse(id)).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Route not found."); return { ok: true };
}

/** When school starts: the first period of the school's timetable. Buses should be in five minutes before. */
async function schoolStarts(inst: string) {
  const p = check(await supabaseAdmin.from("tt_periods").select("starts").eq("institution_id", inst).order("starts").limit(1)) as { starts: string }[];
  const starts = hm(p[0]?.starts);
  return { starts, reach_by: starts ? hhmm(mins(starts) - 5) : "" };
}

export interface StopTime { id: string; pickup: string; drop: string; offset: number | null }
/** Stop times move with the route: pickups from the morning start, drops from the departure, farthest stop last. */
export function moveStops(list: StopTime[], oldStart: string, t: { start: string; at_school: string; departure: string }) {
  const base = list.find((s) => s.pickup)?.pickup ?? "";
  return list.map((s) => {
    const from = oldStart || base;
    const offset = s.offset ?? (s.pickup && from ? mins(s.pickup) - mins(from) : null);
    if (offset === null || offset < 0) return { id: s.id, pickup: s.pickup, drop: s.drop, offset: s.offset };
    const pickup = mins(t.start) + offset;
    return { id: s.id, pickup: hhmm(pickup), drop: hhmm(mins(t.departure) + Math.max(0, mins(t.at_school) - pickup)), offset };
  });
}

export async function timings(inst: string) {
  const [n, s] = await Promise.all([network(inst), schoolStarts(inst)]);
  return {
    ...s,
    routes: n.routes.filter((r) => r.status === "Active").map((r) => {
      const mine = n.stops.filter((x) => x.route_id === r.id);
      return { id: r.id, name: r.name, area: r.area, start: r.first_pickup, at_school: r.at_school, departure: r.departure, last_drop: mine.map((x) => x.drop).filter(Boolean).sort().pop() ?? "", stops: [...mine.map((x) => ({ id: x.id, name: x.name, pickup: x.pickup, drop: x.drop })), { id: `school:${r.id}`, name: SCHOOL, pickup: r.at_school, drop: r.departure }] };
    }),
  };
}

export async function saveTimings(inst: string, routeId: string, input: unknown) {
  const i = z.object({ start: time, at_school: time, departure: time }).strict().parse(input);
  if (i.at_school <= i.start) throw new HttpError(400, "The bus must reach school after it starts.");
  if (i.departure <= i.at_school) throw new HttpError(400, "The bus leaves school after it arrives.");
  const [n, school] = await Promise.all([network(inst), schoolStarts(inst)]);
  const r = n.routes.find((x) => x.id === uid.parse(routeId)); if (!r) throw new HttpError(404, "Route not found.");
  if (school.reach_by && i.at_school > school.reach_by) throw new HttpError(409, `School starts at ${school.starts}: every route must reach school by ${school.reach_by}.`);
  saved(await supabaseAdmin.from("tr_routes").select("departure").eq("institution_id", inst).limit(1));
  const moved = moveStops(n.stops.filter((x) => x.route_id === r.id), r.first_pickup, i);
  const late = moved.find((s) => s.pickup && s.pickup >= i.at_school);
  if (late) throw new HttpError(409, "A stop would be picked up after the bus reaches school. Allow more time between the start and arrival.");
  saved(await supabaseAdmin.from("tr_routes").update({ first_pickup: i.start, at_school: i.at_school, departure: i.departure }).eq("id", r.id).eq("institution_id", inst).select("id"));
  for (const s of moved) saved(await supabaseAdmin.from("tr_stops").update({ pickup: s.pickup || null, drop_time: s.drop || null, offset_min: s.offset }).eq("id", s.id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ student allocation ═════════════
/** Seats a bus may fill, under the school's capacity rule. */
export const usable = (seats: number, rule: string) => Math.max(0, seats - (rule === "Seats minus 2" ? 2 : 0));
async function capacity(inst: string) {
  const [f, s, al] = await Promise.all([fleet(inst), trSettings(inst), supabaseAdmin.from("tr_allocations").select("student_id, route_id, stop_id").eq("institution_id", inst).limit(20000)]);
  const A = check(al) as { student_id: string; route_id: string | null; stop_id: string | null }[];
  const of = (route: string) => f.items.filter((v) => v.route === route && v.status === "Active").reduce((n, v) => n + usable(v.seats, s.seats_rule), 0);
  return { A, of, rule: s.seats_rule };
}

export async function studentBoard(inst: string) {
  const [n, ro, cap] = await Promise.all([network(inst), roster(inst), capacity(inst)]);
  const A = new Map(cap.A.map((x) => [x.student_id, x]));
  const active = n.routes.filter((r) => r.status === "Active");
  const left = new Map(active.map((r) => { const seats = cap.of(r.name); return [r.id, seats ? Math.max(0, seats - cap.A.filter((x) => x.route_id === r.id).length) : null]; }));
  const students = ro.items.filter((x) => x.status === "Enrolled").map((x) => {
    const a = A.get(x.id); const r = n.routes.find((y) => y.id === a?.route_id); const s = n.stops.find((y) => y.id === a?.stop_id);
    return { id: x.id, name: x.name, class_label: x.class_label, admission_no: x.registration_no ?? "", route_id: r?.id ?? "", route: r?.name ?? "", stop_id: s?.id ?? "", stop: s?.name ?? "", pickup: s?.pickup ?? "", drop: s?.drop ?? "" };
  }).sort((a, b) => Number(!a.route) - Number(!b.route) || byName(a.name, b.name));
  const options = active.flatMap((r) => { const mine = n.stops.filter((s) => s.route_id === r.id && s.status === "Active"); return (mine.length ? mine : [{ id: "", name: "No stop yet" }]).map((s) => ({ route_id: r.id, route: r.name, stop_id: s.id, stop: s.name, seats_left: left.get(r.id) ?? null })); });
  return { students, options };
}

/** Put a student on a route and stop, or take them off transport. The bus fee follows on their fee plan. */
export async function allocate(inst: string, studentId: string, input: unknown) {
  const i = z.object({ route_id: uid.nullable(), stop_id: uid.nullable().optional() }).strict().parse(input);
  const sid = uid.parse(studentId);
  const cap = await capacity(inst);
  const cur = cap.A.find((x) => x.student_id === sid);
  if (!i.route_id) { if (cur) await changeAllocation(inst, sid, { action: "remove" }); return { ok: true, fee_linked: false }; }
  const r = (await routes(inst)).items.find((x) => x.id === i.route_id); if (!r) throw new HttpError(404, "Route not found.");
  if (cur?.route_id === r.id) { await changeAllocation(inst, sid, { action: "assign_stop", stop_id: i.stop_id ?? null }); return { ok: true, fee_linked: true }; }
  const seats = cap.of(r.name); const used = cap.A.filter((x) => x.route_id === r.id && x.student_id !== sid).length;
  if (seats && used >= seats) throw new HttpError(409, `${r.name} has no seats left (${used} of ${seats} taken).`);
  const res = await assign(inst, { student_id: sid, route_id: r.id, stop_id: i.stop_id ?? null, from_on: today() });
  return { ok: true, fee_linked: res.fee_linked };
}

// ═════════════ requests from parents ═════════════
export const REQUEST_TYPES = ["New transport", "Stop change", "Route transfer"] as const;
/** The route and stop a request names, e.g. "Route 3 · Indira Nagar". */
export function askedFor<R extends { id: string; name: string }, S extends { id: string; route_id: string; name: string }>(text: string, rs: R[], ss: S[]) {
  const t = text.toLowerCase(); const esc = (x: string) => x.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = rs.filter((r) => new RegExp(`(^|[^a-z0-9])${esc(r.name)}($|[^a-z0-9])`).test(t));
  const found = ss.filter((s) => (named.length ? named.some((r) => r.id === s.route_id) : true) && t.includes(s.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length);
  const stop = found.length && (named.length || new Set(found.map((s) => s.route_id)).size === 1) ? found[0] : undefined;
  const route = stop ? rs.find((r) => r.id === stop.route_id) : named.length === 1 ? named[0] : undefined;
  return { route, stop };
}

export async function parentRequests(inst: string) {
  const [n, ro, typed, al, apps] = await Promise.all([
    network(inst), roster(inst), listRequests(inst, "other"),
    supabaseAdmin.from("tr_allocations").select("student_id, route_id, stop_id, status, from_on").eq("institution_id", inst).limit(20000),
    supabaseAdmin.from("adm_applications").select("code, admission_no, details, applied_on").eq("institution_id", inst).not("admission_no", "is", null).eq("details->>transport", "Yes").order("applied_on", { ascending: false }).limit(1000),
  ]);
  const A = new Map((check(al) as { student_id: string; route_id: string | null; stop_id: string | null; status: string; from_on: string }[]).map((x) => [x.student_id, x]));
  const S = new Map(ro.items.map((x) => [x.id, x]));
  const place = (r?: { name: string }, s?: { name: string }) => [r?.name, s?.name].filter(Boolean).join(" · ");
  const now = (sid: string) => { const a = A.get(sid); return place(n.routes.find((r) => r.id === a?.route_id), n.stops.find((s) => s.id === a?.stop_id)); };
  const who = (sid: string) => ({ student_id: sid, student: S.get(sid)?.name ?? "", class_label: S.get(sid)?.class_label ?? "", admission_no: S.get(sid)?.registration_no ?? "" });
  const row = (source: "parent" | "transfer" | "admission", id: string, code: string, type: string, sid: string, asked: string, received: string, status: string) => {
    const found = askedFor(asked, n.routes, n.stops);
    return { source, id, code, type, ...who(sid), now: now(sid), asked: place(found.route, found.stop) || asked, route_id: found.route?.id ?? "", stop_id: found.stop?.id ?? "", received, status };
  };
  const out = [
    ...typed.items.filter((x) => (REQUEST_TYPES as readonly string[]).includes(x.req_type) && x.student_id).map((x) => row("parent", x.id, x.code, x.req_type, x.student_id!, x.details, x.raised_on, x.status)),
    ...[...A.values()].filter((a) => a.status === "Transfer requested").map((a) => row("transfer", a.student_id, "Transfer", "Route transfer", a.student_id, "", a.from_on, "Pending")),
    ...(check(apps) as { code: string; admission_no: string; details: Record<string, string> | null; applied_on: string }[]).flatMap((x) => {
      const s = ro.items.find((y) => y.registration_no === x.admission_no && y.status === "Enrolled");
      return s && !A.has(s.id) ? [row("admission", s.id, x.code, "New transport", s.id, x.details?.transport_stop ?? "", x.applied_on, "Pending")] : [];
    }),
  ];
  return { items: out.sort((a, b) => Number(a.status !== "Pending") - Number(b.status !== "Pending") || b.received.localeCompare(a.received)) };
}

/** Tell the family what was decided. */
async function replyToFamily(inst: string, studentId: string | null, guardianId: string | null, body: string, by: string) {
  let g = guardianId;
  if (!g && studentId) {
    const k = check(await supabaseAdmin.from("student_guardians").select("guardian_id, relation, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).eq("student_id", studentId)) as { guardian_id: string; relation: string }[];
    g = (k.find((x) => x.relation === "Father") ?? k[0])?.guardian_id ?? null;
  }
  if (g) check(await supabaseAdmin.from("parent_messages").insert({ institution_id: inst, kind: "notification", guardian_id: g, student_id: studentId, subject: "Transport request", body, channel: "App", created_by: by }).select("id"));
}

export async function decideParentRequest(inst: string, me: string, input: unknown) {
  const i = z.object({ source: z.enum(["parent", "transfer", "admission"]), id: uid, status: z.enum(["Approved", "Rejected"]), route_id: uid.optional(), stop_id: uid.nullable().optional() }).strict().parse(input);
  const item = (await parentRequests(inst)).items.find((x) => x.source === i.source && x.id === i.id);
  if (!item) throw new HttpError(404, "Request not found.");
  if (item.status !== "Pending") throw new HttpError(409, "This request is already closed.");
  if (i.status === "Rejected") {
    if (i.source === "admission") throw new HttpError(409, "An admission's transport need stays until the student is allocated.");
    if (i.source === "transfer") check(await supabaseAdmin.from("tr_allocations").update({ status: "Active" }).eq("student_id", i.id).eq("institution_id", inst).select("student_id"));
    else await setRequestStatus(inst, i.id, { status: "Rejected" });
    await replyToFamily(inst, item.student_id, null, `Your transport request (${item.type.toLowerCase()}) was not approved. Please contact the transport office.`, me);
    return { ok: true };
  }
  const route = i.route_id ?? item.route_id; if (!route) throw new HttpError(400, "Choose the route and stop.");
  const stop = i.stop_id !== undefined ? i.stop_id : item.stop_id || null;
  await allocate(inst, item.student_id, { route_id: route, stop_id: stop });
  if (i.source === "transfer") check(await supabaseAdmin.from("tr_allocations").update({ status: "Active" }).eq("student_id", item.student_id).eq("institution_id", inst).select("student_id"));
  if (i.source === "parent") await setRequestStatus(inst, i.id, { status: "Approved" });
  const n = await network(inst);
  await replyToFamily(inst, item.student_id, null, `Your transport request is approved: ${[n.routes.find((r) => r.id === route)?.name, n.stops.find((s) => s.id === stop)?.name].filter(Boolean).join(" · ")}.`, me);
  return { ok: true };
}

export async function appRequests(inst: string) { return { items: (await listRequests(inst, "app")).items.filter((x) => x.req_type === "Transport change") }; }
export async function decideAppRequest(inst: string, me: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Approved", "Declined"]) }).strict().parse(input);
  const item = (await appRequests(inst)).items.find((x) => x.id === id);
  if (!item) throw new HttpError(404, "Request not found.");
  await setRequestStatus(inst, id, { status });
  const g = check(await supabaseAdmin.from("parent_requests").select("guardian_id").eq("id", id).eq("institution_id", inst).maybeSingle()) as { guardian_id: string } | null;
  await replyToFamily(inst, item.student_id, g?.guardian_id ?? null, `Your transport request ${item.code} was ${status.toLowerCase()}.`, me);
  return { ok: true };
}

// ═════════════ vehicle, driver and attendant of each route ═════════════
export async function assignments(inst: string) {
  const [f, c, r, cap] = await Promise.all([fleet(inst), crewRows(inst), routes(inst), capacity(inst)]);
  const now = today();
  const active = r.items.filter((x) => x.status === "Active");
  const rows = active.map((x) => {
    const on = f.items.filter((v) => v.route === x.name); const v = on.find((y) => y.status === "Active") ?? on[0];
    const d = v ? c.drivers.find((y) => y.vehicle_id === v.id && y.status === "Active") : undefined;
    const a = c.attendants.find((y) => y.route_id === x.id && y.status === "Active");
    const checks: string[] = [];
    if (!v) checks.push("No vehicle assigned");
    else {
      if (v.status !== "Active") checks.push(`${v.name} is ${v.status.toLowerCase()}`);
      if (f.docs.some((y) => y.vehicle_id === v.id && y.state === "Expired")) checks.push(`${v.name} has an expired document`);
      if (v.status === "Active" && x.students > usable(v.seats, cap.rule)) checks.push(`${x.students - usable(v.seats, cap.rule)} more children than seats`);
    }
    if (!d) checks.push("No driver assigned");
    else {
      const st = docState(d.licence_until ?? null, now);
      if (st === "Expired" || st === "Expiring") checks.push(`${d.name}'s licence ${st === "Expired" ? "expired" : "expires"} ${nice(d.licence_until!)}`);
      if (d.police === "Pending") checks.push(`${d.name}'s police verification is pending`);
    }
    if (!a) checks.push("No attendant assigned"); else if (a.police === "Pending") checks.push(`${a.name}'s police verification is pending`);
    return { id: x.id, route: x.name, vehicle_id: v?.id ?? "", vehicle: v?.name ?? "", reg_no: v?.reg_no ?? "", used: x.students, seats: v ? usable(v.seats, cap.rule) : 0, driver_id: d?.id ?? "", driver: d?.name ?? "", attendant_id: a?.id ?? "", attendant: a?.name ?? "", checks };
  });
  const names = new Set(active.map((x) => x.name)); const ids = new Set(active.map((x) => x.id));
  const onRoute = new Set(f.items.filter((v) => names.has(v.route)).map((v) => v.id));
  return {
    routes: rows,
    vehicles: f.items.map((v) => ({ id: v.id, name: v.name, reg_no: v.reg_no, model: v.model, seats: v.seats, status: v.status, route: names.has(v.route) ? v.route : "", block: v.block })),
    drivers: c.drivers.filter((d) => d.status === "Active").map((d) => ({ id: d.id, name: d.name, mobile: d.mobile ?? "", police: d.police ?? "", licence_state: docState(d.licence_until ?? null, now), route: rows.find((x) => x.driver_id === d.id)?.route ?? "" })),
    attendants: c.attendants.filter((a) => a.status === "Active").map((a) => ({ id: a.id, name: a.name, mobile: a.mobile ?? "", police: a.police ?? "", route: a.route_id && ids.has(a.route_id) ? active.find((x) => x.id === a.route_id)!.name : "" })),
    spare: {
      vehicles: f.items.filter((v) => !onRoute.has(v.id)),
      drivers: c.drivers.filter((d) => d.status === "Active" && !(d.vehicle_id && onRoute.has(d.vehicle_id))).map((d) => ({ id: d.id, name: d.name, mobile: d.mobile ?? "", police: d.police ?? "" })),
      attendants: c.attendants.filter((a) => a.status === "Active" && !(a.route_id && ids.has(a.route_id))).map((a) => ({ id: a.id, name: a.name, mobile: a.mobile ?? "", police: a.police ?? "" })),
    },
  };
}

/** Change who runs a route. Only what is being changed is checked: documents, licence, verification and seats. */
export async function setAssignment(inst: string, routeId: string, input: unknown) {
  const i = z.object({ vehicle_id: uid.nullable(), driver_id: uid.nullable(), attendant_id: uid.nullable() }).strict().parse(input);
  const x = await assignments(inst);
  const cur = x.routes.find((r) => r.id === uid.parse(routeId)); if (!cur) throw new HttpError(404, "Route not found.");
  const v = i.vehicle_id ? x.vehicles.find((y) => y.id === i.vehicle_id) : undefined;
  const d = i.driver_id ? x.drivers.find((y) => y.id === i.driver_id) : undefined;
  const a = i.attendant_id ? x.attendants.find((y) => y.id === i.attendant_id) : undefined;
  if ((i.vehicle_id && !v) || (i.driver_id && !d) || (i.attendant_id && !a)) throw new HttpError(404, "Not found.");
  if (d && !v) throw new HttpError(400, "Give the route a vehicle before its driver.");
  const vChanged = (i.vehicle_id ?? "") !== cur.vehicle_id; const dChanged = (i.driver_id ?? "") !== cur.driver_id; const aChanged = (i.attendant_id ?? "") !== cur.attendant_id;
  if (v && vChanged) {
    if (v.status !== "Active") throw new HttpError(409, `${v.name} is ${v.status.toLowerCase()}.`);
    if (v.block) throw new HttpError(409, v.block);
    if (v.route && v.route !== cur.route) throw new HttpError(409, `${v.name} is on ${v.route}. Take it off that route first.`);
    const seats = usable(v.seats, (await trSettings(inst)).seats_rule);
    if (cur.used > seats) throw new HttpError(409, `${cur.used} children ride ${cur.route}; ${v.name} has ${seats} seats.`);
  }
  if (d && dChanged) {
    if (d.police !== "Verified") throw new HttpError(409, `${d.name} can be put on a route once police verification is done.`);
    if (d.licence_state === "Expired" || d.licence_state === "No date") throw new HttpError(409, `${d.name} needs a licence in date.`);
    if (d.route && d.route !== cur.route) throw new HttpError(409, `${d.name} drives ${d.route}. Take them off that route first.`);
  }
  if (a && aChanged) {
    if (a.police !== "Verified") throw new HttpError(409, `${a.name} can be put on a route once police verification is done.`);
    if (a.route && a.route !== cur.route) throw new HttpError(409, `${a.name} is on ${a.route}. Take them off that route first.`);
  }
  if (vChanged) {
    check(await supabaseAdmin.from("tr_vehicles").update({ route: "" }).eq("institution_id", inst).eq("route", cur.route).select("id"));
    if (v) check(await supabaseAdmin.from("tr_vehicles").update({ route: cur.route }).eq("id", v.id).eq("institution_id", inst).select("id"));
    if (cur.driver_id && !dChanged) {
      // one driver to a vehicle: whoever held the new one steps off
      if (v) check(await supabaseAdmin.from("tr_drivers").update({ vehicle_id: null }).eq("institution_id", inst).eq("vehicle_id", v.id).select("id"));
      check(await supabaseAdmin.from("tr_drivers").update({ vehicle_id: v?.id ?? null }).eq("id", cur.driver_id).eq("institution_id", inst).select("id"));
    }
  }
  if (dChanged) {
    if (cur.driver_id) check(await supabaseAdmin.from("tr_drivers").update({ vehicle_id: null }).eq("id", cur.driver_id).eq("institution_id", inst).select("id"));
    if (d && v) { check(await supabaseAdmin.from("tr_drivers").update({ vehicle_id: null }).eq("institution_id", inst).eq("vehicle_id", v.id).select("id")); check(await supabaseAdmin.from("tr_drivers").update({ vehicle_id: v.id }).eq("id", d.id).eq("institution_id", inst).select("id")); }
  }
  if (aChanged) {
    check(await supabaseAdmin.from("tr_attendants").update({ route_id: null, vehicle_id: null }).eq("institution_id", inst).eq("route_id", cur.id).select("id"));
    if (a) check(await supabaseAdmin.from("tr_attendants").update({ route_id: cur.id, vehicle_id: v?.id ?? null }).eq("id", a.id).eq("institution_id", inst).select("id"));
  } else if (vChanged && cur.attendant_id) check(await supabaseAdmin.from("tr_attendants").update({ vehicle_id: v?.id ?? null }).eq("id", cur.attendant_id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ trips ═════════════
interface TripRow { id: string; route_id: string; ttype: string; trip_on: string; started_at: string | null; ended_at: string | null; status: string; arrived: string[]; delay_min?: number | null }
const TRIP = "id, route_id, ttype, trip_on, started_at, ended_at, status, arrived";
async function tripRows(inst: string, on?: string) {
  const q = (cols: string) => { let x = supabaseAdmin.from("tr_trips").select(cols).eq("institution_id", inst); if (on) x = x.eq("trip_on", on); return x.order("trip_on", { ascending: false }).limit(1000); };
  return newOr<TripRow>(() => q(TRIP + ", delay_min"), () => q(TRIP));
}

/** Minutes behind: from the last stop reached (or the start), or what was reported, whichever is more. */
export function lateBy(t: { startedAt: string; reachedAt: string; reachedDue: string; firstDue: string; reported: number }) {
  const worked = t.reachedAt && t.reachedDue ? mins(t.reachedAt) - mins(t.reachedDue) : t.startedAt && t.firstDue ? mins(t.startedAt) - mins(t.firstDue) : 0;
  return Math.max(0, worked, t.reported);
}

/** Today's trips of the current run (morning pickup or afternoon drop), stop by stop. */
export async function liveBoard(inst: string) {
  const type = tripNow(); const now = today();
  const [n, f, c, t, al, alerts, absent] = await Promise.all([
    network(inst), fleet(inst), crewRows(inst), tripRows(inst, now),
    supabaseAdmin.from("tr_allocations").select("student_id, route_id, stop_id").eq("institution_id", inst).limit(20000),
    supabaseAdmin.from("tr_alerts").select("trip_id, stop_id, at").eq("institution_id", inst).gte("at", `${now}T00:00:00+05:30`).limit(5000),
    supabaseAdmin.from("tr_boardings").select("student_id").eq("institution_id", inst).eq("trip_on", now).eq("ttype", type).in("status", ["Missing at stop", "Absent, parent told"]).limit(5000),
  ]);
  const A = check(al) as { student_id: string; route_id: string | null; stop_id: string | null }[];
  const L = check(alerts) as { trip_id: string; stop_id: string | null; at: string }[];
  const gone = new Set((check(absent) as { student_id: string }[]).map((x) => x.student_id));
  const out = n.routes.filter((r) => r.status === "Active").map((r) => {
    const trip = t.rows.find((x) => x.route_id === r.id && x.ttype === type);
    const on = f.items.filter((v) => v.route === r.name); const v = on.find((y) => y.status === "Active") ?? on[0];
    const d = v ? c.drivers.find((y) => y.vehicle_id === v.id && y.status === "Active") : undefined;
    const ordered = runOrder(n.stops.filter((s) => s.route_id === r.id), type).map((s) => ({ id: s.id as string | null, name: s.name, due: type === "Morning" ? s.pickup : s.drop, done: !!trip?.arrived.includes(s.id) }));
    const gate = { id: null as string | null, name: "School", due: type === "Morning" ? r.at_school : r.departure, done: type === "Morning" ? !!trip?.ended_at : !!trip };
    const path = type === "Morning" ? [...ordered, gate] : [gate, ...ordered];
    const next = trip && !trip.ended_at ? ordered.find((s) => !s.done) : undefined;
    const last = [...path].reverse().find((s) => s.done);
    const reached = trip ? L.filter((x) => x.trip_id === trip.id).sort((a, b) => b.at.localeCompare(a.at))[0] : undefined;
    const late = !trip ? 0 : lateBy({ startedAt: hm(trip.started_at), reachedAt: reached ? istHm(reached.at) : "", reachedDue: ordered.find((s) => s.id === reached?.stop_id)?.due ?? "", firstDue: path[0]?.due ?? "", reported: trip.delay_min ?? 0 });
    const running = !!trip && !trip.ended_at && trip.status === "Running";
    const state = !trip ? "Not started" : !running ? "Completed" : late >= LATE_MIN ? "Delayed" : "In progress";
    const kids = A.filter((a) => a.route_id === r.id && !gone.has(a.student_id));
    const on_board = !running ? 0 : type === "Afternoon" ? kids.filter((a) => !a.stop_id || !trip!.arrived.includes(a.stop_id)).length : kids.filter((a) => !!a.stop_id && trip!.arrived.includes(a.stop_id)).length;
    return {
      id: r.id, route: r.name, vehicle: v?.name ?? "", reg_no: v?.reg_no ?? "", driver: d?.name ?? "", trip_id: trip?.id ?? "", state, late, running, started: hm(trip?.started_at),
      stops: path.map((s) => ({ ...s, students: s.id ? A.filter((a) => a.stop_id === s.id).length : null })),
      last: last?.name ?? "", next_id: next?.id ?? "", next: next?.name ?? (running && type === "Morning" ? "School" : ""), next_due: next?.due ? hhmm(mins(next.due) + late) : "", on_board,
    };
  });
  return { type, now: nowHm(), upgraded: t.upgraded, routes: out, on_road: out.filter((x) => x.running).length, completed: out.filter((x) => x.state === "Completed").length, delayed: out.filter((x) => x.state === "Delayed").length, on_board: out.reduce((s, x) => s + x.on_board, 0) };
}

export async function reportDelay(inst: string, me: string, tripId: string, input: unknown) {
  const i = z.object({ minutes: z.number().int().min(1, "Enter the delay in minutes.").max(300), note: z.string().trim().max(200).optional() }).strict().parse(input);
  const row = (await liveBoard(inst)).routes.find((r) => r.trip_id === uid.parse(tripId));
  if (!row) throw new HttpError(404, "Trip not found.");
  if (!row.running) throw new HttpError(409, "That trip is over.");
  saved(await supabaseAdmin.from("tr_trips").update({ delay_min: i.minutes }).eq("id", tripId).eq("institution_id", inst).select("id"));
  const waiting = new Set(row.stops.filter((s) => s.id && !s.done).map((s) => s.id));
  const kids = (check(await supabaseAdmin.from("tr_allocations").select("student_id, stop_id").eq("institution_id", inst).eq("route_id", row.id).limit(20000)) as { student_id: string; stop_id: string | null }[]).filter((a) => !a.stop_id || waiting.has(a.stop_id));
  for (const k of kids) await replyDelay(inst, k.student_id, `${row.vehicle || row.route} is running ${i.minutes} minutes late.${i.note ? ` ${i.note}` : ""}`, me);
  return { ok: true, families: kids.length };
}
async function replyDelay(inst: string, studentId: string, body: string, by: string) {
  const k = check(await supabaseAdmin.from("student_guardians").select("guardian_id, relation, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).eq("student_id", studentId)) as { guardian_id: string; relation: string }[];
  const g = (k.find((x) => x.relation === "Father") ?? k[0])?.guardian_id;
  if (g) check(await supabaseAdmin.from("parent_messages").insert({ institution_id: inst, kind: "notification", guardian_id: g, student_id: studentId, subject: "Bus delay", body, channel: "App", created_by: by }).select("id"));
}

/** The driver's view of one route today, with the alerts parents were sent. */
export async function driverView(inst: string, routeId: string) {
  const x = await liveBoard(inst);
  const row = x.routes.find((r) => r.id === routeId) ?? x.routes.find((r) => r.state === "Delayed") ?? x.routes.find((r) => r.running) ?? x.routes[0];
  if (!row) return { type: x.type, routes: [], route: null, alerts: [] };
  const alerts = row.trip_id ? (check(await supabaseAdmin.from("tr_alerts").select("id, stop_id, stop_name, families, at").eq("institution_id", inst).eq("trip_id", row.trip_id).order("at", { ascending: false })) as { id: string; stop_id: string | null; stop_name: string; families: number; at: string }[]) : [];
  return {
    type: x.type, routes: x.routes.map((r) => ({ id: r.id, name: r.route })), route: row,
    alerts: alerts.map((a) => { const k = row.stops.findIndex((s) => s.id === a.stop_id); const next = k >= 0 ? row.stops[k + 1] : undefined; return { id: a.id, time: istHm(a.at), stop: a.stop_name, families: a.families, message: `Bus at ${a.stop_name}${next ? ` · next: ${next.name}${next.due ? ` at ${next.due}` : ""}` : ""}` }; }),
  };
}
export async function sos(inst: string, me: string, input: unknown) {
  const { route_id } = z.object({ route_id: uid }).strict().parse(input);
  const row = (await liveBoard(inst)).routes.find((r) => r.id === route_id); if (!row) throw new HttpError(404, "Route not found.");
  const t = await raiseTicket(inst, me, { category: "Other staff requests", priority: "High", subject: `SOS from ${row.route}${row.reg_no ? ` (${row.reg_no})` : ""}`, details: `Raised ${nowHm()}. Driver: ${row.driver || "not assigned"}. Last stop: ${row.last || "none"}. Next stop: ${row.next || "none"}.` }, "Staff");
  check(await supabaseAdmin.from("hd_tickets").update({ assigned_name: "School Admin" }).eq("id", t.id).eq("institution_id", inst).select("id"));
  return { code: t.code };
}

export async function vehicleStatus(inst: string) {
  const [f, x, m] = await Promise.all([fleet(inst), liveBoard(inst), supabaseAdmin.from("tr_maintenance").select("vehicle_id, due_on").eq("institution_id", inst).eq("mtype", "Service schedule").neq("status", "Done").order("due_on").limit(2000)]);
  const M = check(m) as { vehicle_id: string; due_on: string }[];
  const running = new Set(x.routes.filter((r) => r.running).map((r) => r.route));
  const now = today();
  return { items: f.items.map((v) => { const due = M.find((y) => y.vehicle_id === v.id)?.due_on ?? null; return { id: v.id, name: v.name, reg_no: v.reg_no, status: v.status !== "Active" ? v.status : running.has(v.route) ? "On trip" : "At depot", gps: v.gps === "Fitted" ? (v.gps_state === "Online" ? "On" : "Off") : "Off", next_service: due, service_state: due ? docState(due, now) : "No date" }; }) };
}

/** Finished trips. Late is measured at the end: arrival at school in the morning, the last drop in the afternoon. */
export async function tripLog(inst: string) {
  const [n, t] = await Promise.all([network(inst), tripRows(inst)]);
  return {
    items: t.rows.filter((x) => !!x.ended_at).map((x) => {
      const r = n.routes.find((y) => y.id === x.route_id);
      const expected = x.ttype === "Morning" ? r?.at_school ?? "" : n.stops.filter((s) => s.route_id === x.route_id).map((s) => s.drop).filter(Boolean).sort().pop() ?? "";
      const late = Math.max(0, x.delay_min ?? 0, expected ? mins(hm(x.ended_at)) - mins(expected) : 0);
      return { id: x.id, date: x.trip_on, route: r?.name ?? "", trip: x.ttype === "Morning" ? "Morning pickup" : "Afternoon drop", started: hm(x.started_at), ended: hm(x.ended_at), late, result: late >= LATE_MIN || x.status === "Delayed" ? "Delayed" : "On time" };
    }).sort((a, b) => b.date.localeCompare(a.date) || a.trip.localeCompare(b.trip) * -1 || byName(a.route, b.route)),
  };
}

// ═════════════ route planner ═════════════
async function plannerData(inst: string) {
  const [al, homes, campus] = await Promise.all([
    supabaseAdmin.from("tr_allocations").select("student_id").eq("institution_id", inst).limit(20000),
    supabaseAdmin.from("tr_homes").select("student_id, latitude, longitude, area").eq("institution_id", inst).limit(20000),
    supabaseAdmin.from("campuses").select("latitude, longitude").eq("institution_id", inst).order("is_main", { ascending: false }).limit(1),
  ]);
  const riders = new Set((check(al) as { student_id: string }[]).map((x) => x.student_id));
  const H = (homes.error ? [] : homes.data) as { student_id: string; latitude: number; longitude: number; area: string }[];
  const c = (check(campus) as { latitude: number | null; longitude: number | null }[])[0];
  const school = c?.latitude != null && c?.longitude != null ? { lat: Number(c.latitude), lng: Number(c.longitude) } : null;
  // everyone whose home is on file and who rides today; if nobody is allocated yet, every home on file
  const mine = riders.size ? H.filter((h) => riders.has(h.student_id)) : H;
  return { upgraded: !homes.error, riders: riders.size, school, homes: mine.map((h): Home => ({ lat: Number(h.latitude), lng: Number(h.longitude), area: h.area })) };
}
const rulesIn = z.object({ seats: z.number().int().min(5).max(80), longest: z.number().int().min(10).max(180), walk: z.number().int().min(50).max(2000) }).strict();
async function today_(inst: string) {
  const r = (await routes(inst)).items.filter((x) => x.status === "Active");
  const rides = r.filter((x) => x.first_pickup && x.at_school).map((x) => mins(x.at_school) - mins(x.first_pickup)).filter((x) => x > 0);
  return { buses: r.length, km_day: r.reduce((n, x) => n + x.distance_km * 4, 0), longest: Math.max(0, ...rides), average: rides.length ? Math.round(rides.reduce((a, b) => a + b, 0) / rides.length) : 0 };
}
export async function planner(inst: string, query: unknown) {
  const rules: Rules = rulesIn.parse(query);
  const [d, now] = await Promise.all([plannerData(inst), today_(inst)]);
  const ready = !!d.school && d.homes.length > 0;
  return { upgraded: d.upgraded, riders: d.riders, located: d.homes.length, school: d.school, today: now, plan: ready ? plan(d.school!, d.homes, rules) : null, homes: ready ? d.homes.map((h) => ({ lat: h.lat, lng: h.lng })) : [] };
}

/** Where riders live, from a file: admission number, latitude, longitude and area. */
export async function saveHomes(inst: string, input: unknown) {
  const i = z.object({ rows: z.array(z.object({ admission_no: z.string().trim().min(1).max(40), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), area: z.string().trim().max(60).optional() }).strict()).min(1, "The file has no rows.").max(5000) }).strict().parse(input);
  const known = new Map((await roster(inst)).items.map((s) => [(s.registration_no ?? "").toLowerCase(), s.id]));
  const rows = new Map<string, Record<string, unknown>>(); const unknown: string[] = [];
  for (const r of i.rows) { const id = known.get(r.admission_no.toLowerCase()); if (id) rows.set(id, { student_id: id, institution_id: inst, latitude: r.latitude, longitude: r.longitude, area: r.area ?? "" }); else unknown.push(r.admission_no); }
  const list = [...rows.values()];
  for (let a = 0; a < list.length; a += 500) saved(await supabaseAdmin.from("tr_homes").upsert(list.slice(a, a + 500), { onConflict: "student_id" }).select("student_id"));
  return { saved: list.length, unknown: unknown.slice(0, 20), unknown_count: unknown.length };
}

/** Keeps the plan as draft routes with their stops. Nothing running changes and no student is moved. */
export async function applyPlan(inst: string, input: unknown) {
  const rules = rulesIn.parse(input);
  const d = await plannerData(inst);
  if (!d.school || !d.homes.length) throw new HttpError(409, "There is no plan yet: the school's location and the riders' homes are needed.");
  saved(await supabaseAdmin.from("tr_stops").select("offset_min").eq("institution_id", inst).limit(1));
  const p = plan(d.school, d.homes, rules);
  const have = (await routes(inst)).items;
  let n = have.reduce((m, r) => Math.max(m, Number(r.name.match(/^new\s+(\d+)$/i)?.[1] ?? 0)), 0);
  if (have.some((r) => r.status === "Inactive" && /^new\s+\d+$/i.test(r.name))) throw new HttpError(409, "A plan is already waiting as draft routes. Put them into use or remove them first.");
  for (const r of p.routes) {
    n++;
    const made = check(await supabaseAdmin.from("tr_routes").insert({ institution_id: inst, name: `New ${n}`, area: r.areas.join(", ").slice(0, 100), distance_km: Math.round(r.km), status: "Inactive" }).select("id").single()) as { id: string };
    check(await supabaseAdmin.from("tr_stops").insert(r.stops.slice(0, 60).map((s, k) => ({ institution_id: inst, route_id: made.id, name: s.name.slice(0, 100), ord: k + 1, offset_min: Math.min(300, s.minutes) }))).select("id"));
  }
  return { routes: p.routes.length };
}
