import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { sheet, saveSheet, requestCorrection } from "../school/attendance.service";
import { decideLeave } from "../school/attendance3.service";
import { getAttSettings } from "../school/timetable.service";
import { istDate, mySections, one, secLabel, sectionMap } from "./teacher.service";
import { flatGuardians, pupils, requireSection } from "./teacher-classes.service";

/** Attendance for the class this teacher is class teacher of, edit requests, student leave, and attendance history for all their sections. */
const uid = z.string().uuid();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const attended = (s: string) => s === "P" || s === "L" || s === "H";
const pct = (a: number, n: number) => (n ? Math.round((a / n) * 1000) / 10 : null);
const NAMES: Record<string, string> = { P: "Present", A: "Absent", L: "Late", H: "Half day", V: "Leave" };

// ═════════════ mark attendance ═════════════
export async function myRegisters(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [sm, cfg] = await Promise.all([sectionMap(inst, m.classTeacherOf), getAttSettings(inst)]);
  return { sections: m.classTeacherOf.map((id) => ({ id, label: secLabel(sm.get(id) ?? null) })), closes_at: cfg.closes_at, sms_absent: cfg.sms_absent, lock_after: cfg.lock_after };
}

export async function registerSheet(inst: string, me: string, sectionId: string, date: string) {
  await requireSection(inst, me, uid.parse(sectionId), true);
  const s = await sheet(inst, sectionId, date);
  return { ...s, label: secLabel((await sectionMap(inst, [sectionId])).get(sectionId) ?? null) };
}

export async function saveRegister(inst: string, me: string, input: unknown) {
  const sectionId = uid.parse((input as { section_id?: unknown })?.section_id);
  await requireSection(inst, me, sectionId, true);
  return saveSheet(inst, input, me);
}

