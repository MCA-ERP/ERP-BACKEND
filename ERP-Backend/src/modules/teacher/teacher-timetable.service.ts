import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { LIMIT } from "../school/timetable2.service";
import { hm, istDate, one, secLabel, sectionMap } from "./teacher.service";

/** My Timetable (daily and weekly) and the substitution pages: all of it for this teacher only. */
interface Period { id: string; label: string; starts: string; ends: string; kind: string }
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dow = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // Monday = 1 … Sunday = 7
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function base(inst: string, me: string) {
  const [ps, slots, wk] = await Promise.all([
    supabaseAdmin.from("tt_periods").select("id, label, starts, ends, kind").eq("institution_id", inst).order("starts"),
    supabaseAdmin.from("tt_slots").select("section_id, day, period_id, subjects:subject_id(name)").eq("institution_id", inst).eq("teacher_id", me).limit(2000),
    supabaseAdmin.from("calendar_settings").select("school_week").eq("institution_id", inst).maybeSingle(),
  ]);
  const periods = ((check(ps) ?? []) as Period[]).map((p) => ({ ...p, starts: p.starts.slice(0, 5), ends: p.ends.slice(0, 5) }));
  const slotRows = (check(slots) ?? []) as unknown as { section_id: string; day: number; period_id: string; subjects: { name: string } | { name: string }[] | null }[];
  const days = (check(wk) as { school_week: string } | null)?.school_week === "Monday – Friday" ? 5 : 6;
  return { periods, slotRows: slotRows.filter((s) => s.day <= days), days };
}

