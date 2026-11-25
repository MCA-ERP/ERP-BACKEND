import { randomUUID } from "crypto";
import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { vehicles as vehicleRows } from "../school/pay2.service";
import { allocations, attendants, drivers, routes, stops } from "../school/transport.service";
import { trSettings, trips } from "../school/tr2.service";
import { liveBoard, parentRequests, appRequests } from "./transport-ops.service";
import { directory } from "../school/hr.service";
import { clearDept } from "../school/hr4.service";
import { feeSettings } from "../school/fees.service";
import { roster } from "../school/student-mgmt.service";
import { raiseTicket } from "../teacher/teacher.service";
import { saved } from "../school/tr-columns";

/**
 * The Transport portal's own reads and writes: dashboard, notifications, settings (read only), messages to parents,
 * staff exit clearance, vehicle documents, assignments and parent requests. Vehicles, crew, routes, stops, allocations,
 * trips and bus attendance are the same records and services as the School Admin's Transport module.
 */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const nice = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const istTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// ═════════════ vehicles and their documents ═════════════
export const DOC_TYPES = ["Registration (RC)", "Insurance", "Fitness certificate", "Pollution (PUC)", "Permit", "Road tax"] as const;
export const DUE_DAYS = 30;
export type DocState = "Expired" | "Expiring" | "Valid" | "No date";
export const docState = (validUntil: string | null, now: string): DocState => (!validUntil ? "No date" : validUntil < now ? "Expired" : validUntil <= addDays(now, DUE_DAYS) ? "Expiring" : "Valid");

export interface Doc { id: string | null; vehicle_id: string; doc_type: string; file_name: string; valid_until: string | null; state: DocState }
/** The current paper of each kind for each vehicle: the one valid the longest. An older fitness date kept on the
 *  vehicle itself counts as its fitness certificate. */
export function currentDocs(vehicles: { id: string; fitness_until: string | null }[], docs: { id: string; vehicle_id: string; doc_type: string; file_name: string; valid_until: string | null }[], now: string): Doc[] {
  const best = new Map<string, Doc>();
  for (const d of docs) {
    const type = DOC_TYPES.find((t) => t.toLowerCase() === d.doc_type.trim().toLowerCase()) ?? (/fitness/i.test(d.doc_type) ? "Fitness certificate" : d.doc_type);
    const key = `${d.vehicle_id}|${type}`; const had = best.get(key);
    if (!had || (d.valid_until ?? "") > (had.valid_until ?? "")) best.set(key, { id: d.id, vehicle_id: d.vehicle_id, doc_type: type, file_name: d.file_name, valid_until: d.valid_until, state: docState(d.valid_until, now) });
  }
  for (const v of vehicles) {
    const key = `${v.id}|Fitness certificate`;
    if (v.fitness_until && !best.has(key)) best.set(key, { id: null, vehicle_id: v.id, doc_type: "Fitness certificate", file_name: "", valid_until: v.fitness_until, state: docState(v.fitness_until, now) });
  }
  return [...best.values()];
}
/** What stops a vehicle being given a route: every paper recorded and none expired. */
export function routeBlock(docs: { doc_type: string; state: DocState }[]): string {
  const missing = DOC_TYPES.filter((t) => !docs.some((d) => d.doc_type === t && d.state !== "No date"));
  if (missing.length) return `Add these documents first: ${missing.join(", ")}.`;
  const out = docs.filter((d) => d.state === "Expired").map((d) => d.doc_type);
  return out.length ? `Renew first: ${out.join(", ")} expired.` : "";
}
const worst = (docs: Doc[]) => (!docs.length ? "Not recorded" : docs.some((d) => d.state === "Expired") ? "Expired" : docs.some((d) => d.state === "Expiring") ? "Expiring" : "Valid");

