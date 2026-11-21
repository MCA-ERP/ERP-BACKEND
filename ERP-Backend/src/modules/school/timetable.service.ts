import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** Attendance settings, the bell schedule, class timetables, the generator and its rules. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const uid = z.string().uuid();
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM.");
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYWORDS = ["mon", "tue", "wed", "thu", "fri", "sat"];

// ═════════════ attendance settings ═════════════
const DEFAULTS = {
  mark_mode: "Once a day", closes_at: "10:00", min_exam: 75, half_day_counts: "0.5 day present", parents_apply: true, lock_after: "Same day",
  school_starts: "08:15", grace: 5, late_after: "08:25", half_day_after: "10:30", late_marks: 3, late_counts: "1 absent", tell_parents_late: true,
  sms_absent: true, sms_time: "10:00", app_absent: true, daily_summary: true, weekly_report: false, alert_principal: true, alert_principal_time: "10:30", alert_below: true, below_pct: 85,
};
export type AttConfig = typeof DEFAULTS;
const schema = z.object({
  mark_mode: z.enum(["Once a day", "Every period"]), closes_at: hhmm, min_exam: z.number().int().min(0).max(100), half_day_counts: z.enum(["0.5 day present", "1 day present", "Absent"]), parents_apply: z.boolean(), lock_after: z.enum(["Same day", "1 day", "3 days", "7 days"]),
  school_starts: hhmm, grace: z.number().int().min(0).max(30), late_after: hhmm, half_day_after: hhmm, late_marks: z.number().int().min(1).max(10), late_counts: z.enum(["1 absent", "0.5 absent", "No change"]), tell_parents_late: z.boolean(),
  sms_absent: z.boolean(), sms_time: hhmm, app_absent: z.boolean(), daily_summary: z.boolean(), weekly_report: z.boolean(), alert_principal: z.boolean(), alert_principal_time: hhmm, alert_below: z.boolean(), below_pct: z.number().int().min(1).max(100),
}).partial().strict();

export async function getAttSettings(inst: string): Promise<AttConfig> {
  const r = check(await supabaseAdmin.from("att_settings").select("config, late_after").eq("institution_id", inst).maybeSingle()) as { config: Partial<AttConfig>; late_after: string } | null;
  return { ...DEFAULTS, ...(r?.late_after && !r.config?.late_after ? { late_after: r.late_after.slice(0, 5) } : {}), ...(r?.config ?? {}) };
}
export async function saveAttSettings(inst: string, input: unknown) {
  const i = schema.parse(input);
  const merged = { ...(await getAttSettings(inst)), ...i };
  if (merged.half_day_after < merged.late_after) throw new HttpError(400, "Half day must come after the late time.");
  check(await supabaseAdmin.from("att_settings").upsert({ institution_id: inst, config: merged, late_after: merged.late_after }, { onConflict: "institution_id" }).select("institution_id"));
  return merged;
}