async function subsFor(inst: string, me: string, from: string, to: string) {
  const [mineAway, mineCover] = await Promise.all([
    supabaseAdmin.from("substitutions").select("id, sub_date, period_id, section_id, status").eq("institution_id", inst).eq("absent_teacher_id", me).gte("sub_date", from).lte("sub_date", to),
    supabaseAdmin.from("substitutions").select("id, sub_date, period_id, section_id, status, subjects:subject_id(name), absent:absent_teacher_id(first_name, last_name)").eq("institution_id", inst).eq("substitute_id", me).gte("sub_date", from).lte("sub_date", to),
  ]);
  return { away: (check(mineAway) ?? []) as { id: string; sub_date: string; period_id: string; section_id: string; status: string }[], cover: (check(mineCover) ?? []) as unknown as { id: string; sub_date: string; period_id: string; section_id: string; status: string; subjects: { name: string } | { name: string }[] | null; absent: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[] };
}

/** The topic being taught: the lesson plan for that week if there is one. */
async function topics(inst: string, me: string, from: string, to: string) {
  const r = (check(await supabaseAdmin.from("lesson_plans").select("section_id, topic, week_of").eq("institution_id", inst).eq("teacher_id", me).gte("week_of", addDay(from, -6)).lte("week_of", to).limit(500)) ?? []) as { section_id: string; topic: string; week_of: string }[];
  return (section: string, date: string) => r.filter((x) => x.section_id === section && x.week_of <= date && addDay(x.week_of, 6) >= date).sort((a, b) => (a.week_of < b.week_of ? 1 : -1))[0]?.topic ?? "";
}

export async function daily(inst: string, me: string) {
  const today = istDate(); const now = hm(new Date().toISOString()); const dn = dow(today);
  const { periods, slotRows } = await base(inst, me);
  const { away, cover } = await subsFor(inst, me, today, today);
  const secIds = [...new Set([...slotRows.map((s) => s.section_id), ...cover.map((c) => c.section_id)])];
  const [sm, topic] = await Promise.all([sectionMap(inst, secIds), topics(inst, me, today, today)]);
  const awayKey = new Set(away.map((a) => `${a.period_id}:${a.section_id}`));
  const rows = periods.filter((p) => p.kind === "Teaching").map((p) => {
    const mine = dn <= 6 ? slotRows.find((s) => s.day === dn && s.period_id === p.id && !awayKey.has(`${p.id}:${s.section_id}`)) : undefined;
    const sub = cover.find((c) => c.period_id === p.id);
    const sec = sub ? sub.section_id : mine?.section_id;
    return { period: p.label, period_id: p.id, starts: p.starts, ends: p.ends, free: !sec, section_id: sec ?? null, section: sec ? secLabel(sm.get(sec) ?? null) : "", subject: sub ? one(sub.subjects)?.name ?? "" : one(mine?.subjects ?? null)?.name ?? "", room: sec ? sm.get(sec)?.room ?? null : null, topic: sec ? topic(sec, today) : "", substitution: !!sub, substitution_id: sub?.id ?? null, substitution_status: sub?.status ?? null, state: "" as string };
  });
  let next = false;
  const items = rows.map((r) => {
    let state: string;
    if (r.ends <= now) state = r.free ? "Free" : "Done";
    else if (r.starts <= now) state = "Now";
    else if (r.free) state = "Free";
    else if (!next) { state = "Next"; next = true; } else state = "Upcoming";
    return { ...r, state };
  });
  const classes = [...new Set(items.filter((i) => i.section_id).map((i) => i.section_id as string))];
  return { date: today, weekday: new Date(`${today}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" }), items, classes: classes.map((id) => ({ id, label: secLabel(sm.get(id) ?? null) })), sections: new Set(slotRows.map((s) => s.section_id)).size, per_week: slotRows.length };
}

export async function weekly(inst: string, me: string) {
  const today = istDate(); const dn = dow(today);
  const { periods, slotRows, days } = await base(inst, me);
  const monday = addDay(today, -(dn - 1));
  const { away, cover } = await subsFor(inst, me, monday, addDay(monday, days - 1));
  const secIds = [...new Set([...slotRows.map((s) => s.section_id), ...cover.map((c) => c.section_id)])];
  const sm = await sectionMap(inst, secIds);
  const teaching = periods.filter((p) => p.kind === "Teaching");
  const grid = teaching.map((p) => ({ period: p.label, starts: p.starts, cells: Array.from({ length: days }, (_, d) => {
    const date = addDay(monday, d);
    const cv = cover.find((c) => c.sub_date === date && c.period_id === p.id);
    if (cv) return { kind: "cover" as const, label: secLabel(sm.get(cv.section_id) ?? null), room: sm.get(cv.section_id)?.room ?? null, subject: one(cv.subjects)?.name ?? "" };
    const s = slotRows.find((x) => x.day === d + 1 && x.period_id === p.id);
    if (!s || away.some((a) => a.sub_date === date && a.period_id === p.id && a.section_id === s.section_id)) return { kind: "free" as const, label: "", room: null, subject: "" };
    return { kind: "class" as const, label: secLabel(sm.get(s.section_id) ?? null), room: sm.get(s.section_id)?.room ?? null, subject: one(s.subjects)?.name ?? "" };
  }) }));
  const free = grid.reduce((a, r) => a + r.cells.filter((c) => c.kind === "free").length, 0);
  const subj = [...new Set(slotRows.map((s) => one(s.subjects)?.name).filter(Boolean))].join(", ");
  return { days: DAYS.slice(0, days), today_index: dn <= days ? dn - 1 : -1, grid, per_week: slotRows.length, free, sections: new Set(slotRows.map((s) => s.section_id)).size, limit: LIMIT, subject: subj };
}

// ═════════════ substitution ═════════════
export async function assigned(inst: string, me: string) {
  const today = istDate();
  const rows = (check(await supabaseAdmin.from("substitutions").select("id, sub_date, period_id, section_id, status, subjects:subject_id(name), absent:absent_teacher_id(first_name, last_name), tt_periods:period_id(label, starts, ends)").eq("institution_id", inst).eq("substitute_id", me).gte("sub_date", addDay(today, -60)).order("sub_date", { ascending: false }).limit(200)) ?? []) as unknown as { id: string; sub_date: string; section_id: string; status: string; subjects: { name: string } | { name: string }[] | null; absent: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null; tt_periods: { label: string; starts: string; ends: string } | { label: string; starts: string; ends: string }[] | null }[];
  const sm = await sectionMap(inst, [...new Set(rows.map((r) => r.section_id))]);
  const items = rows.map((r) => { const p = one(r.tt_periods); const a = one(r.absent); return { id: r.id, date: r.sub_date, weekday: new Date(`${r.sub_date}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" }), today: r.sub_date === today, period: p?.label ?? "", starts: p?.starts.slice(0, 5) ?? "", ends: p?.ends.slice(0, 5) ?? "", class_label: secLabel(sm.get(r.section_id) ?? null), subject: one(r.subjects)?.name ?? "", absent_teacher: a ? `${a.first_name} ${a.last_name}`.trim() : "", room: sm.get(r.section_id)?.room ?? null, status: r.status }; });
  return { items, completed: items.filter((i) => i.status === "Completed").length, pending: items.filter((i) => i.status === "Pending").length };
}

export async function freePeriods(inst: string, me: string) {
  const today = istDate();
  const { periods, slotRows, days } = await base(inst, me);
  const to = addDay(today, 13);
  const { away, cover } = await subsFor(inst, me, today, to);
  const teaching = periods.filter((p) => p.kind === "Teaching");
  const wkStart = addDay(today, -(dow(today) - 1));
  const items: { date: string; day: string; period: string; starts: string; ends: string; today: boolean; status: "Free" | "Substitution" }[] = [];
  // from the start of this week to the end of next: the page lists what is still ahead
  for (let d = 0; d < 14; d++) {
    const date = addDay(wkStart, d); const dn = dow(date);
    if (date < today || dn > days) continue;
    for (const p of teaching) {
      const busy = slotRows.some((s) => s.day === dn && s.period_id === p.id) && !away.some((a) => a.sub_date === date && a.period_id === p.id);
      if (busy) continue;
      items.push({ date, day: DAYS[dn - 1], period: p.label, starts: p.starts, ends: p.ends, today: date === today, status: cover.some((c) => c.sub_date === date && c.period_id === p.id) ? "Substitution" : "Free" });
    }
  }
  return { items };
}

export async function todaysCovers(inst: string, me: string) {
  const today = istDate();
  const { cover } = await subsFor(inst, me, today, today);
  const ps = (check(await supabaseAdmin.from("tt_periods").select("id, label, starts").eq("institution_id", inst)) ?? []) as { id: string; label: string; starts: string }[];
  const sm = await sectionMap(inst, [...new Set(cover.map((c) => c.section_id))]);
  return { items: cover.map((c) => { const p = ps.find((x) => x.id === c.period_id); const a = one(c.absent); return { id: c.id, period: p?.label ?? "", starts: p?.starts.slice(0, 5) ?? "", class_label: secLabel(sm.get(c.section_id) ?? null), subject: one(c.subjects)?.name ?? "", covering_for: a ? `${a.first_name} ${a.last_name}`.trim() : "", status: c.status }; }).sort((a, b) => a.starts.localeCompare(b.starts)) };
}

/** The absent teacher's lesson notes for a class this teacher is covering today: the topic and where the syllabus is. */
export async function lessonNotes(inst: string, me: string, id: string) {
  const s = check(await supabaseAdmin.from("substitutions").select("id, section_id, subject_id, absent_teacher_id, sub_date").eq("id", id).eq("institution_id", inst).eq("substitute_id", me).eq("sub_date", istDate()).maybeSingle()) as { id: string; section_id: string; subject_id: string | null; absent_teacher_id: string; sub_date: string } | null;
  if (!s) throw new HttpError(404, "That cover is not yours today.");
  const plans = (check(await supabaseAdmin.from("lesson_plans").select("topic, week_of, progress, status").eq("institution_id", inst).eq("teacher_id", s.absent_teacher_id).eq("section_id", s.section_id).lte("week_of", s.sub_date).order("week_of", { ascending: false }).limit(1)) ?? []) as { topic: string; week_of: string; progress: number; status: string }[];
  return { topic: plans[0]?.topic ?? "", week_of: plans[0]?.week_of ?? null, progress: plans[0]?.progress ?? null };
}
