import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { LIMIT } from "../school/timetable2.service";
import { istDate, mySections, one, secLabel, sectionMap, whoAmI } from "./teacher.service";

/** My Classes, House Points, My Subjects and Syllabus. Every function starts from the sections this teacher teaches. */
const uid = z.string().uuid();
const pct = (a: number, n: number) => (n ? Math.round((a / n) * 1000) / 10 : null);
const attended = (s: string) => s === "P" || s === "L" || s === "H";
const clean = (s: string) => s.replace(/^Class\s+/i, "");

/** Guardian rows as { student_id, relation, full_name, phone }: the name and phone live on the guardian record. */
export function flatGuardians(rows: unknown): { student_id: string; relation: string; full_name: string; phone: string }[] {
  type R = { student_id?: string; relation: string; guardians: { full_name: string; phone: string } | { full_name: string; phone: string }[] | null };
  return ((rows ?? []) as R[]).map((r) => ({ student_id: r.student_id ?? "", relation: r.relation, full_name: one(r.guardians)?.full_name ?? "", phone: one(r.guardians)?.phone ?? "" })).filter((r) => r.full_name);
}

interface Pupil { id: string; roll_no: string; section_id: string; name: string; registration_no: string; gender: string | null }

/** The students of some sections (this year's active enrolments). Callers pass only sections they have proven are the teacher's. */
export async function pupils(inst: string, sectionIds: string[]): Promise<Pupil[]> {
  if (!sectionIds.length) return [];
  const rows = check(await supabaseAdmin.from("student_enrollments").select("section_id, roll_no, students:student_id(id, registration_no, first_name, last_name, gender)").eq("institution_id", inst).eq("status", "Active").in("section_id", sectionIds).limit(5000)) as unknown as { section_id: string; roll_no: string | null; students: { id: string; registration_no: string; first_name: string; last_name: string; gender: string | null } | { id: string; registration_no: string; first_name: string; last_name: string; gender: string | null }[] | null }[];
  return rows.map((r) => ({ r, s: one(r.students) })).filter((x) => x.s).map(({ r, s }) => ({ id: s!.id, roll_no: r.roll_no ?? "", section_id: r.section_id, name: `${s!.first_name} ${s!.last_name}`.trim(), registration_no: s!.registration_no, gender: s!.gender }))
    .sort((a, b) => (parseInt(a.roll_no) || 9999) - (parseInt(b.roll_no) || 9999) || a.name.localeCompare(b.name));
}

/** Throws unless the section is one this teacher teaches (or, with `own`, is class teacher of). */
export async function requireSection(inst: string, me: string, sectionId: string, own = false) {
  const m = await mySections(inst, me);
  if (!(own ? m.classTeacherOf : m.ids).includes(sectionId)) throw new HttpError(403, own ? "That is not your class." : "That is not one of your classes.");
  return m;
}

/** Subject-in-section pairs: from the timetable and from the subject allocation. */
export async function teaching(inst: string, me: string) {
  const [slots, alloc] = await Promise.all([
    supabaseAdmin.from("tt_slots").select("section_id, subject_id, subjects:subject_id(name)").eq("institution_id", inst).eq("teacher_id", me).limit(2000),
    supabaseAdmin.from("teacher_subjects").select("section_id, subject_id, periods, subjects:subject_id(name)").eq("institution_id", inst).eq("teacher_id", me).limit(2000),
  ]);
  type R = { section_id: string | null; subject_id: string | null; subjects: { name: string } | { name: string }[] | null };
  const per = new Map<string, { section_id: string; subject_id: string; subject: string; periods: number }>();
  for (const r of (check(slots) ?? []) as unknown as R[]) {
    if (!r.section_id || !r.subject_id) continue;
    const k = `${r.section_id}:${r.subject_id}`; const c = per.get(k) ?? { section_id: r.section_id, subject_id: r.subject_id, subject: one(r.subjects)?.name ?? "", periods: 0 }; c.periods++; per.set(k, c);
  }
  for (const r of (check(alloc) ?? []) as unknown as R[]) {
    if (!r.section_id || !r.subject_id) continue;
    const k = `${r.section_id}:${r.subject_id}`; if (!per.has(k)) per.set(k, { section_id: r.section_id, subject_id: r.subject_id, subject: one(r.subjects)?.name ?? "", periods: 0 });
  }
  return [...per.values()];
}

