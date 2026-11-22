import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { staffList } from "./attendance2.service";

/** Activities and events. Simple lists share one config-driven reader/writer; houses and event management are bespoke. */
const uid = z.string().uuid();
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
type Col = [name: string, kind: "t" | "n" | "d" | "e", opts?: string[], optional?: boolean];
const SPEC: Record<string, { table: string; order: string; desc?: boolean; cols: Col[]; where?: Record<string, string> }> = {
  sports: { table: "act_sports", order: "name", cols: [["name", "t"], ["venue", "t", undefined, true], ["teams", "t", undefined, true]] },
  teams: { table: "act_teams", order: "sport", cols: [["sport", "t"], ["team", "t"], ["coach", "t", undefined, true], ["players", "n", undefined, true], ["practice", "t", undefined, true], ["status", "e", ["Active", "Inactive"], true]] },
  competitions: { table: "act_competitions", order: "comp_date", desc: false, cols: [["name", "t"], ["level", "e", ["School", "Inter-school", "District", "State", "National"]], ["comp_date", "d"], ["registered", "n", undefined, true], ["result", "t", undefined, true], ["status", "e", ["Registrations open", "Results awaited", "Completed"], true]] },
  clubs: { table: "act_clubs", order: "name", cols: [["name", "t"], ["teacher", "t", undefined, true], ["members", "n", undefined, true], ["meets", "t", undefined, true], ["status", "e", ["Active", "Inactive"], true]] },
  cultural: { table: "act_cultural", order: "name", cols: [["name", "t"], ["what", "t", undefined, true], ["days", "t", undefined, true]] },
  participation: { table: "act_participation", order: "event", cols: [["event", "t"], ["status", "t", undefined, true], ["students", "n", undefined, true]] },
  awards: { table: "act_awards", order: "award_date", desc: true, cols: [["award", "t"], ["given_to", "t"], ["a_type", "e", ["Student award", "Staff award"]], ["class_dept", "t", undefined, true], ["award_date", "d"], ["status", "e", ["Announced", "Presented"], true]] },
  comms: { table: "act_comms", order: "comm_date", desc: true, cols: [["kind", "e", ["Invitation", "Notice"]], ["title", "t"], ["sent_to", "t"], ["comm_date", "d"], ["status", "e", ["Draft", "Live"], true]] },
};
const shape = (cols: Col[], partial: boolean) => {
  const o: Record<string, z.ZodTypeAny> = {};
  for (const [n, k, opts, opt] of cols) { const base = k === "t" ? (opt ? z.string().trim().max(200) : z.string().trim().min(1, "Fill in every required field.").max(200)) : k === "n" ? z.number().int().min(0).max(100_000_000) : k === "d" ? z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.") : z.enum(opts as [string, ...string[]]); o[n] = partial || opt ? base.optional() : base; }
  return z.object(o).strict();
};
const spec = (k: string) => { const s = SPEC[k]; if (!s) throw new HttpError(404, "Not found."); return s; };
export async function actList(inst: string, key: string) {
  const s = spec(key); return { items: check(await supabaseAdmin.from(s.table).select(["id", ...s.cols.map((c) => c[0])].join(", ")).eq("institution_id", inst).order(s.order, { ascending: !s.desc }).order("created_at", { ascending: false }).limit(3000)) as unknown[] };
}
export async function actAdd(inst: string, key: string, input: unknown) {
  const s = spec(key); const i = shape(s.cols, false).parse(input);
  if (key === "comms" && (i as { kind: string }).kind === "Notice") (i as { status?: string }).status ??= "Live";
  return check(await supabaseAdmin.from(s.table).insert({ institution_id: inst, ...i }).select("id").single());
}
export async function actEdit(inst: string, key: string, id: string, input: unknown) {
  const s = spec(key); const i = shape(s.cols, true).parse(input); if (!Object.keys(i).length) throw new HttpError(400, "Nothing to change.");
  const r = check(await supabaseAdmin.from(s.table).update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ event reports (from the school calendar) ═════════════
export async function eventSummary(inst: string) {
  const e = check(await supabaseAdmin.from("calendar_events").select("id, title, event_date, audience, note, kind").eq("institution_id", inst).eq("kind", "Event").order("event_date", { ascending: false }).limit(2000)) as { id: string; title: string; event_date: string; audience: string; note: string | null }[]; const t = today();
  return { items: e.map((x) => { const [venue, incharge] = (x.note ?? "").split(" · "); return { id: x.id, title: x.title, event_date: x.event_date, venue: venue ?? "", in_charge: incharge ?? "", audience: x.audience, status: x.event_date < t ? "Completed" : "Planned" }; }) };
}

// ═════════════ houses ═════════════
export async function houses(inst: string) {
  const [h, p, st] = await Promise.all([supabaseAdmin.from("act_houses").select("id, name").eq("institution_id", inst).order("name"), supabaseAdmin.from("act_house_points").select("id, house_id, student_label, points, reason, awarded_by, awarded_on").eq("institution_id", inst).order("awarded_on", { ascending: false }).order("id").limit(5000), roster(inst)]);
  const H = check(h) as { id: string; name: string }[]; const P = check(p) as { id: string; house_id: string; student_label: string; points: number; reason: string; awarded_by: string; awarded_on: string }[];
  return { students: st.items.filter((x) => x.status === "Enrolled" || x.enrol_status === "Enrolled").slice(0, 3000).map((x) => ({ id: x.id, name: x.name, label: `${x.name} · ${x.class_label}` })), standings: H.map((x) => ({ ...x, points: P.filter((y) => y.house_id === x.id).reduce((n, y) => n + y.points, 0) })).sort((a, b) => b.points - a.points), recent: P.slice(0, 20).map((x) => ({ ...x, house: H.find((y) => y.id === x.house_id)?.name ?? "" })) };
}
export async function addHouse(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the house name.").max(40) }).strict().parse(input);
  if ((check(await supabaseAdmin.from("act_houses").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[]).length) throw new HttpError(409, "That house exists.");
  return check(await supabaseAdmin.from("act_houses").insert({ institution_id: inst, name: i.name }).select("id").single());
}
export async function awardPoints(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, house_id: uid, points: z.number().int().min(1).max(100), reason: z.string().trim().min(3, "Say what it is for.").max(160), awarded_by: z.string().trim().max(80).optional() }).strict().parse(input);
  if (!check(await supabaseAdmin.from("act_houses").select("id").eq("id", i.house_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "House not found.");
  const s = (await roster(inst)).items.find((x) => x.id === i.student_id); if (!s) throw new HttpError(404, "Student not found.");
  return check(await supabaseAdmin.from("act_house_points").insert({ institution_id: inst, house_id: i.house_id, student_id: i.student_id, student_label: `${s.name} · ${s.class_label}`, points: i.points, reason: i.reason, awarded_by: i.awarded_by ?? "School office" }).select("id").single());
}

// ═════════════ event management ═════════════
const ETYPES = ["Celebration", "Trip", "Sports", "Competition", "Other"] as const;
export async function eventMgmt(inst: string) {
  const [e, v, d, st] = await Promise.all([supabaseAdmin.from("event_mgmt").select("id, title, event_date, for_label, etype, join_mode, registered, capacity, fees_collected, budget, spent, in_charge, attended").eq("institution_id", inst).order("event_date").limit(2000), supabaseAdmin.from("event_volunteers").select("id, event_id, name, student_label, role, time_label, status").eq("institution_id", inst).limit(3000), supabaseAdmin.from("event_duties").select("id, event_id, staff_name, duty, time_label").eq("institution_id", inst).limit(3000), staffList(inst)]);
  const E = check(e) as { id: string; title: string; event_date: string; for_label: string; etype: string; join_mode: string; registered: number; capacity: number | null; fees_collected: number; budget: number; spent: number; in_charge: string; attended: number | null }[]; const t = today(); const T = new Map(E.map((x) => [x.id, x.title]));
  return { types: ETYPES, staff: st.map((x) => x.name), events: E.map((x) => ({ ...x, status: x.event_date < t ? "Done" : "Upcoming" })), volunteers: (check(v) as { id: string; event_id: string; name: string; student_label: string; role: string; time_label: string; status: string }[]).map((x) => ({ ...x, event: T.get(x.event_id) ?? "" })), duties: (check(d) as { id: string; event_id: string; staff_name: string; duty: string; time_label: string }[]).map((x) => ({ ...x, event: T.get(x.event_id) ?? "" })) };
}
export async function addMgmtEvent(inst: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(2, "Enter the event.").max(160), event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), for_label: z.string().trim().min(1).max(60), etype: z.enum(ETYPES), join_mode: z.string().trim().max(40), registered: z.number().int().min(0).max(1_000_000).optional(), capacity: z.number().int().min(0).max(1_000_000).nullable().optional(), fees_collected: z.number().int().min(0).max(100_000_000).optional(), budget: z.number().int().min(0).max(1_000_000_000).optional(), spent: z.number().int().min(0).max(1_000_000_000).optional(), in_charge: z.string().trim().max(80).optional() }).strict().parse(input);
  return check(await supabaseAdmin.from("event_mgmt").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function editMgmtEvent(inst: string, id: string, input: unknown) {
  const i = z.object({ registered: z.number().int().min(0).max(1_000_000).optional(), capacity: z.number().int().min(0).max(1_000_000).nullable().optional(), fees_collected: z.number().int().min(0).max(100_000_000).optional(), budget: z.number().int().min(0).max(1_000_000_000).optional(), spent: z.number().int().min(0).max(1_000_000_000).optional(), attended: z.number().int().min(0).max(1_000_000).optional() }).strict().parse(input);
  if (!Object.keys(i).length) throw new HttpError(400, "Nothing to change."); const cur = check(await supabaseAdmin.from("event_mgmt").select("registered, capacity, attended").eq("id", id).eq("institution_id", inst).maybeSingle()) as { registered: number; capacity: number | null; attended: number | null } | null; if (!cur) throw new HttpError(404, "Not found.");
  const reg = i.registered ?? cur.registered; const cap = i.capacity === undefined ? cur.capacity : i.capacity; if (cap !== null && cap !== undefined && reg > cap) throw new HttpError(400, "Registrations are over the places available.");
  check(await supabaseAdmin.from("event_mgmt").update(i).eq("id", id).eq("institution_id", inst).select("id")); return { ok: true };
}
export async function addVolunteer(inst: string, input: unknown) {
  const i = z.object({ event_id: uid, name: z.string().trim().min(2).max(80), student_label: z.string().trim().max(80).optional(), role: z.string().trim().min(2).max(80), time_label: z.string().trim().max(40).optional() }).strict().parse(input);
  if (!check(await supabaseAdmin.from("event_mgmt").select("id").eq("id", i.event_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Event not found."); return check(await supabaseAdmin.from("event_volunteers").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function confirmVolunteer(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("event_volunteers").update({ status: "Confirmed" }).eq("id", id).eq("institution_id", inst).eq("status", "Requested").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "Already confirmed."); return { ok: true };
}
export async function addDuty(inst: string, input: unknown) {
  const i = z.object({ event_id: uid, staff_name: z.string().trim().min(2).max(80), duty: z.string().trim().min(2).max(80), time_label: z.string().trim().max(40).optional() }).strict().parse(input);
  if (!check(await supabaseAdmin.from("event_mgmt").select("id").eq("id", i.event_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Event not found."); const [fn, ...rest] = i.staff_name.split(/s+/); const who = check(await supabaseAdmin.from("user_profiles").select("id").eq("institution_id", inst).ilike("first_name", fn).ilike("last_name", rest.join(" ") || "%").limit(2)) as { id: string }[]; // the duty belongs to the teacher when the name is unambiguous
  return check(await supabaseAdmin.from("event_duties").insert({ institution_id: inst, ...i, staff_id: who.length === 1 ? who[0].id : null }).select("id").single());
}
