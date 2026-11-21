import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { getAttSettings } from "./timetable.service";

/** Student attendance, attendance corrections, and the school's grading / passing / promotion rules. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const uid = z.string().uuid();
const STATUS = ["P", "A", "L", "H", "V"] as const;
type St = (typeof STATUS)[number];
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const NAMES: Record<string, string> = { P: "Present", A: "Absent", L: "Late", H: "Half day", V: "Leave" };

async function yearOf(inst: string) {
  return check(await supabaseAdmin.from("academic_years").select("id, name, start_date").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { id: string; name: string; start_date: string } | null;
}
async function sectionRoster(inst: string, sectionId: string) {
  const y = await yearOf(inst);
  if (!y) throw new HttpError(409, "Activate an academic year first.");
  const sec = check(await supabaseAdmin.from("sections").select("id, name, grades:grade_id(name)").eq("id", sectionId).eq("institution_id", inst).maybeSingle()) as { id: string; name: string; grades: { name: string } | { name: string }[] | null } | null;
  if (!sec) throw new HttpError(404, "Section not found.");
  const ro = await roster(inst);
  const kids = ro.items.filter((r) => r.section_id === sectionId && r.status === "Enrolled").sort((a, b) => (parseInt(a.roll_no) || 9999) - (parseInt(b.roll_no) || 9999) || a.name.localeCompare(b.name));
  return { label: `${one(sec.grades)?.name ?? ""} ${sec.name}`.trim(), kids };
}

// ═════════════ marking ═════════════
export async function sheet(inst: string, sectionId: string, date: string) {
  iso.parse(date);
  const { label, kids } = await sectionRoster(inst, sectionId);
  const recs = kids.length ? (check(await supabaseAdmin.from("attendance_records").select("student_id, status").eq("institution_id", inst).eq("att_date", date).in("student_id", kids.map((k) => k.id))) as { student_id: string; status: St }[]) : [];
  const by = new Map(recs.map((r) => [r.student_id, r.status]));
  // approved leave covers the day even when nobody has marked it yet
  const lv = kids.length ? (check(await supabaseAdmin.from("student_leaves").select("student_id").eq("institution_id", inst).eq("status", "Approved").lte("from_date", date).gte("to_date", date).in("student_id", kids.map((k) => k.id))) as { student_id: string }[]) : [];
  const onLeave = new Set(lv.map((x) => x.student_id));
  return { label, date, marked: recs.length > 0, students: kids.map((k) => ({ id: k.id, name: k.name, roll_no: k.roll_no, status: by.get(k.id) ?? (onLeave.has(k.id) ? ("V" as St) : null) })) };
}

export async function saveSheet(inst: string, input: unknown, actor?: string) {
  const i = z.object({ section_id: uid, date: iso, marks: z.array(z.object({ student_id: uid, status: z.enum(STATUS) })).min(1).max(300) }).strict().parse(input);
  if (i.date > today()) throw new HttpError(400, "You can't mark attendance for a future date.");
  const cfg = await getAttSettings(inst);
  const lockDays = { "Same day": 0, "1 day": 1, "3 days": 3, "7 days": 7 }[cfg.lock_after] ?? 0;
  if ((Date.parse(today()) - Date.parse(i.date)) / 86400000 > lockDays) throw new HttpError(409, "Attendance for that day is locked. Raise a correction request instead.");
  const { kids } = await sectionRoster(inst, i.section_id);
  const ok = new Set(kids.map((k) => k.id));
  const rows = i.marks.filter((m) => ok.has(m.student_id)).map((m) => ({ institution_id: inst, student_id: m.student_id, section_id: i.section_id, att_date: i.date, status: m.status, marked_by: actor ?? null, updated_at: new Date().toISOString() }));
  if (!rows.length) throw new HttpError(400, "None of those students are in this section.");
  check(await supabaseAdmin.from("attendance_records").upsert(rows, { onConflict: "student_id,att_date" }).select("id"));
  return { saved: rows.length };
}

// ═════════════ reports ═════════════
const attended = (s: St) => s === "P" || s === "L" || s === "H";

export async function daily(inst: string, date: string) {
  iso.parse(date);
  const ro = await roster(inst);
  const active = ro.items.filter((r) => r.status === "Enrolled");
  const [recs, secs, week] = await Promise.all([
    supabaseAdmin.from("attendance_records").select("student_id, section_id, status, marked_by, profiles:marked_by(first_name, last_name)").eq("institution_id", inst).eq("att_date", date).limit(100000),
    supabaseAdmin.from("sections").select("id, name, grade_id, class_teacher_id, grades:grade_id(name, sort_order), teacher:class_teacher_id(first_name, last_name)").eq("institution_id", inst).eq("academic_year_id", ro.year?.id ?? "").eq("is_active", true),
    supabaseAdmin.from("attendance_records").select("student_id, att_date, status").eq("institution_id", inst).gte("att_date", new Date(Date.parse(date) - 14 * 86400000).toISOString().slice(0, 10)).lte("att_date", date).limit(100000),
  ]);
  type Rec = { student_id: string; section_id: string | null; status: St; profiles: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null };
  const R = (check(recs) ?? []) as unknown as Rec[];
  type Sec = { id: string; name: string; grade_id: string; grades: { name: string; sort_order: number } | { name: string; sort_order: number }[] | null; teacher: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null };
  const S = ((check(secs) ?? []) as unknown as Sec[]).sort((a, b) => (one(a.grades)?.sort_order ?? 0) - (one(b.grades)?.sort_order ?? 0) || a.name.localeCompare(b.name));
  const sections = S.map((s) => {
    const kids = active.filter((k) => k.section_id === s.id);
    const mine = R.filter((r) => r.section_id === s.id);
    const present = mine.filter((r) => attended(r.status)).length;
    const by = one(mine[0]?.profiles ?? null);
    const t = one(s.teacher);
    return { id: s.id, label: `${one(s.grades)?.name ?? ""} ${s.name}`.trim(), grade: one(s.grades)?.name ?? "", students: kids.length, present, pct: mine.length ? Math.round((present / mine.length) * 1000) / 10 : null, marked: mine.length > 0, marked_by: by ? `${by.first_name} ${by.last_name}`.trim() : t ? `${t.first_name} ${t.last_name}`.trim() : "" };
  });
  const markedSecs = sections.filter((s) => s.marked);
  const count = (st: St) => R.filter((r) => r.status === st).length;
  const presentN = R.filter((r) => attended(r.status)).length;
  const classes = [...new Set(sections.map((s) => s.grade))].map((g) => { const m = R.filter((r) => S.find((s) => s.id === r.section_id && one(s.grades)?.name === g)); return { grade: g, pct: m.length ? Math.round((m.filter((r) => attended(r.status)).length / m.length) * 1000) / 10 : null }; });
  // students absent on each of the last marked days, 3 or more in a row
  const W = (check(week) ?? []) as { student_id: string; att_date: string; status: St }[];
  const days = [...new Set(W.map((w) => w.att_date))].sort().reverse();
  const streaks: { student_id: string; name: string; class_label: string; days: number }[] = [];
  for (const k of active) {
    let n = 0;
    for (const d of days) { const r = W.find((w) => w.student_id === k.id && w.att_date === d); if (r?.status === "A") n++; else break; }
    if (n >= 3) streaks.push({ student_id: k.id, name: k.name, class_label: k.class_label, days: n });
  }
  return { date, present: presentN, absent: count("A"), late: count("L"), leave: count("V"), marked_students: R.length, pct: R.length ? Math.round((presentN / R.length) * 1000) / 10 : null, not_marked: sections.filter((s) => !s.marked && s.students > 0).map((s) => s.label), sections: markedSecs.length ? sections : sections, classes, streaks: streaks.sort((a, b) => b.days - a.days) };
}

export async function sectionSubjects(inst: string, sectionId: string) {
  const sec = check(await supabaseAdmin.from("sections").select("id, grade_id").eq("id", sectionId).eq("institution_id", inst).maybeSingle()) as { id: string; grade_id: string } | null;
  if (!sec) throw new HttpError(404, "Section not found.");
  const [gs, ts] = await Promise.all([
    supabaseAdmin.from("grade_subjects").select("subjects:subject_id(id, name)").eq("grade_id", sec.grade_id),
    supabaseAdmin.from("teacher_subjects").select("subject_id, section_id, teacher:teacher_id(first_name, last_name)").eq("institution_id", inst).or(`section_id.eq.${sectionId},section_id.is.null`),
  ]);
  const T = (check(ts) ?? []) as unknown as { subject_id: string; teacher: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  return { items: ((check(gs) ?? []) as unknown as { subjects: { id: string; name: string } | { id: string; name: string }[] | null }[]).map((g) => one(g.subjects)).filter((s): s is { id: string; name: string } => !!s).map((s) => { const t = one(T.find((x) => x.subject_id === s.id)?.teacher ?? null); return { id: s.id, name: s.name, teacher: t ? `${t.first_name} ${t.last_name}`.trim() : "" }; }).sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Attendance % for each student this year (present, late and half days count as attended). */