export async function yearBounds(inst: string) {
  return check(await supabaseAdmin.from("academic_years").select("id, name, start_date").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { id: string; name: string; start_date: string } | null;
}

/** Attendance % per section for this year and per student, from the attendance records of the given sections. */
async function attendanceOf(inst: string, sectionIds: string[], from: string) {
  if (!sectionIds.length) return [] as { student_id: string; section_id: string | null; att_date: string; status: string }[];
  return (check(await supabaseAdmin.from("attendance_records").select("student_id, section_id, att_date, status").eq("institution_id", inst).in("section_id", sectionIds).gte("att_date", from).limit(200000)) ?? []) as { student_id: string; section_id: string | null; att_date: string; status: string }[];
}

// ═════════════ assigned classes ═════════════
export async function classList(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [sm, tt, kids, who] = await Promise.all([sectionMap(inst, m.ids), teaching(inst, me), pupils(inst, m.ids), whoAmI(inst, me)]);
  const secs = m.ids.map((id) => ({ id, s: sm.get(id)! })).filter((x) => x.s);
  const gradeOf = (x: { s: { grades: { name: string } | { name: string }[] | null } }) => clean(one(x.s.grades)?.name ?? "").replace(/^Grade\s+/i, "");
  const byGrade = new Map<string, typeof secs>();
  for (const x of secs) byGrade.set(gradeOf(x), [...(byGrade.get(gradeOf(x)) ?? []), x]);
  const periodsOf = (sec: string) => tt.filter((t) => t.section_id === sec).reduce((a, t) => a + t.periods, 0);
  const classes = [...byGrade.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([grade, list]) => ({
    class: `Class ${grade}`, subject: [...new Set(list.flatMap((x) => tt.filter((t) => t.section_id === x.id).map((t) => t.subject)))].filter(Boolean).join(", "),
    sections: list.map((x) => x.s.name).sort().join(", "), students: list.reduce((a, x) => a + kids.filter((k) => k.section_id === x.id).length, 0), periods: list.reduce((a, x) => a + periodsOf(x.id), 0),
  }));
  const ct = m.classTeacherOf[0] ? sm.get(m.classTeacherOf[0]) : null;
  return {
    teacher: who.name, classes, sections: secs.length, students: kids.length, periods: tt.reduce((a, t) => a + t.periods, 0), limit: LIMIT,
    class_teacher: ct ? { label: secLabel(ct), students: kids.filter((k) => k.section_id === m.classTeacherOf[0]).length } : null,
  };
}

export async function sectionList(inst: string, me: string) {
  const m = await mySections(inst, me);
  const y = await yearBounds(inst);
  const today = istDate();
  const [sm, tt, kids, rec, prog, chap] = await Promise.all([
    sectionMap(inst, m.ids), teaching(inst, me), pupils(inst, m.ids), attendanceOf(inst, m.ids, y?.start_date ?? today),
    supabaseAdmin.from("syllabus_progress").select("section_id, status").eq("institution_id", inst).in("section_id", m.ids.length ? m.ids : ["00000000-0000-0000-0000-000000000000"]),
    supabaseAdmin.from("curriculum_chapters").select("id, grade_id, subject_id").eq("institution_id", inst).limit(5000),
  ]);
  void prog; void chap;
  const syl = await syllabusPct(inst, me, m.ids);
  const teachers = new Map<string, string>();
  const ids = [...new Set([...sm.values()].map((s) => s.class_teacher_id).filter(Boolean) as string[])];
  if (ids.length) for (const t of (check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name").in("id", ids)) ?? []) as { id: string; first_name: string; last_name: string }[]) teachers.set(t.id, `${t.first_name} ${t.last_name}`.trim());
  const items = m.ids.map((id) => sm.get(id)).filter((s): s is NonNullable<typeof s> => !!s).map((s) => {
    const r = rec.filter((x) => x.section_id === s.id);
    const t = r.filter((x) => x.att_date === today);
    return { id: s.id, label: secLabel(s), students: kids.filter((k) => k.section_id === s.id).length, periods: tt.filter((x) => x.section_id === s.id).reduce((a, x) => a + x.periods, 0), room: s.room, class_teacher: s.class_teacher_id === me ? "You" : (s.class_teacher_id ? teachers.get(s.class_teacher_id) ?? "" : ""), is_mine: s.class_teacher_id === me, attendance_pct: pct(r.filter((x) => attended(x.status)).length, r.length), today_marked: t.length > 0, syllabus: syl.get(s.id) ?? null };
  }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return { items, default_id: m.classTeacherOf[0] ?? items[0]?.id ?? null };
}

// ═════════════ student directory ═════════════
export async function studentList(inst: string, me: string) {
  const m = await mySections(inst, me);
  const y = await yearBounds(inst);
  const [sm, kids, rec] = await Promise.all([sectionMap(inst, m.ids), pupils(inst, m.ids), attendanceOf(inst, m.ids, y?.start_date ?? istDate())]);
  const sids = kids.map((k) => k.id);
  const fathers = new Map<string, { name: string; phone: string }>();
  if (sids.length) {
    const g = flatGuardians(check(await supabaseAdmin.from("student_guardians").select("student_id, relation, guardians:guardian_id(full_name, phone)").in("student_id", sids).limit(20000)));
    for (const x of g) { const cur = fathers.get(x.student_id); if (!cur || x.relation === "Father") fathers.set(x.student_id, { name: x.full_name, phone: x.phone }); }
  }
  const by = new Map<string, { a: number; n: number }>();
  for (const r of rec) { const c = by.get(r.student_id) ?? { a: 0, n: 0 }; c.n++; if (attended(r.status)) c.a++; by.set(r.student_id, c); }
  const sections = m.ids.map((id) => sm.get(id)).filter((s): s is NonNullable<typeof s> => !!s).map((s) => {
    const ks = kids.filter((k) => k.section_id === s.id); const a = ks.reduce((t, k) => t + (by.get(k.id)?.a ?? 0), 0), n = ks.reduce((t, k) => t + (by.get(k.id)?.n ?? 0), 0);
    return { id: s.id, label: secLabel(s), students: ks.length, attendance_pct: pct(a, n), mine: s.class_teacher_id === me };
  }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const label = new Map(sections.map((s) => [s.id, s.label]));
  return {
    sections,
    items: kids.map((k) => ({ id: k.id, section_id: k.section_id, section: label.get(k.section_id) ?? "", roll_no: k.roll_no, name: k.name, gender: k.gender ?? "", registration_no: k.registration_no, father: fathers.get(k.id)?.name ?? "", mobile: fathers.get(k.id)?.phone ?? "", attendance_pct: by.get(k.id) ? Math.round((by.get(k.id)!.a / by.get(k.id)!.n) * 100) : null }))
      .sort((a, b) => a.section.localeCompare(b.section, undefined, { numeric: true }) || (parseInt(a.roll_no) || 9999) - (parseInt(b.roll_no) || 9999)),
  };
}

export async function studentProfile(inst: string, me: string, studentId: string) {
  uid.parse(studentId);
  const m = await mySections(inst, me);
  const mine = await pupils(inst, m.ids);
  const k = mine.find((x) => x.id === studentId);
  if (!k) throw new HttpError(404, "That student is not in one of your classes.");
  const y = await yearBounds(inst);
  const [sm, st, prof, guards, health, house, att, ts, hw] = await Promise.all([
    sectionMap(inst, [k.section_id]),
    supabaseAdmin.from("students").select("id").eq("id", studentId).eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("student_profiles").select("date_of_birth, blood_group, current_address, permanent_address, medical_notes").eq("student_id", studentId).maybeSingle(),
    supabaseAdmin.from("student_guardians").select("relation, guardians:guardian_id(full_name, phone)").eq("student_id", studentId),
    supabaseAdmin.from("student_health").select("blood_group, allergies, conditions, updated_on").eq("institution_id", inst).eq("student_id", studentId).maybeSingle(),
    supabaseAdmin.from("act_house_points").select("points, act_houses:house_id(name)").eq("institution_id", inst).eq("student_id", studentId).limit(500),
    attendanceOf(inst, [k.section_id], y?.start_date ?? istDate()),
    teaching(inst, me),
    supabaseAdmin.from("homework").select("id").eq("institution_id", inst).eq("section_id", k.section_id).neq("status", "Draft").limit(2000),
  ]);
  void st;
  const sec = sm.get(k.section_id);
  const mine_att = att.filter((a) => a.student_id === studentId);
  const p = check(prof) as { date_of_birth: string | null; blood_group: string | null; current_address: string | null; permanent_address: string | null; medical_notes: string | null } | null;
  const gs = flatGuardians(check(guards));
  const h = check(health) as { blood_group: string; allergies: string; conditions: string; updated_on: string } | null;
  const hp = (check(house) ?? []) as unknown as { points: number; act_houses: { name: string } | { name: string }[] | null }[];
  // my subject's assessments for this student
  const mySubjects = [...new Set(teaching_subjects(ts, k.section_id))];
  const marks = mySubjects.length ? (check(await supabaseAdmin.from("exam_marks").select("marks, absent, subject_id, exam_id, exams:exam_id(name, exam_type_id, exam_types:exam_type_id(max_marks))").eq("institution_id", inst).eq("student_id", studentId).in("subject_id", mySubjects).in("status", ["Submitted", "Verified"]).limit(500)) ?? []) as unknown as { marks: number | null; absent: boolean; exams: { name: string; exam_types: { max_marks: number } | { max_marks: number }[] | null } | { name: string; exam_types: { max_marks: number } | { max_marks: number }[] | null }[] | null }[] : [];
  const assess = marks.filter((x) => x.marks !== null && !x.absent).map((x) => { const e = one(x.exams); return { name: e?.name ?? "", marks: Number(x.marks), max: one(e?.exam_types ?? null)?.max_marks ?? 100 }; });
  const subjPct = assess.length ? Math.round((assess.reduce((a, x) => a + x.marks, 0) / assess.reduce((a, x) => a + x.max, 0)) * 100) : null;
  // rank in section by the same measure
  let rank: { n: number; of: number } | null = null;
  if (mySubjects.length) {
    const all = (check(await supabaseAdmin.from("exam_marks").select("student_id, marks, exams:exam_id(exam_types:exam_type_id(max_marks))").eq("institution_id", inst).in("student_id", mine.filter((x) => x.section_id === k.section_id).map((x) => x.id)).in("subject_id", mySubjects).in("status", ["Submitted", "Verified"]).not("marks", "is", null).limit(20000)) ?? []) as unknown as { student_id: string; marks: number; exams: { exam_types: { max_marks: number } | { max_marks: number }[] | null } | { exam_types: { max_marks: number } | { max_marks: number }[] | null }[] | null }[];
    const tot = new Map<string, { a: number; b: number }>();
    for (const r of all) { const c = tot.get(r.student_id) ?? { a: 0, b: 0 }; c.a += Number(r.marks); c.b += one(one(r.exams)?.exam_types ?? null)?.max_marks ?? 100; tot.set(r.student_id, c); }
    const ranked = [...tot.entries()].map(([id, v]) => ({ id, p: v.a / v.b })).sort((a, b) => b.p - a.p);
    const at = ranked.findIndex((r) => r.id === studentId);
    if (at >= 0) rank = { n: at + 1, of: mine.filter((x) => x.section_id === k.section_id).length };
  }
  let hwDone: number | null = null;
  const hws = (check(hw) ?? []) as { id: string }[];
  if (hws.length) { const sub = await supabaseAdmin.from("hw_submissions").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("student_id", studentId).in("homework_id", hws.map((x) => x.id)).in("status", ["Submitted", "Late", "Checked"]); hwDone = Math.round(((sub.count ?? 0) / hws.length) * 100); }
  return {
    student: { id: k.id, name: k.name, class_label: `${secLabel(sec ?? null)} · roll ${k.roll_no}`, registration_no: k.registration_no, gender: k.gender, date_of_birth: p?.date_of_birth ?? null, blood_group: h?.blood_group || p?.blood_group || "", house: hp.length ? (one(hp[0].act_houses)?.name ?? "") : "" },
    parents: { father: gs.find((g) => g.relation === "Father")?.full_name ?? "", mother: gs.find((g) => g.relation === "Mother")?.full_name ?? "", mobile: (gs.find((g) => g.relation === "Father") ?? gs[0])?.phone ?? "", address: p?.current_address || p?.permanent_address || "" },
    attendance_pct: mine_att.length ? Math.round((mine_att.filter((a) => attended(a.status)).length / mine_att.length) * 100) : null, subject_pct: subjPct, homework_pct: hwDone, rank,
    health: { allergies: h?.allergies ?? "", conditions: h?.conditions || p?.medical_notes || "", blood_group: h?.blood_group || p?.blood_group || "", updated_on: h?.updated_on ?? null },
    assessments: assess, subject: mySubjects.length ? (ts.find((t) => t.section_id === k.section_id)?.subject ?? "") : "",
  };
}
const teaching_subjects = (ts: { section_id: string; subject_id: string }[], section: string) => ts.filter((t) => t.section_id === section).map((t) => t.subject_id);

/** Health alerts: only for the class this teacher is class teacher of. */
export async function healthAlerts(inst: string, me: string, sectionId: string) {
  await requireSection(inst, me, uid.parse(sectionId), true);
  const [kids, sm] = await Promise.all([pupils(inst, [sectionId]), sectionMap(inst, [sectionId])]);
  const h = kids.length ? (check(await supabaseAdmin.from("student_health").select("student_id, blood_group, allergies, conditions").eq("institution_id", inst).in("student_id", kids.map((k) => k.id))) ?? []) as { student_id: string; blood_group: string; allergies: string; conditions: string }[] : [];
  const H = new Map(h.map((x) => [x.student_id, x]));
  const none = (s: string | undefined) => !s || /^(none|nil|no|-|—)$/i.test(s.trim());
  const items = kids.map((k) => ({ id: k.id, roll_no: k.roll_no, name: k.name, allergy: none(H.get(k.id)?.allergies) ? "" : H.get(k.id)!.allergies, condition: none(H.get(k.id)?.conditions) ? "" : H.get(k.id)!.conditions, blood_group: H.get(k.id)?.blood_group ?? "" })).filter((x) => x.allergy || x.condition);
  return { label: secLabel(sm.get(sectionId) ?? null), students: kids.length, alerts: items.length, allergies: items.filter((x) => x.allergy).length, conditions: items.filter((x) => x.condition).length, items };
}

// ═════════════ house points ═════════════
export async function housePoints(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [houses, pts, kids, sm] = await Promise.all([
    supabaseAdmin.from("act_houses").select("id, name").eq("institution_id", inst).order("name"),
    supabaseAdmin.from("act_house_points").select("id, house_id, student_label, points, reason, awarded_by, awarded_on").eq("institution_id", inst).order("awarded_on", { ascending: false }).limit(5000),
    pupils(inst, m.ids), sectionMap(inst, m.ids),
  ]);
  const H = (check(houses) ?? []) as { id: string; name: string }[];
  const P = (check(pts) ?? []) as { id: string; house_id: string; student_label: string; points: number; reason: string; awarded_by: string; awarded_on: string }[];
  const name = new Map(H.map((h) => [h.id, h.name]));
  const board = H.map((h) => ({ id: h.id, name: h.name, points: P.filter((p) => p.house_id === h.id).reduce((a, p) => a + p.points, 0) })).sort((a, b) => b.points - a.points);
  return {
    houses: H, board, students: kids.map((k) => ({ id: k.id, label: `${k.name} · ${clean(secLabel(sm.get(k.section_id) ?? null)).replace(/^(\d+)\s*/, "$1 ")}` })),
    items: P.slice(0, 20).map((p) => ({ id: p.id, date: p.awarded_on, student: p.student_label, house: name.get(p.house_id) ?? "", points: p.points, reason: p.reason, by: p.awarded_by })),
  };
}

export async function awardPoints(inst: string, me: string, input: unknown) {
  const i = z.object({ student_id: uid, house_id: uid, points: z.number().int().min(1).max(100), reason: z.string().trim().min(3, "Say what it is for.").max(160) }).strict().parse(input);
  const m = await mySections(inst, me);
  const k = (await pupils(inst, m.ids)).find((x) => x.id === i.student_id);
  if (!k) throw new HttpError(404, "That student is not in one of your classes.");
  if (!check(await supabaseAdmin.from("act_houses").select("id").eq("id", i.house_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "House not found.");
  const sm = await sectionMap(inst, [k.section_id]);
  const who = await whoAmI(inst, me);
  check(await supabaseAdmin.from("act_house_points").insert({ institution_id: inst, house_id: i.house_id, student_id: k.id, student_label: `${k.name} · ${clean(secLabel(sm.get(k.section_id) ?? null))}`, points: i.points, reason: i.reason, awarded_by: who.name.slice(0, 80) }).select("id"));
  return { ok: true };
}

// ═════════════ subjects and syllabus ═════════════
interface Chap { id: string; grade_id: string; subject_id: string; chapter: string; periods: number; planned_month: string | null; objective: string | null }

async function sectionGrades(inst: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const r = check(await supabaseAdmin.from("sections").select("id, grade_id").eq("institution_id", inst).in("id", ids)) as { id: string; grade_id: string }[];
  return new Map(r.map((x) => [x.id, x.grade_id]));
}

export async function progressModel(inst: string, me: string, sectionIds: string[]) {
  const [tt, grade] = await Promise.all([teaching(inst, me), sectionGrades(inst, sectionIds)]);
  const pairs = tt.filter((t) => sectionIds.includes(t.section_id));
  const gradeIds = [...new Set(pairs.map((p) => grade.get(p.section_id)).filter(Boolean))] as string[];
  const subjIds = [...new Set(pairs.map((p) => p.subject_id))];
  const [ch, pr] = await Promise.all([
    gradeIds.length ? supabaseAdmin.from("curriculum_chapters").select("id, grade_id, subject_id, chapter, periods, planned_month, objective").eq("institution_id", inst).in("grade_id", gradeIds).in("subject_id", subjIds).order("created_at") : Promise.resolve({ data: [], error: null }),
    sectionIds.length ? supabaseAdmin.from("syllabus_progress").select("section_id, chapter_id, status, progress").eq("institution_id", inst).in("section_id", sectionIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const chapters = (check(ch as never) ?? []) as Chap[];
  const rowsP = (check(pr as never) ?? []) as { section_id: string; chapter_id: string; status: string; progress: number }[];
  const progress = new Map(rowsP.map((p) => [`${p.section_id}:${p.chapter_id}`, p.progress >= 100 ? "Done" : p.progress > 0 ? "In progress" : "Not started"]));
  const percent = new Map(rowsP.map((p) => [`${p.section_id}:${p.chapter_id}`, p.progress]));
  return { pairs, grade, chapters, progress, percent };
}
const avg = (vals: number[]) => (vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null);

async function syllabusPct(inst: string, me: string, sectionIds: string[]) {
  const { pairs, grade, chapters, percent } = await progressModel(inst, me, sectionIds);
  const out = new Map<string, number>();
  for (const s of sectionIds) {
    const mine = pairs.filter((p) => p.section_id === s);
    const ch = chapters.filter((c) => c.grade_id === grade.get(s) && mine.some((p) => p.subject_id === c.subject_id));
    const v = avg(ch.map((c) => percent.get(`${s}:${c.id}`) ?? 0));
    if (v !== null) out.set(s, v);
  }
  return out;
}

export async function subjectList(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [{ pairs, grade, chapters, progress, percent }, sm] = await Promise.all([progressModel(inst, me, m.ids), sectionMap(inst, m.ids)]);
  const items = pairs.filter((p) => sm.has(p.section_id)).map((p) => {
    const ch = chapters.filter((c) => c.grade_id === grade.get(p.section_id) && c.subject_id === p.subject_id);
    const st = ch.map((c) => progress.get(`${p.section_id}:${c.id}`) ?? "Not started");
    const done = st.filter((x) => x === "Done").length;
    const cur = ch.find((c, i) => st[i] === "In progress") ?? ch.find((c, i) => st[i] === "Not started");
    return { section_id: p.section_id, section: secLabel(sm.get(p.section_id) ?? null), subject: p.subject, subject_id: p.subject_id, periods: p.periods, chapters_done: done, chapters_total: ch.length, percent: avg(ch.map((c) => percent.get(`${p.section_id}:${c.id}`) ?? 0)), current_chapter: cur?.chapter ?? (ch.length ? "All chapters done" : "") };
  }).sort((a, b) => a.section.localeCompare(b.section, undefined, { numeric: true }) || a.subject.localeCompare(b.subject));
  return { items, sections: [...new Set(items.map((i) => i.section))].length, classes: [...new Set(items.map((i) => i.section.split(" ").slice(0, 2).join(" ")))].map((c) => c.replace(/^Class /, "")) };
}

export async function syllabus(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [{ pairs, grade, chapters, progress }, sm] = await Promise.all([progressModel(inst, me, m.ids), sectionMap(inst, m.ids)]);
  const gradeName = new Map<string, string>();
  for (const s of sm.values()) { const g = grade.get(s.id); if (g) gradeName.set(g, `Class ${clean(one(s.grades)?.name ?? "").replace(/^Grade\s+/i, "")}`); }
  const secs = [...sm.values()].sort((a, b) => secLabel(a).localeCompare(secLabel(b), undefined, { numeric: true }));
  const items = chapters.map((c, i) => {
    const bySection = secs.filter((s) => grade.get(s.id) === c.grade_id && pairs.some((p) => p.section_id === s.id && p.subject_id === c.subject_id)).map((s) => ({ section_id: s.id, label: secLabel(s).replace(/^Class\s*/, ""), status: progress.get(`${s.id}:${c.id}`) ?? "Not started" }));
    const done = bySection.filter((x) => x.status === "Done").length;
    return { id: c.id, class: gradeName.get(c.grade_id) ?? "", no: chapters.filter((x, j) => j <= i && x.grade_id === c.grade_id && x.subject_id === c.subject_id).length, chapter: c.chapter, planned_for: c.planned_month ?? "", objective: c.objective ?? "", sections: bySection, status: !bySection.length || done === 0 ? (bySection.some((x) => x.status === "In progress") ? "In progress" : "Not started") : done === bySection.length ? "Done" : "In progress" };
  }).sort((a, b) => a.class.localeCompare(b.class, undefined, { numeric: true }) || a.no - b.no);
  const sections = (await subjectList(inst, me)).items.reduce((acc, r) => { if (!acc.some((x) => x.section_id === r.section_id)) acc.push({ section_id: r.section_id, section: r.section, percent: r.percent, chapters_done: r.chapters_done, chapters_total: r.chapters_total }); return acc; }, [] as { section_id: string; section: string; percent: number | null; chapters_done: number; chapters_total: number }[]);
  return { items, sections, subject: pairs[0]?.subject ?? "" };
}

export async function setProgress(inst: string, me: string, input: unknown) {
  const i0 = z.object({ section_id: uid, chapter_id: uid, status: z.enum(["Not started", "In progress", "Done"]).optional(), progress: z.number().int().min(0).max(100).optional() }).strict().parse(input);
  if (i0.status === undefined && i0.progress === undefined) throw new HttpError(400, "Nothing to change.");
  const pct0 = i0.progress ?? (i0.status === "Done" ? 100 : i0.status === "In progress" ? 50 : 0);
  const i = { section_id: i0.section_id, chapter_id: i0.chapter_id, progress: pct0, status: pct0 >= 100 ? "Done" : pct0 > 0 ? "In progress" : "Not started" };
  await requireSection(inst, me, i.section_id);
  const { pairs, grade, chapters } = await progressModel(inst, me, [i.section_id]);
  const c = chapters.find((x) => x.id === i.chapter_id);
  if (!c || c.grade_id !== grade.get(i.section_id) || !pairs.some((p) => p.subject_id === c.subject_id)) throw new HttpError(403, "That chapter is not part of what you teach in this class.");
  check(await supabaseAdmin.from("syllabus_progress").upsert({ institution_id: inst, section_id: i.section_id, chapter_id: i.chapter_id, status: i.status, progress: i.progress, updated_by: me, updated_at: new Date().toISOString() }, { onConflict: "section_id,chapter_id" }).select("chapter_id"));
  return { ok: true };
}