export async function fleet(inst: string) {
  const now = today();
  const v = await vehicleRows(inst);
  const docs = currentDocs(v.items, v.docs, now);
  const items = v.items.map((x) => {
    const mine = docs.filter((d) => d.vehicle_id === x.id);
    return { id: x.id, name: x.fleet_name || x.reg_no, reg_no: x.reg_no, model: x.make_model || x.vtype, seats: x.seats, year: x.model_year ?? null, route: x.route, gps: x.gps === "None" ? "Not fitted" : "Fitted", gps_state: x.gps, status: x.status, documents: worst(mine), block: routeBlock(mine) };
  }).sort((a, b) => byName(a.name, b.name));
  const names = new Map(items.map((x) => [x.id, x]));
  const list = docs.map((d) => ({ ...d, vehicle: names.get(d.vehicle_id)?.name ?? "", reg_no: names.get(d.vehicle_id)?.reg_no ?? "" })).sort((a, b) => (a.valid_until ?? "9999").localeCompare(b.valid_until ?? "9999") || byName(a.vehicle, b.vehicle));
  return { types: DOC_TYPES, items, docs: list, seats: items.reduce((n, x) => n + x.seats, 0), active: items.filter((x) => x.status === "Active").length, maintenance: items.filter((x) => x.status === "In maintenance").length, due: list.filter((d) => d.state === "Expired" || d.state === "Expiring").length };
}

const vehicleIn = z.object({
  fleet_name: z.string().trim().min(2, "Enter the fleet name.").max(40),
  reg_no: z.string().trim().toUpperCase().min(3, "Enter the registration number.").max(30),
  make_model: z.string().trim().min(2, "Enter the make and model.").max(80),
  seats: z.number().int().min(1).max(80),
  year: z.number().int().min(1980).max(2100),
  gps: z.enum(["Fitted", "Not fitted"]),
  documents: z.array(z.object({ doc_type: z.enum(DOC_TYPES), valid_until: date }).strict()).max(DOC_TYPES.length),
}).strict();

export async function addVehicle(inst: string, input: unknown) {
  const i = vehicleIn.parse(input);
  const have = check(await supabaseAdmin.from("tr_vehicles").select("reg_no").eq("institution_id", inst).limit(2000)) as { reg_no: string }[];
  const plate = (s: string) => s.replace(/\s+/g, "").toUpperCase();
  if (have.some((x) => plate(x.reg_no) === plate(i.reg_no))) throw new HttpError(409, "That vehicle is already listed.");
  const named = await supabaseAdmin.from("tr_vehicles").select("id").eq("institution_id", inst).ilike("fleet_name", i.fleet_name.replace(/[%_\\]/g, "\\$&")).limit(1);
  if (named.data?.length) throw new HttpError(409, "That fleet name is used.");
  const fitness = i.documents.find((d) => d.doc_type === "Fitness certificate")?.valid_until ?? null;
  const row = saved<{ id: string }>(await supabaseAdmin.from("tr_vehicles").insert({ institution_id: inst, reg_no: i.reg_no, vtype: "Bus", seats: i.seats, route: "", fitness_until: fitness, gps: i.gps === "Fitted" ? "Online" : "None", fleet_name: i.fleet_name, make_model: i.make_model, model_year: i.year }).select("id").single());
  if (i.documents.length) check(await supabaseAdmin.from("tr_vehicle_docs").insert(i.documents.map((d) => ({ institution_id: inst, vehicle_id: row.id, doc_type: d.doc_type, file_name: "No scan yet", valid_until: d.valid_until }))).select("id"));
  return { id: row.id };
}

async function ownVehicle(inst: string, id: string) {
  const v = check(await supabaseAdmin.from("tr_vehicles").select("id").eq("id", uid.parse(id)).eq("institution_id", inst).maybeSingle());
  if (!v) throw new HttpError(404, "Vehicle not found.");
}
/** The row a renewal or scan belongs to (the latest of that kind), made when there is none. */
async function docRow(inst: string, vehicleId: string, docType: string) {
  return check(await supabaseAdmin.from("tr_vehicle_docs").select("id, valid_until").eq("institution_id", inst).eq("vehicle_id", vehicleId).eq("doc_type", docType).order("valid_until", { ascending: false, nullsFirst: false }).limit(1).maybeSingle()) as { id: string; valid_until: string | null } | null;
}