export async function summary(inst: string) {
  const y = await yearOf(inst);
  if (!y) return { items: {} as Record<string, number> };
  const R = (check(await supabaseAdmin.from("attendance_records").select("student_id, status").eq("institution_id", inst).gte("att_date", y.start_date).limit(500000)) ?? []) as { student_id: string; status: St }[];
  const tot = new Map<string, { a: number; n: number }>();
  for (const r of R) { const t = tot.get(r.student_id) ?? { a: 0, n: 0 }; t.n++; if (attended(r.status)) t.a++; tot.set(r.student_id, t); }
  return { items: Object.fromEntries([...tot.entries()].map(([k, v]) => [k, Math.round((v.a / v.n) * 100)])) };
}

// ═════════════ corrections ═════════════
export async function listCorrections(inst: string) {
  const [rows, ro] = await Promise.all([
    supabaseAdmin.from("attendance_corrections").select("id, code, student_id, att_date, marked, should_be, reason, status, created_at, requester:requested_by(first_name, last_name)").eq("institution_id", inst).order("created_at", { ascending: false }).limit(2000),
    roster(inst),
  ]);
  const kids = new Map(ro.items.map((r) => [r.id, r]));
  type R = { id: string; code: string; student_id: string; att_date: string; marked: string; should_be: St; reason: string; status: string; requester: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null };
  return { items: (check(rows) as unknown as R[]).map((r) => { const q = one(r.requester); return { id: r.id, code: r.code, student: kids.get(r.student_id)?.name ?? "", class_label: kids.get(r.student_id)?.class_label ?? "", att_date: r.att_date, marked: r.marked, should_be: NAMES[r.should_be], requested_by: q ? `${q.first_name} ${q.last_name}`.trim() : "", reason: r.reason, status: r.status }; }) };
}

