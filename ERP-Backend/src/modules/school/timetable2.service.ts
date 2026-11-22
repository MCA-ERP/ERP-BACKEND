import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { allSlots, candidates, clashSet, currentSections, periods, subjectNames, teacherNames, weekDays } from "./timetable.service";
import type { Slot } from "./timetable.service";
import { getRules } from "./timetable.service";

/** Teacher views, rooms, allocations, substitutions and timetable reports. */
const uid = z.string().uuid();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
export const LIMIT = 40;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const istDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const dayOf = (date: string) => { const d = new Date(date + "T00:00:00Z").getUTCDay(); return d === 0 ? 0 : d; };
const weekStart = (date: string) => { const d = new Date(date + "T00:00:00Z"); const k = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - k * 86400000).toISOString().slice(0, 10); };
const tm = (ts: string) => new Date(ts).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

// ═════════════ teachers ═════════════
export async function teacherList(inst: string) {
  const [c, names, subs] = await Promise.all([candidates(inst), teacherNames(inst), subjectNames(inst)]);
  const sn = new Map(subs.map((s) => [s.id, s.name]));
  const by = new Map<string, string[]>();
  for (const x of c) by.set(x.teacher_id, [...new Set([...(by.get(x.teacher_id) ?? []), sn.get(x.subject_id) ?? ""])].filter(Boolean));
  return { items: [...by.entries()].map(([id, s]) => ({ id, name: names.get(id) ?? "", subject: s[0] ?? "", subjects: s })).filter((t) => t.name).sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function teacherWeek(inst: string, teacherId: string) {
  const [ps, days, secs, slots, names, subs] = await Promise.all([periods(inst), weekDays(inst), currentSections(inst), allSlots(inst), teacherNames(inst), subjectNames(inst)]);
  if (!names.has(teacherId)) throw new HttpError(404, "Teacher not found.");
  const label = new Map(secs.sections.map((s) => [s.id, s.label]));
  const sn = new Map(subs.map((s) => [s.id, s.name]));
  const mine = slots.filter((s) => s.teacher_id === teacherId && label.has(s.section_id));
  const teaching = ps.filter((p) => p.kind === "Teaching");
  return {
    name: names.get(teacherId), days, periods: ps, limit: LIMIT, per_week: mine.length, free: teaching.length * days - mine.length, classes: new Set(mine.map((s) => s.section_id)).size,
    slots: mine.map((s) => ({ day: s.day, period_id: s.period_id, class_label: label.get(s.section_id) ?? "", subject: sn.get(s.subject_id ?? "") ?? "" })),
  };
}

export async function allocations(inst: string) {
  const [rows, names, subs, secs] = await Promise.all([candidates(inst), teacherNames(inst), subjectNames(inst), currentSections(inst)]);
  const sn = new Map(subs.map((s) => [s.id, s.name]));
  const label = new Map(secs.sections.map((s) => [s.id, s.label]));
  const full = check(await supabaseAdmin.from("teacher_subjects").select("id, teacher_id, subject_id, section_id, periods").eq("institution_id", inst).limit(5000)) as { id: string; teacher_id: string; subject_id: string; section_id: string | null; periods: number }[];
  void rows;
  return { items: full.map((r) => ({ id: r.id, section: r.section_id ? label.get(r.section_id) ?? "" : "All classes", subject: sn.get(r.subject_id) ?? "", teacher: names.get(r.teacher_id) ?? "", periods: r.periods })).sort((a, b) => a.section.localeCompare(b.section, undefined, { numeric: true }) || a.subject.localeCompare(b.subject)) };
}

// ═════════════ rooms ═════════════
interface RoomRow { id: string; name: string; block: string | null; capacity: number; section_id: string | null; projector: boolean; status: string }
export async function listRooms(inst: string) {
  const [r, secs] = await Promise.all([supabaseAdmin.from("rooms").select("id, name, block, capacity, section_id, projector, status").eq("institution_id", inst), currentSections(inst).catch(() => ({ sections: [] as { id: string; label: string }[] }))]);
  const label = new Map(secs.sections.map((s) => [s.id, s.label]));
  return { sections: secs.sections.map((s) => ({ id: s.id, label: s.label })), items: (check(r) as unknown as RoomRow[]).map((x) => ({ id: x.id, name: x.name, block: x.block ?? "", capacity: x.capacity, section_id: x.section_id, allocated_to: x.section_id ? label.get(x.section_id) ?? "" : "", projector: x.projector, status: x.status })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) };
}
const roomBody = z.object({ name: z.string().trim().min(1, "Enter the room.").max(40), block: z.string().trim().max(40).optional(), capacity: z.number().int().min(1).max(1000), section_id: uid.nullable().optional(), projector: z.boolean(), status: z.enum(["Available", "Occupied", "Maintenance"]).optional() }).strict();
async function sectionOk(inst: string, id: string | null | undefined) {
  if (!id) return;
  const s = check(await supabaseAdmin.from("sections").select("id").eq("id", id).eq("institution_id", inst).maybeSingle());
  if (!s) throw new HttpError(404, "Section not found.");
}
export async function addRoom(inst: string, input: unknown) {
  const i = roomBody.parse(input);
  await sectionOk(inst, i.section_id);
  const dup = check(await supabaseAdmin.from("rooms").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "A room with that name exists.");
  return check(await supabaseAdmin.from("rooms").insert({ institution_id: inst, name: i.name, block: i.block || null, capacity: i.capacity, section_id: i.section_id ?? null, projector: i.projector, status: i.status ?? "Available" }).select("id").single());
}
export async function updateRoom(inst: string, id: string, input: unknown) {
  const i = roomBody.parse(input);
  await sectionOk(inst, i.section_id);
  const dup = check(await supabaseAdmin.from("rooms").select("id").eq("institution_id", inst).ilike("name", i.name).neq("id", id)) as unknown[];
  if (dup.length) throw new HttpError(409, "A room with that name exists.");
  const r = check(await supabaseAdmin.from("rooms").update({ name: i.name, block: i.block || null, capacity: i.capacity, section_id: i.section_id ?? null, projector: i.projector, ...(i.status ? { status: i.status } : {}) }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Room not found.");
  return { ok: true };
}

// ═════════════ conflicts and workload ═════════════
function roomCap(room: string) { const m = /\((\d+) classes? at a time\)/i.exec(room); return m ? Number(m[1]) : 1; }
export async function conflicts(inst: string) {
  const [ps, secs, slots, names, rules] = await Promise.all([periods(inst), currentSections(inst), allSlots(inst), teacherNames(inst), getRules(inst)]);
  const label = new Map(secs.sections.map((s) => [s.id, s.label]));
  const pl = new Map(ps.map((p) => [p.id, p.label]));
  const mine = slots.filter((s) => label.has(s.section_id));
  const items: { kind: string; where: string; when: string; who: string; with: string; sections: string[] }[] = [];
  for (const g of clashSet(mine)) { const secsOf = g.map((x) => label.get(x.section_id) ?? ""); items.push({ kind: "Teacher double-booked", where: secsOf[0], when: `${DAYS[g[0].day - 1]} ${pl.get(g[0].period_id)}`, who: names.get(g[0].teacher_id ?? "") ?? "", with: `Also in ${secsOf.slice(1).join(", ")}`, sections: secsOf }); }
  const roomOf = new Map(rules.items.map((r) => [r.subject_id, r.room]));
  const by = new Map<string, Slot[]>();
  for (const s of mine) { const room = roomOf.get(s.subject_id ?? "") ?? "Classroom"; if (room.toLowerCase().startsWith("classroom")) continue; const k = `${room}|${s.day}|${s.period_id}`; by.set(k, [...(by.get(k) ?? []), s]); }
  for (const [k, g] of by) { const room = k.split("|")[0]; if (g.length > roomCap(room)) items.push({ kind: "Room double-booked", where: room.replace(/\s*\(.*\)/, ""), when: `${DAYS[g[0].day - 1]} ${pl.get(g[0].period_id)}`, who: g.map((x) => label.get(x.section_id) ?? "").join(", "), with: "—", sections: g.map((x) => label.get(x.section_id) ?? "") }); }
  return { items };
}
export async function workload(inst: string) {
  const [slots, secs, names] = await Promise.all([allSlots(inst), currentSections(inst), teacherNames(inst)]);
  const ok = new Set(secs.sections.map((s) => s.id));
  const n = new Map<string, number>();
  for (const s of slots) if (s.teacher_id && ok.has(s.section_id)) n.set(s.teacher_id, (n.get(s.teacher_id) ?? 0) + 1);
  return { limit: LIMIT, items: [...n.entries()].map(([id, c]) => ({ id, name: names.get(id) ?? "", periods: c })).sort((a, b) => b.periods - a.periods) };
}

// ═════════════ substitution ═════════════
async function context(inst: string, date: string) {
  iso.parse(date);
  const day = dayOf(date);
  const [ps, secs, slots, names, subs, cand, att, leaves, done] = await Promise.all([
    periods(inst), currentSections(inst), allSlots(inst), teacherNames(inst), subjectNames(inst), candidates(inst),
    supabaseAdmin.from("staff_attendance").select("staff_id").eq("institution_id", inst).eq("att_date", date).eq("status", "A"),
    supabaseAdmin.from("leave_requests").select("profile_id, leave_type").eq("institution_id", inst).eq("status", "Approved").lte("from_date", date).gte("to_date", date),
    supabaseAdmin.from("substitutions").select("id, sub_date, period_id, section_id, subject_id, absent_teacher_id, substitute_id, status, created_at").eq("institution_id", inst).gte("sub_date", weekStart(date)).lte("sub_date", date),
  ]);
  const label = new Map(secs.sections.map((s) => [s.id, s.label]));
  const sn = new Map(subs.map((s) => [s.id, s.name]));
  const pl = new Map(ps.map((p) => [p.id, p]));
  const reason = new Map<string, string>();
  for (const a of (check(att) ?? []) as { staff_id: string }[]) reason.set(a.staff_id, "Marked absent");
  for (const l of (check(leaves) ?? []) as { profile_id: string; leave_type: string }[]) reason.set(l.profile_id, `${l.leave_type} leave (approved)`);
  const week = (check(done) ?? []) as { sub_date: string; period_id: string; section_id: string; subject_id: string | null; absent_teacher_id: string; substitute_id: string; status: string; id: string }[];
  const today = slots.filter((s) => s.day === day && label.has(s.section_id) && s.teacher_id && pl.get(s.period_id)?.kind === "Teaching");
  return { day, ps, label, sn, pl, names, cand, reason, week, today, slots };
}

type Ctx = Awaited<ReturnType<typeof context>>;
function candidatesFor(c: Ctx, date: string, p: { period_id: string; section_id: string; subject_id: string | null }, taken: Set<string>) {
  const covers = new Map<string, number>();
  for (const w of c.week) covers.set(w.substitute_id, (covers.get(w.substitute_id) ?? 0) + 1);
  const pool = new Set<string>([...c.cand.map((x) => x.teacher_id), ...c.slots.map((s) => s.teacher_id).filter((x): x is string => !!x)]);
  const out: { id: string; name: string; score: number; reason: string; today: number }[] = [];
  for (const t of pool) {
    if (c.reason.has(t) || !c.names.has(t)) continue;
    const mine = c.today.filter((s) => s.teacher_id === t);
    if (mine.some((s) => s.period_id === p.period_id)) continue;
    if (taken.has(`${t}|${p.period_id}`) || c.week.some((w) => w.sub_date === date && w.period_id === p.period_id && w.substitute_id === t)) continue;
    const teaches = p.subject_id ? c.cand.some((x) => x.teacher_id === t && x.subject_id === p.subject_id) : false;
    const knows = c.cand.some((x) => x.teacher_id === t && x.section_id === p.section_id) || c.slots.some((s) => s.teacher_id === t && s.section_id === p.section_id);
    const cv = covers.get(t) ?? 0;
    const how = teaches ? `teaches ${c.sn.get(p.subject_id ?? "") ?? "it"}` : knows ? `knows ${c.label.get(p.section_id) ?? "the class"}` : "free this period";
    out.push({ id: t, name: c.names.get(t) ?? "", score: (teaches ? 100 : 0) + (knows ? 50 : 0) - cv * 10 - mine.length, today: mine.length, reason: `${how} · ${cv} cover${cv === 1 ? "" : "s"} this week · ${mine.length} period${mine.length === 1 ? "" : "s"} today` });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export async function substitutionToday(inst: string, date: string) {
  const c = await context(inst, date);
  const mineSubs = new Map(c.week.filter((w) => w.sub_date === date).map((w) => [`${w.period_id}|${w.section_id}`, w]));
  const absentIds = [...c.reason.keys()];
  const taken = new Set<string>();
  const items = c.today.filter((s) => s.teacher_id && c.reason.has(s.teacher_id)).sort((a, b) => (c.pl.get(a.period_id)?.starts ?? "").localeCompare(c.pl.get(b.period_id)?.starts ?? "")).map((s) => {
    const done = mineSubs.get(`${s.period_id}|${s.section_id}`);
    const cands = done ? [] : candidatesFor(c, date, s, taken);
    return { period_id: s.period_id, period: c.pl.get(s.period_id)?.label ?? "", starts: c.pl.get(s.period_id)?.starts ?? "", section_id: s.section_id, class_label: c.label.get(s.section_id) ?? "", subject_id: s.subject_id, subject: c.sn.get(s.subject_id ?? "") ?? "", absent_id: s.teacher_id as string, absent: c.names.get(s.teacher_id as string) ?? "", reason: c.reason.get(s.teacher_id as string) ?? "", covered_by: done ? c.names.get(done.substitute_id) ?? "" : "", candidates: cands.slice(0, 5) };
  });
  const covers = new Map<string, number>();
  for (const w of c.week) covers.set(w.substitute_id, (covers.get(w.substitute_id) ?? 0) + 1);
  return { date, weekday: day(date), absent: absentIds.filter((a) => items.some((i) => i.absent_id === a)).map((a) => ({ id: a, name: c.names.get(a) ?? "", reason: c.reason.get(a) ?? "" })), items, covered: items.filter((i) => i.covered_by).length, max_covers: Math.max(0, ...covers.values()) };
}
function day(date: string) { return new Date(date + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }); }

export async function freePeriods(inst: string, date: string, periodId?: string) {
  const c = await context(inst, date);
  const teaching = c.ps.filter((p) => p.kind === "Teaching");
  const now = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const p = teaching.find((x) => x.id === periodId) ?? teaching.find((x) => x.starts <= now && x.ends > now) ?? teaching.find((x) => x.starts > now) ?? teaching[0];
  if (!p) return { date, period: null, periods: teaching, items: [] };
  const taken = new Set<string>();
  const pool = new Set<string>([...c.cand.map((x) => x.teacher_id), ...c.slots.map((s) => s.teacher_id).filter((x): x is string => !!x)]);
  const items = [...pool].filter((t) => c.names.has(t) && !c.reason.has(t) && !c.today.some((s) => s.teacher_id === t && s.period_id === p.id)).map((t) => {
    const mine = c.today.filter((s) => s.teacher_id === t);
    const next = mine.filter((s) => (c.pl.get(s.period_id)?.starts ?? "") > p.starts).sort((a, b) => (c.pl.get(a.period_id)?.starts ?? "").localeCompare(c.pl.get(b.period_id)?.starts ?? ""))[0];
    const subj = c.cand.find((x) => x.teacher_id === t);
    return { id: t, name: c.names.get(t) ?? "", subject: subj ? c.sn.get(subj.subject_id) ?? "" : "", periods_today: mine.length, next: next ? `${c.label.get(next.section_id) ?? ""} · ${c.pl.get(next.period_id)?.label}` : "—" };
  }).sort((a, b) => a.name.localeCompare(b.name));
  void taken;
  return { date, period: { id: p.id, label: p.label }, periods: teaching.map((x) => ({ id: x.id, label: x.label })), items };
}

async function doAssign(inst: string, c: Ctx, date: string, i: { period_id: string; section_id: string; absent_teacher_id: string; substitute_id: string }, actor?: string) {
  const slot = c.today.find((s) => s.period_id === i.period_id && s.section_id === i.section_id && s.teacher_id === i.absent_teacher_id);
  if (!slot) throw new HttpError(404, "That period isn't on the absent teacher's timetable today.");
  if (!c.reason.has(i.absent_teacher_id)) throw new HttpError(409, "That teacher isn't absent today.");
  const dup = c.week.find((w) => w.sub_date === date && w.period_id === i.period_id && w.section_id === i.section_id);
  if (dup) throw new HttpError(409, "That period is already covered.");
  const ok = candidatesFor(c, date, slot, new Set()).some((x) => x.id === i.substitute_id);
  if (!ok) throw new HttpError(409, "That teacher isn't free in that period.");
  const r = check(await supabaseAdmin.from("substitutions").insert({ institution_id: inst, sub_date: date, period_id: i.period_id, section_id: i.section_id, subject_id: slot.subject_id, absent_teacher_id: i.absent_teacher_id, substitute_id: i.substitute_id, created_by: actor ?? null }).select("id, sub_date, period_id, section_id, subject_id, absent_teacher_id, substitute_id, status").single()) as Ctx["week"][number];
  c.week.push(r);
  return r;
}
export async function assignSubstitute(inst: string, input: unknown, actor?: string) {
  const i = z.object({ date: iso.optional(), period_id: uid, section_id: uid, absent_teacher_id: uid, substitute_id: uid }).strict().parse(input);
  const date = i.date ?? istDate();
  const c = await context(inst, date);
  await doAssign(inst, c, date, i, actor);
  return { ok: true };
}
export async function assignBest(inst: string, date: string, actor?: string) {
  const c = await context(inst, date);
  const covered = new Set(c.week.filter((w) => w.sub_date === date).map((w) => `${w.period_id}|${w.section_id}`));
  let n = 0; let left = 0;
  for (const s of c.today.filter((x) => x.teacher_id && c.reason.has(x.teacher_id) && !covered.has(`${x.period_id}|${x.section_id}`))) {
    const best = candidatesFor(c, date, s, new Set())[0];
    if (!best) { left++; continue; }
    await doAssign(inst, c, date, { period_id: s.period_id, section_id: s.section_id, absent_teacher_id: s.teacher_id as string, substitute_id: best.id }, actor);
    n++;
  }
  return { assigned: n, left };
}
export async function listSubstitutions(inst: string) {
  const [rows, ps, secs, names, subs] = await Promise.all([supabaseAdmin.from("substitutions").select("id, sub_date, period_id, section_id, subject_id, absent_teacher_id, substitute_id, status").eq("institution_id", inst).order("sub_date", { ascending: false }).order("created_at", { ascending: false }).limit(2000), periods(inst), currentSections(inst), teacherNames(inst), subjectNames(inst)]);
  const pl = new Map(ps.map((p) => [p.id, p.label])); const label = new Map(secs.sections.map((s) => [s.id, s.label])); const sn = new Map(subs.map((s) => [s.id, s.name]));
  return { items: (check(rows) as { id: string; sub_date: string; period_id: string; section_id: string; subject_id: string | null; absent_teacher_id: string; substitute_id: string; status: string }[]).map((r) => ({ id: r.id, date: r.sub_date, period: pl.get(r.period_id) ?? "", class_label: label.get(r.section_id) ?? "", absent: names.get(r.absent_teacher_id) ?? "", substitute: names.get(r.substitute_id) ?? "", subject: sn.get(r.subject_id ?? "") ?? "", status: r.status })) };
}
export async function setSubstitutionStatus(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Completed"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("substitutions").update({ status }).eq("id", id).eq("institution_id", inst).eq("status", "Assigned").select("id")) as unknown[];
  if (!r.length) throw new HttpError(409, "That substitution can't be completed.");
  return { ok: true };
}
void tm;