/** Renew a document: the new expiry date. */
export async function renewDocument(inst: string, vehicleId: string, input: unknown) {
  const i = z.object({ doc_type: z.enum(DOC_TYPES), valid_until: date }).strict().parse(input);
  await ownVehicle(inst, vehicleId);
  if (i.valid_until < today()) throw new HttpError(400, "The new date has already passed.");
  const cur = await docRow(inst, vehicleId, i.doc_type);
  if (cur) check(await supabaseAdmin.from("tr_vehicle_docs").update({ valid_until: i.valid_until }).eq("id", cur.id).eq("institution_id", inst).select("id"));
  else check(await supabaseAdmin.from("tr_vehicle_docs").insert({ institution_id: inst, vehicle_id: vehicleId, doc_type: i.doc_type, file_name: "No scan yet", valid_until: i.valid_until }).select("id"));
  if (i.doc_type === "Fitness certificate") check(await supabaseAdmin.from("tr_vehicles").update({ fitness_until: i.valid_until }).eq("id", vehicleId).eq("institution_id", inst).select("id"));
  return { ok: true };
}

export const MAX_FILE = 5 * 1024 * 1024;
const BUCKET = "transport-documents";
const SIGS: { mime: string; ext: string; ok: (b: Buffer) => boolean }[] = [
  { mime: "application/pdf", ext: "pdf", ok: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", ext: "png", ok: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: "jpg", ok: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
/** The file's type, judged from its first bytes, and its size. */
export function checkScan(mime: string, data: Buffer) {
  if (!data?.length) throw new HttpError(400, "Choose a file to upload.");
  if (data.length > MAX_FILE) throw new HttpError(413, "The file is larger than 5 MB.");
  const sig = SIGS.find((s) => s.mime === mime);
  if (!sig || !sig.ok(data)) throw new HttpError(415, "Upload a PDF, JPG or PNG file.");
  return sig;
}
let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabaseAdmin.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_FILE });
  if (error && !/already exists|duplicate/i.test(error.message)) throw new HttpError(503, "File storage is not available right now. Please try again later.");
  bucketReady = true;
}

/** Keep a checked PDF or photo in the private bucket. */
export async function storeFile(folder: string, fileName: string, mime: string, data: Buffer) {
  const sig = checkScan(mime, data);
  await ensureBucket();
  const path = `${folder}/${randomUUID()}.${sig.ext}`;
  const up = await supabaseAdmin.storage.from(BUCKET).upload(path, data, { contentType: sig.mime, upsert: false });
  if (up.error) throw new HttpError(502, "Could not store the file. Please try again.");
  return { path, mime: sig.mime, name: fileName.replace(/[^\w.\- ()]/g, "_").slice(0, 100) || `document.${sig.ext}` };
}
/** A link that works for five minutes. Callers check first that the file is this school's. */
export async function fileLink(path: string) {
  const s = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 300);
  if (s.error || !s.data) throw new HttpError(502, "Could not open the file.");
  return { url: s.data.signedUrl };
}

export async function uploadScan(inst: string, vehicleId: string, docType: string, fileName: string, mime: string, data: Buffer) {
  const type = z.enum(DOC_TYPES).parse(docType);
  await ownVehicle(inst, vehicleId);
  checkScan(mime, data);
  const cur = await docRow(inst, vehicleId, type);
  if (!cur) throw new HttpError(409, "Enter the expiry date of this document first.");
  const old = saved<{ storage_path: string | null }>(await supabaseAdmin.from("tr_vehicle_docs").select("storage_path").eq("id", cur.id).eq("institution_id", inst).single());
  const f = await storeFile(`${inst}/${vehicleId}`, fileName, mime, data);
  saved(await supabaseAdmin.from("tr_vehicle_docs").update({ file_name: f.name, storage_path: f.path, mime: f.mime }).eq("id", cur.id).eq("institution_id", inst).select("id"));
  if (old.storage_path) await supabaseAdmin.storage.from(BUCKET).remove([old.storage_path]);
  return { ok: true };
}