// ═════════════ bell schedule ═════════════
export interface Period { id: string; label: string; starts: string; ends: string; kind: "Teaching" | "Break" }
export async function periods(inst: string): Promise<Period[]> {
  return (check(await supabaseAdmin.from("tt_periods").select("id, label, starts, ends, kind").eq("institution_id", inst).order("starts")) as unknown as Period[]).map((p) => ({ ...p, starts: p.starts.slice(0, 5), ends: p.ends.slice(0, 5) }));
}
export async function listPeriods(inst: string) { return { items: await periods(inst) }; }
export async function addPeriod(inst: string, input: unknown) {
  const i = z.object({ label: z.string().trim().min(1, "Enter the name.").max(30), starts: hhmm, ends: hhmm, kind: z.enum(["Teaching", "Break"]) }).strict().parse(input);
  if (i.ends <= i.starts) throw new HttpError(400, "A period must end after it starts.");
  const clash = (await periods(inst)).find((p) => p.starts < i.ends && p.ends > i.starts);
  if (clash) throw new HttpError(409, `That overlaps ${clash.label} (${clash.starts} – ${clash.ends}).`);
  if ((await periods(inst)).some((p) => p.label.toLowerCase() === i.label.toLowerCase())) throw new HttpError(409, "A period with that name exists.");
  return check(await supabaseAdmin.from("tt_periods").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function deletePeriod(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("tt_periods").delete().eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Period not found.");
  return { ok: true };
}
export async function defaultPeriods(inst: string) {
  if ((await periods(inst)).length) throw new HttpError(409, "This school already has periods.");
  const rows: [string, string, string, string][] = [["P1", "08:20", "09:00", "Teaching"], ["P2", "09:00", "09:40", "Teaching"], ["Break", "09:40", "09:55", "Break"], ["P3", "09:55", "10:35", "Teaching"], ["P4", "10:35", "11:15", "Teaching"], ["P5", "11:15", "11:55", "Teaching"], ["Lunch", "11:55", "12:35", "Break"], ["P6", "12:35", "13:15", "Teaching"], ["P7", "13:15", "13:55", "Teaching"], ["P8", "13:55", "14:35", "Teaching"]];
  check(await supabaseAdmin.from("tt_periods").insert(rows.map(([label, starts, ends, kind]) => ({ institution_id: inst, label, starts, ends, kind }))).select("id"));
  return { added: rows.length };
}

export async function weekDays(inst: string) {
  const s = check(await supabaseAdmin.from("calendar_settings").select("school_week").eq("institution_id", inst).maybeSingle()) as { school_week: string } | null;
  return s?.school_week === "Monday – Friday" ? 5 : 6;
}
export async function currentSections(inst: string) {
  const y = check(await supabaseAdmin.from("academic_years").select("id, name").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { id: string; name: string } | null;
  if (!y) throw new HttpError(409, "Activate an academic year first.");
  const rows = check(await supabaseAdmin.from("sections").select("id, name, grade_id, grades:grade_id(name, sort_order)").eq("institution_id", inst).eq("academic_year_id", y.id).eq("is_active", true)) as unknown as { id: string; name: string; grade_id: string; grades: { name: string; sort_order: number } | { name: string; sort_order: number }[] | null }[];
  return { year: y.name, sections: rows.map((r) => ({ id: r.id, grade_id: r.grade_id, label: `${one(r.grades)?.name ?? ""} ${r.name}`.trim(), order: one(r.grades)?.sort_order ?? 0, name: r.name })).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)) };
}

// ═════════════ shared lookups ═════════════
export interface Slot { id: string; section_id: string; day: number; period_id: string; subject_id: string | null; teacher_id: string | null; locked: boolean }
export async function allSlots(inst: string) { return check(await supabaseAdmin.from("tt_slots").select("id, section_id, day, period_id, subject_id, teacher_id, locked").eq("institution_id", inst).limit(50000)) as unknown as Slot[]; }
export async function teacherNames(inst: string) {
  const r = check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name").eq("institution_id", inst).limit(2000)) as { id: string; first_name: string; last_name: string }[];
  return new Map(r.map((x) => [x.id, `${x.first_name} ${x.last_name}`.trim()]));
}
export async function subjectNames(inst: string) {
  const r = check(await supabaseAdmin.from("subjects").select("id, name").eq("institution_id", inst).eq("is_active", true).order("name")) as { id: string; name: string }[];
  return r;
}
async function gradeSubjects(inst: string) {
  const r = check(await supabaseAdmin.from("grade_subjects").select("grade_id, subject_id, grades:grade_id!inner(institution_id)").eq("grades.institution_id", inst).limit(20000)) as unknown as { grade_id: string; subject_id: string }[];
  const m = new Map<string, string[]>();
  for (const x of r) m.set(x.grade_id, [...(m.get(x.grade_id) ?? []), x.subject_id]);
  return m;
}
export async function candidates(inst: string) {
  const r = check(await supabaseAdmin.from("teacher_subjects").select("teacher_id, subject_id, section_id, periods").eq("institution_id", inst).limit(5000)) as { teacher_id: string; subject_id: string; section_id: string | null; periods: number }[];
  return r;
}
export const teachersFor = (c: Awaited<ReturnType<typeof candidates>>, subject: string, section: string) => [...new Set(c.filter((x) => x.subject_id === subject && (x.section_id === section || x.section_id === null)).map((x) => x.teacher_id))];

// ═════════════ class grid ═════════════
export async function grid(inst: string, sectionId: string) {
  const [ps, days, secs, subjects, gs] = await Promise.all([periods(inst), weekDays(inst), currentSections(inst), subjectNames(inst), gradeSubjects(inst)]);
  const sec = secs.sections.find((s) => s.id === sectionId);
  if (!sec) throw new HttpError(404, "Section not found.");
  const [slots, st, names] = await Promise.all([allSlots(inst), supabaseAdmin.from("tt_sections").select("status").eq("section_id", sectionId).maybeSingle(), teacherNames(inst)]);
  const mine = slots.filter((s) => s.section_id === sectionId);
  const allowed = new Set(gs.get(sec.grade_id) ?? []);
  return {
    year: secs.year, label: sec.label, days, periods: ps, status: (st.data as { status: string } | null)?.status ?? "Draft",
    subjects: subjects.filter((s) => allowed.has(s.id) || mine.some((m) => m.subject_id === s.id)),
    slots: mine.map((s) => ({ day: s.day, period_id: s.period_id, subject_id: s.subject_id, teacher: s.teacher_id ? names.get(s.teacher_id) ?? "" : "", locked: s.locked })),
  };
}

export async function saveGrid(inst: string, sectionId: string, input: unknown) {
  const i = z.object({ cells: z.array(z.object({ day: z.number().int().min(1).max(6), period_id: uid, subject_id: uid.nullable() })).max(300) }).strict().parse(input);
  const [ps, secs, cand] = await Promise.all([periods(inst), currentSections(inst), candidates(inst)]);
  if (!secs.sections.some((s) => s.id === sectionId)) throw new HttpError(404, "Section not found.");
  const teaching = new Set(ps.filter((p) => p.kind === "Teaching").map((p) => p.id));
  const subs = new Set((await subjectNames(inst)).map((s) => s.id));
  for (const c of i.cells) { if (!teaching.has(c.period_id)) throw new HttpError(400, "That period can't hold a lesson."); if (c.subject_id && !subs.has(c.subject_id)) throw new HttpError(404, "Subject not found."); }
  const rows = i.cells.filter((c) => c.subject_id).map((c) => { const t = teachersFor(cand, c.subject_id as string, sectionId); return { institution_id: inst, section_id: sectionId, day: c.day, period_id: c.period_id, subject_id: c.subject_id, teacher_id: t[0] ?? null }; });
  check(await supabaseAdmin.from("tt_slots").delete().eq("section_id", sectionId).eq("locked", false).select("id"));
  const keep = new Set((check(await supabaseAdmin.from("tt_slots").select("day, period_id").eq("section_id", sectionId)) as { day: number; period_id: string }[]).map((s) => `${s.day}|${s.period_id}`));
  const fresh = rows.filter((r) => !keep.has(`${r.day}|${r.period_id}`));
  if (fresh.length) check(await supabaseAdmin.from("tt_slots").insert(fresh).select("id"));
  check(await supabaseAdmin.from("tt_sections").upsert({ section_id: sectionId, institution_id: inst, status: "Draft" }, { onConflict: "section_id" }).select("section_id"));
  return { saved: fresh.length };
}

// ═════════════ publish ═════════════
export function clashSet(slots: Slot[]) {
  const by = new Map<string, Slot[]>();
  for (const s of slots) if (s.teacher_id) { const k = `${s.teacher_id}|${s.day}|${s.period_id}`; by.set(k, [...(by.get(k) ?? []), s]); }
  return [...by.values()].filter((v) => new Set(v.map((x) => x.section_id)).size > 1);
}
export async function publishList(inst: string) {
  const [ps, days, secs, slots, st] = await Promise.all([periods(inst), weekDays(inst), currentSections(inst), allSlots(inst), supabaseAdmin.from("tt_sections").select("section_id, status").eq("institution_id", inst)]);
  const total = ps.filter((p) => p.kind === "Teaching").length * days;
  const status = new Map(((check(st) ?? []) as { section_id: string; status: string }[]).map((x) => [x.section_id, x.status]));
  const clashes = clashSet(slots);
  return { total, items: secs.sections.map((s) => ({ id: s.id, label: s.label, set: slots.filter((x) => x.section_id === s.id && x.subject_id).length, total, clashes: clashes.filter((c) => c.some((x) => x.section_id === s.id)).length, status: status.get(s.id) ?? "Draft" })) };
}
export async function publish(inst: string, sectionId: string | "all") {
  const list = await publishList(inst);
  const todo = list.items.filter((i) => (sectionId === "all" || i.id === sectionId) && i.status !== "Published");
  if (sectionId !== "all") { const t = todo[0]; if (!t && !list.items.some((i) => i.id === sectionId)) throw new HttpError(404, "Section not found."); if (t && !t.set) throw new HttpError(409, "Set at least one period first."); if (t && t.clashes) throw new HttpError(409, "Fix the teacher clashes first."); }
  const ok = todo.filter((t) => t.set > 0 && !t.clashes);
  if (ok.length) check(await supabaseAdmin.from("tt_sections").upsert(ok.map((t) => ({ section_id: t.id, institution_id: inst, status: "Published" })), { onConflict: "section_id" }).select("section_id"));
  return { published: ok.length, skipped: todo.length - ok.length };
}

// ═════════════ rules ═════════════
export async function getRules(inst: string) {
  const [subs, saved, cand, names, lim, words, ps, days, secs] = await Promise.all([
    subjectNames(inst), supabaseAdmin.from("tt_subject_rules").select("subject_id, per_week, prefers, room").eq("institution_id", inst), candidates(inst), teacherNames(inst),
    supabaseAdmin.from("tt_teacher_limits").select("id, teacher_id, day, period_labels, reason, source").eq("institution_id", inst), supabaseAdmin.from("tt_words").select("id, asked, understood").eq("institution_id", inst).order("created_at", { ascending: false }),
    periods(inst), weekDays(inst), currentSections(inst),
  ]);
  const rule = new Map(((check(saved) ?? []) as { subject_id: string; per_week: number; prefers: string; room: string }[]).map((r) => [r.subject_id, r]));
  const items = subs.map((s) => {
    const r = rule.get(s.id);
    const by = new Map<string, number>();
    for (const c of cand.filter((x) => x.subject_id === s.id)) by.set(c.teacher_id, (by.get(c.teacher_id) ?? 0) + c.periods);
    return { subject_id: s.id, subject: s.name, per_week: r?.per_week ?? 5, prefers: r?.prefers ?? "Any", room: r?.room ?? "Classroom", taught_by: [...by.entries()].map(([t, n]) => ({ name: names.get(t) ?? "", periods: n })) };
  });
  type L = { id: string; teacher_id: string; day: number | null; period_labels: string; reason: string; source: string };
  return {
    slots_per_week: ps.filter((p) => p.kind === "Teaching").length * days, sections: secs.sections.length, items,
    limits: ((check(lim) ?? []) as L[]).map((l) => ({ id: l.id, teacher_id: l.teacher_id, teacher: names.get(l.teacher_id) ?? "", day: l.day, when: `${l.day ? DAYS[l.day - 1] : "Every day"}, ${l.period_labels ? l.period_labels.split(",").join(", ") : "all day"}`, reason: l.reason, source: l.source })),
    words: (check(words) ?? []) as { id: string; asked: string; understood: string }[],
  };
}
export async function saveRules(inst: string, input: unknown) {
  const i = z.object({ rules: z.array(z.object({ subject_id: uid, per_week: z.number().int().min(0).max(12), prefers: z.enum(["Any", "Morning", "Afternoon"]), room: z.string().trim().min(1).max(60) })).min(1).max(100) }).strict().parse(input);
  const ok = new Set((await subjectNames(inst)).map((s) => s.id));
  const rows = i.rules.filter((r) => ok.has(r.subject_id)).map((r) => ({ institution_id: inst, ...r }));
  check(await supabaseAdmin.from("tt_subject_rules").upsert(rows, { onConflict: "institution_id,subject_id" }).select("subject_id"));
  return { saved: rows.length };
}
export async function addLimit(inst: string, input: unknown, source: "Manual" | "Words" = "Manual") {
  const i = z.object({ teacher_id: uid, day: z.number().int().min(1).max(6).nullable(), period_labels: z.string().trim().max(100).default(""), reason: z.string().trim().max(200).default("") }).strict().parse(input);
  const t = check(await supabaseAdmin.from("user_profiles").select("id").eq("id", i.teacher_id).eq("institution_id", inst).maybeSingle());
  if (!t) throw new HttpError(404, "Teacher not found.");
  return check(await supabaseAdmin.from("tt_teacher_limits").insert({ institution_id: inst, ...i, source }).select("id").single());
}
export async function removeLimit(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("tt_teacher_limits").delete().eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found.");
  return { ok: true };
}

// ═════════════ generator ═════════════
export async function generate(inst: string) {
  const [ps, days, secs, slots0, rules, cand, gs, subs, limRows, names] = await Promise.all([periods(inst), weekDays(inst), currentSections(inst), allSlots(inst), getRules(inst), candidates(inst), gradeSubjects(inst), subjectNames(inst), supabaseAdmin.from("tt_teacher_limits").select("teacher_id, day, period_labels").eq("institution_id", inst), teacherNames(inst)]);
  const teaching = ps.filter((p) => p.kind === "Teaching");
  if (!teaching.length) throw new HttpError(409, "Add the bell schedule first (Timetable Setup).");
  if (!secs.sections.length) throw new HttpError(409, "Add sections first.");
  const sectionIds = new Set(secs.sections.map((s) => s.id));
  const rule = new Map(rules.items.map((r) => [r.subject_id, r]));
  const subName = new Map(subs.map((s) => [s.id, s.name]));
  const morning = new Set(teaching.filter((p) => p.starts < "12:00").map((p) => p.id));
  const pLabel = new Map(teaching.map((p) => [p.id, p.label]));
  const blocked = new Set<string>();
  for (const l of (check(limRows) ?? []) as { teacher_id: string; day: number | null; period_labels: string }[]) {
    const labels = l.period_labels ? l.period_labels.split(",").map((x) => x.trim()) : teaching.map((p) => p.label);
    for (const d of l.day ? [l.day] : Array.from({ length: days }, (_, k) => k + 1)) for (const p of teaching) if (labels.includes(p.label)) blocked.add(`${l.teacher_id}|${d}|${p.id}`);
  }
  const keep = slots0.filter((s) => s.locked && sectionIds.has(s.section_id));
  const busy = new Set<string>(); const tDay = new Map<string, number>(); const load = new Map<string, number>();
  const bump = (t: string, d: number, p: string) => { busy.add(`${t}|${d}|${p}`); tDay.set(`${t}|${d}`, (tDay.get(`${t}|${d}`) ?? 0) + 1); load.set(t, (load.get(t) ?? 0) + 1); };
  for (const s of keep) if (s.teacher_id) bump(s.teacher_id, s.day, s.period_id);
  const placed: Omit<Slot, "id">[] = [];
  let needTotal = 0;
  for (const sec of secs.sections) {
    const taken = new Map<string, Slot | Omit<Slot, "id">>();
    for (const s of keep.filter((k) => k.section_id === sec.id)) taken.set(`${s.day}|${s.period_id}`, s);
    const lessons: { subject: string; n: number }[] = [];
    for (const sid of gs.get(sec.grade_id) ?? []) { const r = rule.get(sid); const per = r?.per_week ?? 5; const have = keep.filter((k) => k.section_id === sec.id && k.subject_id === sid).length; needTotal += per; if (per - have > 0) lessons.push({ subject: sid, n: per - have }); }
    lessons.sort((a, b) => b.n - a.n || Math.random() - 0.5);
    const queue = lessons.flatMap((l) => Array.from({ length: l.n }, () => l.subject));
    // round-robin by subject so heavy subjects spread out
    queue.sort(() => Math.random() - 0.5);
    const subDay = (sid: string, d: number) => [...taken.entries()].filter(([k, v]) => k.startsWith(`${d}|`) && v.subject_id === sid).length;
    for (const sid of queue) {
      const r = rule.get(sid); const per = r?.per_week ?? 5; const maxDay = per >= 6 ? 2 : 1;
      const tc = teachersFor(cand, sid, sec.id);
      let best: { d: number; p: string; t: string | null; score: number } | null = null;
      for (let d = 1; d <= days; d++) {
        if (subDay(sid, d) >= maxDay) continue;
        for (const p of teaching) {
          if (taken.has(`${d}|${p.id}`)) continue;
          const idx = teaching.indexOf(p);
          const prev = teaching[idx - 1]; const next = teaching[idx + 1];
          if ((prev && taken.get(`${d}|${prev.id}`)?.subject_id === sid) || (next && taken.get(`${d}|${next.id}`)?.subject_id === sid)) continue;
          let t: string | null = null;
          if (tc.length) {
            const free = tc.filter((x) => !busy.has(`${x}|${d}|${p.id}`) && !blocked.has(`${x}|${d}|${p.id}`) && (tDay.get(`${x}|${d}`) ?? 0) < 6).sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0));
            if (!free.length) continue;
            t = free[0];
          }
          let score = Math.random() - subDay(sid, d) * 2;
          const pref = r?.prefers ?? "Any";
          if (pref === "Morning") score += morning.has(p.id) ? 3 : -3;
          if (pref === "Afternoon") score += morning.has(p.id) ? -3 : 3;
          if (!best || score > best.score) best = { d, p: p.id, t, score };
        }
      }
      if (!best) continue;
      if (best.t) bump(best.t, best.d, best.p);
      const row = { institution_id: inst, section_id: sec.id, day: best.d, period_id: best.p, subject_id: sid, teacher_id: best.t, locked: false };
      taken.set(`${best.d}|${best.p}`, row); placed.push(row);
    }
  }
  check(await supabaseAdmin.from("tt_slots").delete().eq("institution_id", inst).eq("locked", false).in("section_id", [...sectionIds]).select("id"));
  for (let k = 0; k < placed.length; k += 500) check(await supabaseAdmin.from("tt_slots").insert(placed.slice(k, k + 500)).select("id"));
  check(await supabaseAdmin.from("tt_sections").upsert([...sectionIds].map((section_id) => ({ section_id, institution_id: inst, status: "Draft" })), { onConflict: "section_id" }).select("section_id"));
  void names; void subName; void pLabel;
  return { placed: placed.length + keep.filter((k) => k.subject_id).length, needed: needTotal };
}