export async function requestCorrection(inst: string, input: unknown, actor?: string) {
  const i = z.object({ student_id: uid, att_date: iso, should_be: z.enum(STATUS), reason: z.string().trim().min(3, "Give a reason.").max(300) }).strict().parse(input);
  if (i.att_date > today()) throw new HttpError(400, "That date hasn't happened yet.");
  const s = check(await supabaseAdmin.from("students").select("id").eq("id", i.student_id).eq("institution_id", inst).maybeSingle());
  if (!s) throw new HttpError(404, "Student not found.");
  const cur = check(await supabaseAdmin.from("attendance_records").select("status").eq("student_id", i.student_id).eq("att_date", i.att_date).maybeSingle()) as { status: St } | null;
  if (cur?.status === i.should_be) throw new HttpError(400, "That is already how it was marked.");
  const dup = check(await supabaseAdmin.from("attendance_corrections").select("id").eq("student_id", i.student_id).eq("att_date", i.att_date).eq("status", "Pending")) as unknown[];
  if (dup.length) throw new HttpError(409, "There is already a pending correction for that day.");
  return check(await supabaseAdmin.from("attendance_corrections").insert({ institution_id: inst, student_id: i.student_id, att_date: i.att_date, marked: cur ? NAMES[cur.status] : "Not marked", should_be: i.should_be, reason: i.reason, requested_by: actor ?? null }).select("id, code").single());
}