/** A short-lived link to a scan of this school's vehicle document. */
export async function scanLink(inst: string, docId: string) {
  const d = saved<{ storage_path: string | null } | null>(await supabaseAdmin.from("tr_vehicle_docs").select("storage_path").eq("id", uid.parse(docId)).eq("institution_id", inst).maybeSingle());
  if (!d) throw new HttpError(404, "Document not found.");
  if (!d.storage_path) throw new HttpError(404, "No scan was uploaded for this document.");
  return fileLink(d.storage_path);
}

// ═════════════ what needs attention ═════════════
export interface Attention { key: string; kind: "document" | "crew" | "route"; tone: "bad" | "warn"; bold: string; text: string; sub: string; state: "Expired" | "Expiring" | "Pending" | "" }

type Crew = { id: string; name: string; status: string; police: string; licence_until?: string | null; vehicle_id?: string | null };
/** Documents, crew and route problems, in the order the dashboard lists them. */
export function attentionList(now: string, f: { items: { id: string; name: string; route: string; status: string }[]; docs: { vehicle_id: string; vehicle: string; doc_type: string; valid_until: string | null; state: DocState }[] }, D: Crew[], A: Crew[], activeRoutes: string[]): Attention[] {
  const out: Attention[] = [];
  for (const d of f.docs.filter((x) => x.state === "Expired" || x.state === "Expiring").sort((a, b) => byName(a.vehicle, b.vehicle) || (a.valid_until ?? "").localeCompare(b.valid_until ?? "")))
    out.push({ key: `doc:${d.vehicle_id}:${d.doc_type}:${d.valid_until}`, kind: "document", tone: d.state === "Expired" ? "bad" : "warn", bold: d.vehicle, text: `${d.doc_type} ${d.state === "Expired" ? "expired" : "expires"}`, sub: d.valid_until ? nice(d.valid_until) : "", state: d.state as "Expired" | "Expiring" });
  for (const d of D.filter((x) => x.status === "Active")) {
    const st = docState(d.licence_until ?? null, now);
    if (st === "Expired" || st === "Expiring") out.push({ key: `licence:${d.id}:${d.licence_until}`, kind: "crew", tone: "bad", bold: d.name, text: `licence ${st === "Expired" ? "expired" : "expires"} ${nice(d.licence_until!)}`, sub: "Driver", state: st });
    if (d.police === "Pending") out.push({ key: `police:${d.id}`, kind: "crew", tone: "warn", bold: d.name, text: "police verification pending", sub: "Driver", state: "Pending" });
  }
  for (const a of A.filter((x) => x.status === "Active" && x.police === "Pending")) out.push({ key: `police:${a.id}`, kind: "crew", tone: "warn", bold: a.name, text: "police verification pending", sub: "Attendant", state: "Pending" });
  for (const r of activeRoutes) {
    const on = f.items.filter((v) => v.route === r);
    const v = on.find((x) => x.status === "Active") ?? on[0];
    const add = (what: string, text: string) => out.push({ key: `route:${r}:${what}`, kind: "route", tone: "warn", bold: r, text, sub: "Vehicle and driver assignment", state: "" });
    if (!v) add("vehicle", "no vehicle assigned");
    else if (v.status !== "Active") add("off", `${v.name} is ${v.status.toLowerCase()}`);
    else if (f.docs.some((d) => d.vehicle_id === v.id && d.state === "Expired")) add("expired", `${v.name} has an expired document`);
    else if (!D.some((d) => d.vehicle_id === v.id && d.status === "Active")) add("driver", `${v.name} has no driver`);
  }
  return out;
}

async function gather(inst: string) {
  const [f, d, a, r] = await Promise.all([fleet(inst), drivers(inst), attendants(inst), routes(inst)]);
  const attention = attentionList(today(), f, d.items, a.items, r.items.filter((x) => x.status === "Active").map((x) => x.name));
  return { f, d, a, r, attention };
}