export async function autoView(inst: string) {
  const [ps, days, secs, slots, names, subs] = await Promise.all([periods(inst), weekDays(inst), currentSections(inst), allSlots(inst), teacherNames(inst), subjectNames(inst)]);
  const mine = slots.filter((s) => secs.sections.some((x) => x.id === s.section_id));
  const rules = await getRules(inst);
  const needed = secs.sections.reduce((n, s) => n + 0 * s.order, 0) + 0;
  void needed;
  const gs = await gradeSubjects(inst);
  const need = secs.sections.reduce((n, s) => n + (gs.get(s.grade_id) ?? []).reduce((m, sid) => m + (rules.items.find((r) => r.subject_id === sid)?.per_week ?? 5), 0), 0);
  const perTeacherDay = new Map<string, number>();
  for (const s of mine) if (s.teacher_id) perTeacherDay.set(`${s.teacher_id}|${s.day}`, (perTeacherDay.get(`${s.teacher_id}|${s.day}`) ?? 0) + 1);
  const teachers = [...new Set(mine.map((s) => s.teacher_id).filter((x): x is string => !!x))].map((id) => ({ id, name: names.get(id) ?? "" })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    days, periods: ps, sections: secs.sections.map((s) => ({ id: s.id, label: s.label })), teachers, subjects: subs,
    placed: mine.filter((s) => s.subject_id).length, needed: need, clashes: clashSet(mine).length, max_day: Math.max(0, ...perTeacherDay.values()), locked: mine.filter((s) => s.locked).length,
    slots: mine.map((s) => ({ id: s.id, section_id: s.section_id, day: s.day, period_id: s.period_id, subject_id: s.subject_id, teacher_id: s.teacher_id, teacher: s.teacher_id ? names.get(s.teacher_id) ?? "" : "", locked: s.locked })),
  };
}
export async function toggleLock(inst: string, id: string) {
  const s = check(await supabaseAdmin.from("tt_slots").select("id, locked, subject_id").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; locked: boolean; subject_id: string | null } | null;
  if (!s) throw new HttpError(404, "Period not found.");
  check(await supabaseAdmin.from("tt_slots").update({ locked: !s.locked }).eq("id", id).select("id"));
  return { locked: !s.locked };
}