// ═════════════ edit requests ═════════════
export async function editRequests(inst: string, me: string) {
  const rows = check(await supabaseAdmin.from("attendance_corrections").select("id, code, student_id, att_date, marked, should_be, reason, status, created_at").eq("institution_id", inst).eq("requested_by", me).order("created_at", { ascending: false }).limit(300)) as { id: string; code: string; student_id: string; att_date: string; marked: string; should_be: string; reason: string; status: string; created_at: string }[];
  const ids = [...new Set(rows.map((r) => r.student_id))];
  const enr = ids.length ? (check(await supabaseAdmin.from("student_enrollments").select("student_id, section_id, students:student_id(first_name, last_name)").eq("institution_id", inst).in("student_id", ids).order("created_at", { ascending: false })) ?? []) as unknown as { student_id: string; section_id: string | null; students: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[] : [];
  const sm = await sectionMap(inst, [...new Set(enr.map((e) => e.section_id).filter(Boolean) as string[])]);
  const E = new Map<string, (typeof enr)[number]>(); for (const e of enr) if (!E.has(e.student_id)) E.set(e.student_id, e);
  return { items: rows.map((r) => { const e = E.get(r.student_id); const s = one(e?.students ?? null); return { id: r.id, code: r.code, date: r.att_date, class_label: secLabel(sm.get(e?.section_id ?? "") ?? null), student: s ? `${s.first_name} ${s.last_name}`.trim() : "", marked: r.marked, should_be: NAMES[r.should_be] ?? r.should_be, reason: r.reason, status: r.status, requested_on: r.created_at }; }) };
}

export async function sendEditRequest(inst: string, me: string, input: unknown) {
  const i = z.object({ student_id: uid, att_date: iso, should_be: z.enum(["P", "A", "L", "H", "V"]), reason: z.string().trim().min(3, "Give a reason.").max(300) }).strict().parse(input);
  const m = await mySections(inst, me);
  if (!(await pupils(inst, m.classTeacherOf)).some((k) => k.id === i.student_id)) throw new HttpError(403, "That student is not in your class.");
  return requestCorrection(inst, i, me);
}

/** What a student was marked on a day, so the request form can show "Marked as". */
export async function markedOn(inst: string, me: string, studentId: string, date: string) {
  iso.parse(date);
  const m = await mySections(inst, me);
  if (!(await pupils(inst, m.classTeacherOf)).some((k) => k.id === uid.parse(studentId))) throw new HttpError(403, "That student is not in your class.");
  const r = check(await supabaseAdmin.from("attendance_records").select("status").eq("institution_id", inst).eq("student_id", studentId).eq("att_date", date).maybeSingle()) as { status: string } | null;
  return { marked: r ? NAMES[r.status] : "Not marked", status: r?.status ?? null };
}

// ═════════════ student leave ═════════════
export async function studentLeaves(inst: string, me: string) {
  const m = await mySections(inst, me);
  const kids = await pupils(inst, m.classTeacherOf);
  const sm = await sectionMap(inst, m.classTeacherOf);
  const ids = kids.map((k) => k.id);
  const [rows, gs] = await Promise.all([
    ids.length ? supabaseAdmin.from("student_leaves").select("id, code, student_id, leave_type, from_date, to_date, days, applied_on, status").eq("institution_id", inst).in("student_id", ids).order("applied_on", { ascending: false }).limit(500) : Promise.resolve({ data: [], error: null }),
    ids.length ? supabaseAdmin.from("student_guardians").select("student_id, relation, guardians:guardian_id(full_name, phone)").in("student_id", ids).limit(5000) : Promise.resolve({ data: [], error: null }),
  ]);
  const G = new Map<string, string>(); for (const g of flatGuardians(check(gs as never))) if (!G.has(g.student_id) || g.relation === "Father") G.set(g.student_id, g.full_name);
  const K = new Map(kids.map((k) => [k.id, k]));
  const items = ((check(rows as never) ?? []) as { id: string; code: string; student_id: string; leave_type: string; from_date: string; to_date: string; days: number; applied_on: string; status: string }[]).map((r) => ({ id: r.id, ref: r.code, student: K.get(r.student_id)?.name ?? "", roll_no: K.get(r.student_id)?.roll_no ?? "", parent: G.get(r.student_id) ?? "", from_date: r.from_date, to_date: r.to_date, days: r.days, reason: r.leave_type, applied_on: r.applied_on, status: r.status }));
  const month = istDate().slice(0, 7);
  return { class_label: m.classTeacherOf[0] ? secLabel(sm.get(m.classTeacherOf[0]) ?? null) : "", is_class_teacher: m.classTeacherOf.length > 0, items, waiting: items.filter((x) => x.status === "Pending").length, this_month: items.filter((x) => x.applied_on.startsWith(month)).length };
}

export async function decideStudentLeave(inst: string, me: string, id: string, input: unknown) {
  uid.parse(id);
  const m = await mySections(inst, me);
  const kids = new Set((await pupils(inst, m.classTeacherOf)).map((k) => k.id));
  const l = check(await supabaseAdmin.from("student_leaves").select("student_id").eq("id", id).eq("institution_id", inst).maybeSingle()) as { student_id: string } | null;
  if (!l || !kids.has(l.student_id)) throw new HttpError(404, "Leave application not found.");
  return decideLeave(inst, "student", id, input, me);
}

// ═════════════ attendance history ═════════════
async function yearsOf(inst: string) {
  return (check(await supabaseAdmin.from("academic_years").select("id, name, start_date, end_date, is_current").eq("institution_id", inst).order("start_date", { ascending: false })) ?? []) as { id: string; name: string; start_date: string; end_date: string; is_current: boolean }[];
}
type Rec = { student_id: string; section_id: string | null; att_date: string; status: string };
async function records(inst: string, sectionIds: string[], from: string, to: string) {
  if (!sectionIds.length) return [] as Rec[];
  return (check(await supabaseAdmin.from("attendance_records").select("student_id, section_id, att_date, status").eq("institution_id", inst).in("section_id", sectionIds).gte("att_date", from).lte("att_date", to).limit(300000)) ?? []) as Rec[];
}

export async function historyDaily(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [sm, kids] = await Promise.all([sectionMap(inst, m.ids), pupils(inst, m.ids)]);
  const from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const R = await records(inst, m.ids, from, istDate());
  const days = [...new Set(R.map((r) => r.att_date))].sort().reverse().slice(0, 10);
  const secs = m.ids.map((id) => sm.get(id)).filter((s): s is NonNullable<typeof s> => !!s).sort((a, b) => secLabel(a).localeCompare(secLabel(b), undefined, { numeric: true }));
  const inDays = R.filter((r) => days.includes(r.att_date));
  return {
    sections: secs.map((s) => ({ id: s.id, label: secLabel(s), students: kids.filter((k) => k.section_id === s.id).length, percent: pct(inDays.filter((r) => r.section_id === s.id && attended(r.status)).length, inDays.filter((r) => r.section_id === s.id).length) })),
    days: days.map((d) => { const day = R.filter((r) => r.att_date === d); return { date: d, present: day.filter((r) => attended(r.status)).length, total: day.length, absent: day.filter((r) => r.status === "A").length, late: day.filter((r) => r.status === "L").length, overall: pct(day.filter((r) => attended(r.status)).length, day.length), by_section: Object.fromEntries(secs.map((s) => [s.id, pct(day.filter((r) => r.section_id === s.id && attended(r.status)).length, day.filter((r) => r.section_id === s.id).length)])) }; }),
  };
}

export async function historyMonthly(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [sm, kids, years] = await Promise.all([sectionMap(inst, m.ids), pupils(inst, m.ids), yearsOf(inst)]);
  const y = years.find((x) => x.is_current);
  if (!y) return { year: "", months: [] as string[], sections: [], overall: [] as { month: string; percent: number | null }[] };
  const R = await records(inst, m.ids, y.start_date, istDate());
  const months = [...new Set(R.map((r) => r.att_date.slice(0, 7)))].sort();
  const secs = m.ids.map((id) => sm.get(id)).filter((s): s is NonNullable<typeof s> => !!s).sort((a, b) => secLabel(a).localeCompare(secLabel(b), undefined, { numeric: true }));
  const p = (rs: Rec[]) => pct(rs.filter((r) => attended(r.status)).length, rs.length);
  return {
    year: y.name, months, current_month: istDate().slice(0, 7),
    overall: months.map((mo) => ({ month: mo, percent: p(R.filter((r) => r.att_date.startsWith(mo))) })),
    sections: secs.map((s) => ({ id: s.id, label: secLabel(s), students: kids.filter((k) => k.section_id === s.id).length, by_month: Object.fromEntries(months.map((mo) => [mo, p(R.filter((r) => r.section_id === s.id && r.att_date.startsWith(mo)))])), year: p(R.filter((r) => r.section_id === s.id)) })),
  };
}

export async function historyYearly(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [sm, kids, years] = await Promise.all([sectionMap(inst, m.ids), pupils(inst, m.ids), yearsOf(inst)]);
  const cur = years.find((x) => x.is_current);
  const secs = m.ids.map((id) => sm.get(id)).filter((s): s is NonNullable<typeof s> => !!s).sort((a, b) => secLabel(a).localeCompare(secLabel(b), undefined, { numeric: true }));
  const labels = new Set(secs.map((s) => secLabel(s)));
  // the same class in earlier years has its own section rows; match them by name
  const all = (check(await supabaseAdmin.from("sections").select("id, name, academic_year_id, grades:grade_id(name)").eq("institution_id", inst).in("academic_year_id", years.slice(0, 3).map((y) => y.id))) ?? []) as unknown as { id: string; name: string; academic_year_id: string; grades: { name: string } | { name: string }[] | null }[];
  const mine = all.filter((s) => labels.has(secLabel(s)));
  const R = mine.length ? (check(await supabaseAdmin.from("attendance_records").select("student_id, section_id, att_date, status").eq("institution_id", inst).in("section_id", mine.map((s) => s.id)).gte("att_date", years[Math.min(2, years.length - 1)]?.start_date ?? "2000-01-01").limit(500000)) ?? []) as Rec[] : [];
  const p = (rs: Rec[]) => pct(rs.filter((r) => attended(r.status)).length, rs.length);
  const perYear = years.slice(0, 3).map((yr) => { const ids = new Set(mine.filter((s) => s.academic_year_id === yr.id).map((s) => s.id)); const rs = R.filter((r) => ids.has(r.section_id ?? "")); return { id: yr.id, name: yr.name, current: yr.is_current, percent: p(rs), bySection: new Map(secs.map((s) => [secLabel(s), p(rs.filter((r) => { const sec = mine.find((x) => x.id === r.section_id); return !!sec && secLabel(sec) === secLabel(s); }))] as const)) }; });
  const curRecs = R.filter((r) => mine.some((s) => s.id === r.section_id && s.academic_year_id === cur?.id));
  const per = new Map<string, { a: number; n: number; sec: string | null }>();
  for (const r of curRecs) { const c = per.get(r.student_id) ?? { a: 0, n: 0, sec: r.section_id }; c.n++; if (attended(r.status)) c.a++; per.set(r.student_id, c); }
  const stu = [...per.values()].map((v) => ({ p: (v.a / v.n) * 100, sec: v.sec }));
  const band = (lo: number, hi: number) => stu.filter((x) => x.p >= lo && x.p < hi).length;
  const workDays = cur ? new Set(curRecs.map((r) => r.att_date)).size : 0;
  return {
    this_year: perYear.find((y) => y.current)?.percent ?? null, last_year: perYear.find((y) => !y.current)?.percent ?? null, students: kids.length,
    top: stu.filter((x) => x.p >= 97).length, low: stu.filter((x) => x.p < 85).length, school_days: workDays,
    years: perYear.map((y) => ({ name: y.name, current: y.current, percent: y.percent })),
    bands: [{ label: "97% and above", n: band(97, 101) }, { label: "90 - 96%", n: band(90, 97) }, { label: "85 - 89%", n: band(85, 90) }, { label: "Below 85%", n: band(0, 85) }],
    sections: secs.map((s) => { const cs = secLabel(s); const now = perYear.find((y) => y.current)?.bySection.get(cs) ?? null; const prev = perYear.filter((y) => !y.current).map((y) => y.bySection.get(cs) ?? null); const st = stu.filter((x) => x.sec === s.id); return { id: s.id, label: cs, students: kids.filter((k) => k.section_id === s.id).length, by_year: perYear.map((y) => ({ name: y.name, percent: y.bySection.get(cs) ?? null })), change: now !== null && prev[0] !== null && prev[0] !== undefined ? Math.round((now - prev[0]) * 10) / 10 : null, top: st.filter((x) => x.p >= 97).length, low: st.filter((x) => x.p < 85).length }; }),
  };
}