// ═════════════ dashboard ═════════════
export async function dashboard(inst: string) {
  const [g, lv, t] = await Promise.all([
    gather(inst), liveBoard(inst),
    supabaseAdmin.from("tr_trips").select("route_id, ttype, status, ended_at").eq("institution_id", inst).eq("trip_on", today()),
  ]);
  const active = g.r.items.filter((x) => x.status === "Active");
  const ids = new Set(active.map((x) => x.id));
  const done = (check(t) as { route_id: string; status: string; ended_at: string | null }[]).filter((x) => ids.has(x.route_id) && (x.status === "Completed" || !!x.ended_at)).length;
  const items = lv.routes.map((c) => ({
    route: c.route, vehicle: c.vehicle || "No vehicle", state: c.state,
    note: c.state === "Completed" ? (lv.type === "Morning" ? "All children at school" : "All children dropped") : c.state === "Not started" ? "Trip not started" : c.next ? `Next: ${c.next}` : c.last ? `Last: ${c.last}` : "",
  }));
  return {
    type: lv.type,
    on_road: lv.on_road, vehicles: g.f.items.length, in_maintenance: g.f.maintenance,
    students: active.reduce((n, x) => n + x.students, 0), routes: active.length,
    trips_done: done, trips_total: active.length * 2, delayed_now: lv.delayed,
    live: items,
    seats: active.map((r) => ({ route: r.name, used: r.students, seats: g.f.items.filter((v) => v.route === r.name && v.status === "Active").reduce((n, v) => n + v.seats, 0) })),
    attention: g.attention,
  };
}

// ═════════════ notifications ═════════════
export interface Note { key: string; tone: "bad" | "warn" | "info"; mark: string; title: string; note: string; when: string; href: string; read: boolean }
const BASE = "/transport";

export async function notifications(inst: string, profile: string): Promise<{ items: Note[]; unread: number }> {
  const now = today();
  const [g, lv, reqs, missed, exits, reads] = await Promise.all([
    gather(inst), liveBoard(inst), Promise.all([parentRequests(inst), appRequests(inst)]),
    supabaseAdmin.from("tr_boardings").select("student_id, at").eq("institution_id", inst).eq("trip_on", now).in("status", ["Missing at stop", "Absent, parent told"]).limit(2000),
    clearance(inst),
    supabaseAdmin.from("staff_notification_reads").select("key").eq("profile_id", profile).limit(5000),
  ]);
  const R = new Set(((check(reads) ?? []) as { key: string }[]).map((x) => x.key));
  const items: Note[] = [];
  const add = (n: Omit<Note, "read">) => items.push({ ...n, key: n.key.slice(0, 120), read: R.has(n.key.slice(0, 120)) });
  for (const c of lv.routes.filter((x) => x.state === "Delayed")) {
    add({ key: `delay:${now}:${lv.type}:${c.route}`, tone: "bad", mark: "!", title: `${c.route} running ${c.late} minutes late`, note: `${c.vehicle || c.reg_no || "No vehicle"} · ${lv.type === "Morning" ? "morning pickup" : "afternoon drop"}`, when: c.started ? `Today ${c.started}` : "Today", href: `${BASE}/tracking/trip-tracking?tab=live-trips` });
  }
  for (const a of g.attention.filter((x) => x.kind === "document" && x.state === "Expired")) add({ key: a.key, tone: "bad", mark: "!", title: `${a.bold} · ${a.text}`, note: "Renew before the next trip", when: a.sub, href: `${BASE}/vehicles/vehicles?tab=documents` });
  const [asked, fromApp] = reqs;
  const waiting = asked.items.filter((x) => x.status === "Pending"); const sent = fromApp.items.filter((x) => x.status === "Sent");
  if (waiting.length) add({ key: `requests:${waiting.map((x) => x.id.slice(0, 6)).sort().join(",")}`, tone: "warn", mark: "?", title: `${plural(waiting.length, "transport request")} from parents`, note: [...new Set(waiting.map((x) => x.type))].join(", "), when: nice(waiting[0].received), href: `${BASE}/allocation/student-allocation?tab=requests` });
  if (sent.length) add({ key: `app-requests:${sent.map((x) => x.code).sort().join(",")}`, tone: "warn", mark: "?", title: `${plural(sent.length, "request")} from the parent app`, note: sent.map((x) => x.student || x.parent).slice(0, 3).join(", "), when: nice(sent[0].raised_on), href: `${BASE}/allocation/student-allocation?tab=parent-app-requests` });
  const M = (check(missed) ?? []) as { student_id: string; at: string }[];
  if (M.length) add({ key: `missed:${now}:${M.length}`, tone: "warn", mark: "–", title: `${plural(M.length, "student")} did not board today`, note: "Check the missed boardings list", when: `Today ${istTime(M.map((x) => x.at).sort().pop()!)}`, href: `${BASE}/tracking/bus-attendance?tab=missed-boardings` });
  for (const a of g.attention.filter((x) => x.kind === "document" && x.state === "Expiring")) add({ key: a.key, tone: "warn", mark: "–", title: `${a.bold} · ${a.text} ${a.sub}`, note: "Renew before it expires", when: a.sub, href: `${BASE}/vehicles/vehicles?tab=documents` });
  for (const a of g.attention.filter((x) => x.kind === "crew" && x.state !== "Pending")) add({ key: a.key, tone: "warn", mark: "–", title: `${a.bold} · ${a.text}`, note: "Driver licence", when: "Today", href: `${BASE}/crew/drivers-and-attendants?tab=drivers` });
  for (const x of exits.items.filter((e) => e.state === "Pending")) add({ key: `exit:${x.id}`, tone: "info", mark: "E", title: `${x.name} is leaving · transport clearance pending`, note: x.check, when: `Last day ${nice(x.last_day)}`, href: `${BASE}/dashboard/transport-dashboard?tab=staff-exit-clearance` });
  return { items, unread: items.filter((n) => !n.read).length };
}
export async function markRead(inst: string, profile: string, input: unknown) {
  const { keys } = z.object({ keys: z.array(z.string().max(120)).max(200).optional() }).strict().parse(input ?? {});
  const list = keys?.length ? keys : (await notifications(inst, profile)).items.map((n) => n.key);
  if (list.length) check(await supabaseAdmin.from("staff_notification_reads").upsert(list.map((key) => ({ profile_id: profile, key })), { onConflict: "profile_id,key" }).select("key"));
  return { ok: true };
}