export async function decideCorrection(inst: string, id: string, input: unknown, actor?: string) {
  const { status } = z.object({ status: z.enum(["Approved", "Rejected"]) }).strict().parse(input);
  const c = check(await supabaseAdmin.from("attendance_corrections").select("id, student_id, att_date, should_be, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; student_id: string; att_date: string; should_be: St; status: string } | null;
  if (!c) throw new HttpError(404, "Correction not found.");
  if (c.status !== "Pending") throw new HttpError(409, "This correction was already decided.");
  if (status === "Approved") {
    const e = check(await supabaseAdmin.from("student_enrollments").select("section_id").eq("student_id", c.student_id).eq("institution_id", inst).order("created_at", { ascending: false }).limit(1)) as { section_id: string | null }[];
    check(await supabaseAdmin.from("attendance_records").upsert({ institution_id: inst, student_id: c.student_id, section_id: e[0]?.section_id ?? null, att_date: c.att_date, status: c.should_be, marked_by: actor ?? null, updated_at: new Date().toISOString() }, { onConflict: "student_id,att_date" }).select("id"));
  }
  check(await supabaseAdmin.from("attendance_corrections").update({ status, decided_by: actor ?? null, decided_at: new Date().toISOString() }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ rules ═════════════
const RULE_COLS = "grading_scale, primary_grading, pass_mark, pass_mark_theory, grace_marks, retest_subjects, auto_promote, min_attendance, fail_one_action, no_detention_upto, detention_approver";
const DEFAULT_RULES = { grading_scale: "CBSE 8-point (A1 – E)", primary_grading: "Descriptive indicators + grades", pass_mark: 33, pass_mark_theory: 33, grace_marks: 5, retest_subjects: 1, auto_promote: true, min_attendance: 75, fail_one_action: "Re-test, then promote", no_detention_upto: "Always promote", detention_approver: "Principal" };
export async function getRules(inst: string) {
  const r = check(await supabaseAdmin.from("academic_rules").select(RULE_COLS).eq("institution_id", inst).maybeSingle()) as typeof DEFAULT_RULES | null;
  return r ?? DEFAULT_RULES;
}
export async function saveRules(inst: string, input: unknown) {
  const i = z.object({
    grading_scale: z.enum(["CBSE 8-point (A1 – E)", "5-point (A – E)", "Percentage only"]).optional(), primary_grading: z.enum(["Descriptive indicators + grades", "Descriptive indicators only", "Same as above"]).optional(),
    pass_mark: z.number().int().min(0).max(100).optional(), pass_mark_theory: z.number().int().min(0).max(100).optional(), grace_marks: z.number().int().min(0).max(20).optional(), retest_subjects: z.number().int().min(0).max(5).optional(),
    auto_promote: z.boolean().optional(), min_attendance: z.number().int().min(0).max(100).optional(), fail_one_action: z.enum(["Re-test, then promote", "Detain", "Promote with support"]).optional(), no_detention_upto: z.enum(["Always promote", "Follow the rules"]).optional(), detention_approver: z.enum(["Principal", "Vice Principal", "Class teacher"]).optional(),
  }).strict().parse(input);
  const merged = { ...(await getRules(inst)), ...i };
  check(await supabaseAdmin.from("academic_rules").upsert({ institution_id: inst, ...merged, updated_at: new Date().toISOString() }, { onConflict: "institution_id" }).select("institution_id"));
  return merged;
}