// ═════════════ plain words ═════════════
const ALIAS: Record<string, string> = { pe: "physical education", maths: "mathematics", math: "mathematics", cs: "computer science", sst: "social studies", evs: "evs" };
export async function applyWords(inst: string, input: unknown) {
  const { text } = z.object({ text: z.string().trim().min(5, "Say what should change.").max(300) }).strict().parse(input);
  const t = text.toLowerCase();
  const [names, subs, ps] = await Promise.all([teacherNames(inst), subjectNames(inst), periods(inst)]);
  const teaching = ps.filter((p) => p.kind === "Teaching");
  const teacher = [...names.entries()].find(([, n]) => n.split(" ").some((w) => w.length > 2 && new RegExp(`\\b${w.toLowerCase()}\\b`).test(t)));
  const day = DAYWORDS.findIndex((d) => new RegExp(`\\b${d}[a-z]*`).test(t)) + 1;
  const sub = subs.find((s) => t.includes(s.name.toLowerCase())) ?? subs.find((s) => Object.entries(ALIAS).some(([a, full]) => new RegExp(`\\b${a}\\b`).test(t) && s.name.toLowerCase() === full));
  const half = /afternoon/.test(t) ? "Afternoon" : /morning/.test(t) ? "Morning" : null;
  let understood = "";
  const first = /\bfirst\b/.test(t) ? teaching[0]?.label : /\blast\b/.test(t) ? teaching[teaching.length - 1]?.label : (/\bp(\d)\b/.exec(t) ? `P${/\bp(\d)\b/.exec(t)?.[1]}` : null);
  if (teacher && /\bno\b|not available|unavailable|\boff\b|can'?t|cannot/.test(t) && (day || first || half)) {
    const labels = first ? [first] : half === "Morning" ? teaching.filter((p) => p.starts < "12:00").map((p) => p.label) : half === "Afternoon" ? teaching.filter((p) => p.starts >= "12:00").map((p) => p.label) : [];
    await addLimit(inst, { teacher_id: teacher[0], day: day || null, period_labels: labels.join(","), reason: text }, "Words");
    understood = `${teacher[1]} is not available ${day ? DAYS[day - 1] : "any day"}, ${labels.length ? labels.join(", ") : "all day"}.`;
  } else if (sub && half) {
    const cur = check(await supabaseAdmin.from("tt_subject_rules").select("per_week, room").eq("institution_id", inst).eq("subject_id", sub.id).maybeSingle()) as { per_week: number; room: string } | null;
    check(await supabaseAdmin.from("tt_subject_rules").upsert({ institution_id: inst, subject_id: sub.id, per_week: cur?.per_week ?? 5, room: cur?.room ?? "Classroom", prefers: half }, { onConflict: "institution_id,subject_id" }).select("subject_id"));
    understood = `${sub.name} is placed in the ${half.toLowerCase()}.`;
  } else throw new HttpError(400, "I couldn't understand that. Try: “No first periods for Deepa on Mondays” or “Move all PE to afternoons”.");
  check(await supabaseAdmin.from("tt_words").insert({ institution_id: inst, asked: text, understood }).select("id"));
  const g = await generate(inst);
  return { understood, ...g };
}