// ═════════════ the signed-in person, badges, search ═════════════
export async function me(inst: string, profile: string) {
  const [who, f, n] = await Promise.all([
    supabaseAdmin.from("user_profiles").select("first_name, last_name, designation").eq("id", profile).eq("institution_id", inst).maybeSingle(),
    fleet(inst), notifications(inst, profile),
  ]);
  const w = check(who) as { first_name: string; last_name: string; designation: string | null } | null;
  return { name: w ? `${w.first_name} ${w.last_name}`.replace(/ -$/, "").trim() : "", line: w?.designation || "Transport Manager", badges: { documents: f.due, unread: n.unread } };
}

export async function search(inst: string, raw: unknown) {
  const q = String(raw ?? "").trim().toLowerCase().slice(0, 60);
  if (q.length < 2) return { hits: [] };
  const [al, f, r] = await Promise.all([allocations(inst), fleet(inst), routes(inst)]);
  const plate = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const hits = [
    ...al.items.filter((x) => `${x.student} ${x.class_label}`.toLowerCase().includes(q)).slice(0, 6).map((x) => ({ type: "student" as const, id: x.student_id, title: x.student, subtitle: [x.class_label, x.route, x.stop].filter((s) => s && s !== "—").join(" · "), href: `${BASE}/allocation/student-allocation?tab=assign-students&q=${encodeURIComponent(x.student)}` })),
    ...f.items.filter((x) => `${x.name} ${x.reg_no}`.toLowerCase().includes(q) || plate(x.reg_no).includes(plate(q))).slice(0, 6).map((x) => ({ type: "vehicle" as const, id: x.id, title: x.name, subtitle: [x.reg_no, x.route].filter(Boolean).join(" · "), href: `${BASE}/vehicles/vehicles?tab=fleet&q=${encodeURIComponent(x.reg_no)}` })),
    ...r.items.filter((x) => `${x.name} ${x.area}`.toLowerCase().includes(q)).slice(0, 6).map((x) => ({ type: "route" as const, id: x.id, title: x.name, subtitle: x.area, href: `${BASE}/routes/routes-and-stops?tab=stops&route=${encodeURIComponent(x.name)}` })),
  ];
  return { hits };
}

// ═════════════ settings (the School Admin changes them) ═════════════
const ADMIN_PATH = { capacity: "Transport Settings › Capacity", rules: "Transport Settings › Route Rules", notes: "Transport Settings › Notifications", fee: "Fee Structure › Optional Fees", gps: "Settings › Integrations" };
export async function settingsView(inst: string) {
  const [s, fee, set, v] = await Promise.all([
    trSettings(inst),
    supabaseAdmin.from("fee_optional").select("amount_year").eq("institution_id", inst).eq("kind", "Transport").eq("status", "Active").order("pos").limit(1),
    feeSettings(inst),
    supabaseAdmin.from("tr_vehicles").select("gps").eq("institution_id", inst).limit(2000),
  ]);
  const year = (check(fee) as { amount_year: number }[])[0]?.amount_year ?? 0;
  const fitted = (check(v) as { gps: string }[]).filter((x) => x.gps !== "None").length;
  const alerts = ["Bus reached the stop", s.n_10min ? "10 minutes away" : "", s.n_board ? "boarded and dropped" : ""].filter(Boolean).join(", ");
  const items = [
    { key: "seats", setting: "Seats on each bus", value: `${s.seats_rule} · ${s.standing ? "standing allowed" : "no standing"}`, where: ADMIN_PATH.capacity },
    { key: "ride", setting: "Longest ride", value: `${s.max_trip_min} minutes from first pickup`, where: ADMIN_PATH.rules },
    { key: "pickups", setting: "Morning pickups", value: s.pickup_window, where: ADMIN_PATH.rules },
    { key: "alerts", setting: "Parent alerts", value: `${alerts} · app`, where: ADMIN_PATH.notes },
    { key: "delay", setting: "Delay alert", value: s.n_delay ? "When a bus is more than 10 minutes late" : "Off", where: ADMIN_PATH.notes },
    { key: "fee", setting: "Transport fee", value: year ? `₹${Math.round(year / set.terms.length).toLocaleString("en-IN")} a term, all routes` : "Not set", where: ADMIN_PATH.fee },
    { key: "tracking", setting: "Live bus tracking", value: `No GPS feed yet · ${plural(fitted, "vehicle")} with a device`, where: ADMIN_PATH.gps },
  ];
  return { items };
}
/** "Request a change" raises a help desk request to the School Admin. */
export async function requestChange(inst: string, profile: string, input: unknown) {
  const i = z.object({ setting: z.string().trim().max(30), change: z.string().trim().min(3, "Say what should change.").max(1000) }).strict().parse(input);
  const item = (await settingsView(inst)).items.find((x) => x.key === i.setting);
  if (!item) throw new HttpError(404, "Unknown setting.");
  const t = await raiseTicket(inst, profile, { category: "Other staff requests", subject: `Change a transport setting: ${item.setting}`, details: `Now: ${item.value}\nChanged in: ${item.where}\n\nRequested change: ${i.change}` }, "Staff");
  check(await supabaseAdmin.from("hd_tickets").update({ assigned_name: "School Admin" }).eq("id", t.id).eq("institution_id", inst).select("id"));
  return { code: t.code };
}

// ═════════════ messages to parents ═════════════
type Msg = { sent_on: string; created_at: string; subject: string; body: string | null; channel: string; status: string; student_id: string | null };
/** One line per message that went out: who it went to, and how many received it. */
export function groupMessages(rows: Msg[], routeOf: Map<string, string>, nameOf: Map<string, string>) {
  const g = new Map<string, { first: Msg; sent: number; delivered: number; students: Set<string> }>();
  for (const m of rows) {
    const k = `${m.sent_on}|${m.subject}|${m.body ?? ""}|${m.channel}`;
    const x = g.get(k) ?? { first: m, sent: 0, delivered: 0, students: new Set<string>() };
    x.sent++; if (["Delivered", "Read", "Replied"].includes(m.status)) x.delivered++;
    if (m.created_at < x.first.created_at) x.first = m;
    if (m.student_id) x.students.add(m.student_id);
    g.set(k, x);
  }
  return [...g.entries()].map(([id, x]) => {
    const ids = [...x.students]; const on = new Set(ids.map((s) => routeOf.get(s) ?? ""));
    const route = on.size === 1 ? [...on][0] : "";
    const to = ids.length === 1 && x.sent === 1 ? `Parent of ${nameOf.get(ids[0]) ?? "a student"}` : route ? `${route} parents` : "All bus riders";
    return { id, sent_at: x.first.created_at, to, channel: x.first.channel, message: x.first.body || x.first.subject, sent: x.sent, delivered: x.delivered, status: x.delivered >= x.sent ? "Delivered" : x.delivered === 0 ? "Not delivered" : "Partly delivered" };
  }).sort((a, b) => b.sent_at.localeCompare(a.sent_at));
}
export async function sentMessages(inst: string) {
  const since = addDays(today(), -9);
  const [m, al] = await Promise.all([
    supabaseAdmin.from("parent_messages").select("sent_on, created_at, subject, body, channel, status, student_id").eq("institution_id", inst).eq("direction", "out").gte("sent_on", since).or("subject.ilike.Bus %,subject.ilike.Transport %,body.ilike.Transport fee %").order("created_at", { ascending: false }).limit(20000),
    allocations(inst),
  ]);
  const items = groupMessages(check(m) as Msg[], new Map(al.items.map((x) => [x.student_id, x.route])), new Map(al.items.map((x) => [x.student_id, x.student])));
  const sent = items.reduce((n, x) => n + x.sent, 0); const delivered = items.reduce((n, x) => n + x.delivered, 0);
  return { items, messages: items.length, recipients: sent, delivered_pct: sent ? Math.round((delivered / sent) * 1000) / 10 : 100, not_delivered: sent - delivered };
}
// ═════════════ staff exit clearance (Transport) ═════════════
export const clearanceCheck = (bus: string | undefined, driver: boolean) => (driver ? `${bus ? `Bus ${bus}` : "Vehicle keys"}, logbook, fuel card` : "Vehicle and documents handed over");
export async function clearance(inst: string) {
  const ex = check(await supabaseAdmin.from("hr_exits").select("id, staff_id, last_day").eq("institution_id", inst).in("status", ["Approved", "Relieved"]).order("last_day")) as { id: string; staff_id: string; last_day: string }[];
  if (!ex.length) return { items: [] };
  const [cl, dir, d] = await Promise.all([
    supabaseAdmin.from("hr_clearance").select("exit_id, state").eq("dept", "Transport").in("exit_id", ex.map((x) => x.id)),
    directory(inst), drivers(inst),
  ]);
  const C = new Map((check(cl) as { exit_id: string; state: string }[]).map((x) => [x.exit_id, x.state]));
  const W = new Map(dir.items.map((x) => [x.id, x]));
  return {
    items: ex.filter((x) => (C.get(x.id) ?? "n/a") !== "n/a").map((x) => {
      const w = W.get(x.staff_id); const rec = d.items.find((y) => y.staff_id === x.staff_id);
      const isDriver = !!rec || /driver/i.test(w?.designation ?? "");
      return { id: x.id, staff_id: x.staff_id, name: w?.name ?? "", designation: w?.designation ?? "", last_day: x.last_day, check: clearanceCheck(rec?.vehicle_id ? rec.vehicle : undefined, isDriver), state: C.get(x.id)! };
    }),
  };
}
export async function markCleared(inst: string, profile: string, id: string) {
  const row = (await clearance(inst)).items.find((x) => x.id === id);
  if (!row) throw new HttpError(404, "Not found.");
  if (row.staff_id === profile) throw new HttpError(403, "Someone else has to clear your own exit.");
  return clearDept(inst, id, { dept: "Transport" });
}

/** Everything the assistant may read about stops and trips. */
export const network = async (inst: string) => ({ stops: (await stops(inst)).items, trips: (await trips(inst)).items.slice(0, 60) });
