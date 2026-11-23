import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { safeSearch } from "../../lib/query";
import { categories } from "../school/front-office.service";

/**
 * The Teacher portal: dashboard, notifications, check-in, event duties, help desk and calendar.
 * Every function takes the signed-in teacher's profile id and school from the server session (never from the request),
 * and every query is limited to that person and that school.
 */
export const TZ = "Asia/Kolkata";
export const istDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: TZ });
export const hm = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) : "");
export const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const nameOf = (p: { first_name: string; last_name: string } | null) => (p ? `${p.first_name} ${p.last_name}`.trim() : "");
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
export const secLabel = (s: { name: string; grades: { name: string } | { name: string }[] | null } | null) => (s ? `Class ${(one(s.grades)?.name ?? "").replace(/^(Grade|Class)\s+/i, "")} ${s.name}`.replace(/\s+/g, " ").trim() : "");

export interface SecRow { id: string; name: string; room: string | null; class_teacher_id: string | null; grades: { name: string } | { name: string }[] | null }

/** The sections this teacher teaches or is class teacher of. */
export async function mySections(inst: string, me: string) {
  const [slots, subs, cls] = await Promise.all([
    supabaseAdmin.from("tt_slots").select("section_id").eq("institution_id", inst).eq("teacher_id", me).limit(2000),
    supabaseAdmin.from("teacher_subjects").select("section_id").eq("institution_id", inst).eq("teacher_id", me).limit(2000),
    supabaseAdmin.from("sections").select("id").eq("institution_id", inst).eq("class_teacher_id", me).limit(200),
  ]);
  const yr = check(await supabaseAdmin.from("academic_years").select("id").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { id: string } | null;
  const live = new Set(((yr ? check(await supabaseAdmin.from("sections").select("id").eq("institution_id", inst).eq("academic_year_id", yr.id).eq("is_active", true).limit(2000)) : []) as { id: string }[]).map((x) => x.id));
  const ids = new Set<string>();
  for (const r of [...((check(slots) ?? []) as { section_id: string | null }[]), ...((check(subs) ?? []) as { section_id: string | null }[]), ...((check(cls) ?? []) as { id: string }[]).map((x) => ({ section_id: x.id }))]) if (r.section_id && live.has(r.section_id)) ids.add(r.section_id);
  return { ids: [...ids], classTeacherOf: ((check(cls) ?? []) as { id: string }[]).map((x) => x.id).filter((x) => live.has(x)) };
}

export async function sectionMap(inst: string, ids: string[]) {
  if (!ids.length) return new Map<string, SecRow>();
  const r = check(await supabaseAdmin.from("sections").select("id, name, room, class_teacher_id, grades:grade_id(name)").eq("institution_id", inst).in("id", ids)) as unknown as SecRow[];
  return new Map(r.map((s) => [s.id, s]));
}

// ═════════════ who am I ═════════════
export async function whoAmI(inst: string, me: string) {
  const [p, subj, staff] = await Promise.all([
    supabaseAdmin.from("user_profiles").select("first_name, last_name, designation, roles:role_id(name, display_name), campuses:campus_id(name)").eq("id", me).eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("teacher_subjects").select("subjects:subject_id(name)").eq("institution_id", inst).eq("teacher_id", me).limit(20),
    supabaseAdmin.from("hr_staff").select("emp_code, department, staff_type, joined_on").eq("profile_id", me).eq("institution_id", inst).maybeSingle(),
  ]);
  const prof = check(p) as unknown as { first_name: string; last_name: string; designation: string | null; roles: { name: string; display_name: string } | { name: string; display_name: string }[] | null; campuses: { name: string } | { name: string }[] | null } | null;
  if (!prof) throw new HttpError(404, "Profile not found.");
  const subjects = [...new Set(((check(subj) ?? []) as unknown as { subjects: { name: string } | { name: string }[] | null }[]).map((x) => one(x.subjects)?.name).filter(Boolean) as string[])];
  const st = check(staff) as { emp_code: string; department: string; staff_type: string; joined_on: string | null } | null;
  const first = prof.first_name;
  return {
    id: me, name: `${prof.first_name} ${prof.last_name}`.trim(), first_name: first, role: one(prof.roles)?.name ?? "", designation: prof.designation ?? "",
    subjects, line: subjects.length ? `${subjects[0]} teacher` : (prof.designation || one(prof.roles)?.display_name || "Teacher"),
    emp_code: st?.emp_code ?? null, department: st?.department ?? "", staff_type: st?.staff_type ?? "Teaching", joined_on: st?.joined_on ?? null, campus: one(prof.campuses)?.name ?? null,
  };
}

// ═════════════ today's classes ═════════════
interface Period { id: string; label: string; starts: string; ends: string; kind: string }
const dayNo = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1; // Monday = 1 … Sunday = 7 (the timetable holds 1–6)

export async function dashboard(inst: string, me: string) {
  const today = istDate();
  const now = new Date();
  const nowHm = hm(now.toISOString());
  const dn = dayNo(new Date(`${today}T00:00:00Z`));
  const [who, per, slots, subs, secs] = await Promise.all([
    whoAmI(inst, me),
    supabaseAdmin.from("tt_periods").select("id, label, starts, ends, kind").eq("institution_id", inst).order("starts"),
    supabaseAdmin.from("tt_slots").select("id, section_id, period_id, subjects:subject_id(name)").eq("institution_id", inst).eq("teacher_id", me).eq("day", Math.min(dn, 6)),
    supabaseAdmin.from("substitutions").select("id, period_id, section_id, status, absent:absent_teacher_id(first_name, last_name), subjects:subject_id(name)").eq("institution_id", inst).eq("substitute_id", me).eq("sub_date", today),
    mySections(inst, me),
  ]);
  const periods = (check(per) ?? []) as Period[];
  const mySlots = dn <= 6 ? ((check(slots) ?? []) as unknown as { id: string; section_id: string; period_id: string; subjects: { name: string } | { name: string }[] | null }[]) : [];
  // classes the teacher gave away today are covered by a substitute
  const away = dn <= 6 ? ((check(await supabaseAdmin.from("substitutions").select("period_id, section_id").eq("institution_id", inst).eq("absent_teacher_id", me).eq("sub_date", today))) ?? []) as { period_id: string; section_id: string }[] : [];
  const awayKey = new Set(away.map((a) => `${a.period_id}:${a.section_id}`));
  const subList = (check(subs) ?? []) as unknown as { id: string; period_id: string; section_id: string; status: string; absent: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null; subjects: { name: string } | { name: string }[] | null }[];
  const secIds = [...new Set([...mySlots.map((s) => s.section_id), ...subList.map((s) => s.section_id), ...secs.classTeacherOf])];
  const smap = await sectionMap(inst, secIds);
  const byPeriod = new Map<string, { section: string; subject: string; room: string | null; substitution: boolean; sub_id: string | null }>();
  for (const s of mySlots) if (!awayKey.has(`${s.period_id}:${s.section_id}`)) byPeriod.set(s.period_id, { section: secLabel(smap.get(s.section_id) ?? null), subject: one(s.subjects)?.name ?? "", room: smap.get(s.section_id)?.room ?? null, substitution: false, sub_id: null });
  for (const s of subList) byPeriod.set(s.period_id, { section: secLabel(smap.get(s.section_id) ?? null), subject: one(s.subjects)?.name ?? "", room: smap.get(s.section_id)?.room ?? null, substitution: true, sub_id: s.id });
  let nextMarked = false;
  const classes = periods.filter((p) => p.kind === "Teaching" || byPeriod.has(p.id)).map((p) => {
    const c = byPeriod.get(p.id);
    const starts = p.starts.slice(0, 5), ends = p.ends.slice(0, 5);
    let state: "Done" | "Now" | "Next" | "" = "";
    if (dn <= 6) {
      if (ends <= nowHm) state = "Done";
      else if (starts <= nowHm) state = "Now";
      else if (!nextMarked && c) { state = "Next"; nextMarked = true; }
    }
    return { period: p.label, starts, ends, free: !c, section: c?.section ?? "", subject: c?.subject ?? "", room: c?.room ?? null, substitution: !!c?.substitution, state };
  });
  const taught = classes.filter((c) => !c.free);

  // the class register of the class this teacher is class teacher of
  const ctId = secs.classTeacherOf[0] ?? null;
  let register: { section: string; marked: boolean; present: number; total: number } | null = null;
  if (ctId) {
    const [enr, rec] = await Promise.all([
      supabaseAdmin.from("student_enrollments").select("id", { count: "exact", head: true }).eq("section_id", ctId).eq("status", "Active"),
      supabaseAdmin.from("attendance_records").select("status").eq("institution_id", inst).eq("section_id", ctId).eq("att_date", today).limit(2000),
    ]);
    const r = (check(rec) ?? []) as { status: string }[];
    register = { section: secLabel(smap.get(ctId) ?? null), marked: r.length > 0, present: r.filter((x) => x.status === "P" || x.status === "L" || x.status === "H").length, total: enr.count ?? 0 };
  }

  const [hwCheck, hwDraft, plans, msgs] = await Promise.all([homeworkToCheck(inst, me), supabaseAdmin.from("homework").select("id, title").eq("institution_id", inst).eq("given_by", me).eq("status", "Draft").limit(50), supabaseAdmin.from("lesson_plans").select("id, topic, status, progress, section_id, week_of").eq("institution_id", inst).eq("teacher_id", me).limit(500), unreadParentMessages(inst, me, secs.classTeacherOf)]);
  const draftHw = (check(hwDraft) ?? []) as { id: string; title: string }[];
  const planRows = (check(plans) ?? []) as { id: string; topic: string; status: string; progress: number; section_id: string; week_of: string }[];
  const toSubmit = planRows.filter((p) => p.status === "Draft" || p.status === "Returned");
  const pendingSubs = subList.filter((s) => s.status === "Pending");
  const syllabusSec = ctId ?? secs.ids[0] ?? null;
  const syl = planRows.filter((p) => p.section_id === syllabusSec);
  const syllabus = syl.length ? Math.round(syl.reduce((a, p) => a + p.progress, 0) / syl.length) : null;

  const tasks: { key: string; tone: "alert" | "sub" | "msg" | "hw" | "eval" | "marks" | "plan" | "draft"; title: string; detail: string; action: string; go: string }[] = [];
  if (register && !register.marked && dn <= 6) tasks.push({ key: "attendance", tone: "alert", title: `Mark today's attendance for ${register.section}`, detail: "Your class register is open until you mark it", action: "Mark now", go: "/teacher/attendance/daily-attendance" });
  if (pendingSubs.length) tasks.push({ key: "subs", tone: "sub", title: `Accept ${pendingSubs.length} substitution${pendingSubs.length > 1 ? "s" : ""}`, detail: `${pendingSubs.map((s) => periods.find((p) => p.id === s.period_id)?.label ?? "").filter(Boolean).join(", ")} · ${[...new Set(pendingSubs.map((s) => secLabel(smap.get(s.section_id) ?? null)))].join(", ")} · ${today}`, action: "Review", go: "dialog:substitutions" });
  if (msgs.count) tasks.push({ key: "messages", tone: "msg", title: `${msgs.count} unread parent message${msgs.count > 1 ? "s" : ""}`, detail: "Reply within one working day", action: "Open inbox", go: "/teacher/communication/parent-messages" });
  if (hwCheck.count) tasks.push({ key: "homework", tone: "hw", title: `${hwCheck.count} homework submission${hwCheck.count > 1 ? "s" : ""} to check`, detail: "Submitted or late", action: "Check", go: "/teacher/homework/submissions?tab=submitted" });
  if (toSubmit.length) tasks.push({ key: "plans", tone: "plan", title: `${toSubmit.length} lesson plan${toSubmit.length > 1 ? "s" : ""} to submit`, detail: toSubmit.some((p) => p.status === "Returned") ? "Some were returned for changes" : "Still in draft", action: "Open", go: "/teacher/subjects/lesson-planning" });
  if (draftHw.length) tasks.push({ key: "draft", tone: "draft", title: `${draftHw.length} homework draft${draftHw.length > 1 ? "s" : ""} not published`, detail: "Students can't see drafts", action: "Publish", go: "/teacher/homework/homework-management?tab=publish" });

  const hour = Number(new Date().toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }));
  return {
    teacher: who, today, weekday: new Date(`${today}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "long", timeZone: "UTC" }), greeting: hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening",
    classes, class_count: taught.filter((c) => !c.substitution).length, substitution_count: taught.filter((c) => c.substitution).length,
    register, homework_to_check: hwCheck.count, parent_unread: msgs.count, syllabus: syllabus === null ? null : { percent: syllabus, label: smap.get(syllabusSec ?? "") ? secLabel(smap.get(syllabusSec ?? "") ?? null) : "" }, tasks,
  };
}

async function homeworkToCheck(inst: string, me: string) {
  const hw = (check(await supabaseAdmin.from("homework").select("id").eq("institution_id", inst).eq("given_by", me).neq("status", "Draft").limit(500)) ?? []) as { id: string }[];
  if (!hw.length) return { count: 0 };
  const r = await supabaseAdmin.from("hw_submissions").select("id", { count: "exact", head: true }).eq("institution_id", inst).in("homework_id", hw.map((x) => x.id)).in("status", ["Submitted", "Late"]);
  return { count: r.count ?? 0 };
}

export async function unreadParentMessages(inst: string, me: string, classSectionIds: string[]) {
  const mine = await supabaseAdmin.from("parent_messages").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("direction", "in").eq("kind", "message").eq("status", "Delivered").eq("to_teacher_id", me);
  let more = 0;
  if (classSectionIds.length) {
    const stu = (check(await supabaseAdmin.from("student_enrollments").select("student_id").in("section_id", classSectionIds).eq("status", "Active").limit(5000)) ?? []) as { student_id: string }[];
    if (stu.length) more = (await supabaseAdmin.from("parent_messages").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("direction", "in").eq("kind", "message").eq("status", "Delivered").is("to_teacher_id", null).in("student_id", stu.map((x) => x.student_id))).count ?? 0;
  }
  return { count: (mine.count ?? 0) + more };
}

/** Substitutions asked of this teacher that are waiting for an answer. */
export async function mySubstitutions(inst: string, me: string) {
  const rows = check(await supabaseAdmin.from("substitutions").select("id, sub_date, status, section_id, period_id, absent:absent_teacher_id(first_name, last_name), subjects:subject_id(name), tt_periods:period_id(label, starts, ends)").eq("institution_id", inst).eq("substitute_id", me).gte("sub_date", istDate()).order("sub_date").limit(100)) as unknown as { id: string; sub_date: string; status: string; section_id: string; absent: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null; subjects: { name: string } | { name: string }[] | null; tt_periods: { label: string; starts: string; ends: string } | { label: string; starts: string; ends: string }[] | null }[];
  const smap = await sectionMap(inst, [...new Set(rows.map((r) => r.section_id))]);
  return { items: rows.map((r) => ({ id: r.id, date: r.sub_date, status: r.status, section: secLabel(smap.get(r.section_id) ?? null), subject: one(r.subjects)?.name ?? "", period: one(r.tt_periods)?.label ?? "", starts: one(r.tt_periods)?.starts.slice(0, 5) ?? "", ends: one(r.tt_periods)?.ends.slice(0, 5) ?? "", covering_for: nameOf(one(r.absent)) })) };
}

export async function acceptSubstitution(inst: string, me: string, id: string) {
  const r = check(await supabaseAdmin.from("substitutions").update({ status: "Assigned" }).eq("id", id).eq("institution_id", inst).eq("substitute_id", me).eq("status", "Pending").select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "That substitution is not waiting for you.");
  return { ok: true };
}

// ═════════════ notifications ═════════════
interface Note { key: string; type: string; title: string; detail: string; at: string; read: boolean; go: string | null }

/** What the portal has told this teacher recently, worked out from live data; read marks are kept per person. */
export async function notifications(inst: string, me: string) {
  const since = new Date(Date.now() - 7 * 86400000);
  const sinceDay = istDate(since);
  const [subs, leaves, plans, tickets, reads, secs, who] = await Promise.all([
    supabaseAdmin.from("substitutions").select("id, sub_date, created_at, section_id, status, subjects:subject_id(name)").eq("institution_id", inst).eq("substitute_id", me).gte("created_at", since.toISOString()).limit(50),
    supabaseAdmin.from("leave_requests").select("id, leave_type, from_date, status, decided_at").eq("institution_id", inst).eq("profile_id", me).in("status", ["Approved", "Rejected"]).gte("decided_at", since.toISOString()).limit(20),
    supabaseAdmin.from("lesson_plans").select("id, topic, week_of, section_id, created_at").eq("institution_id", inst).eq("teacher_id", me).eq("status", "Returned").limit(20),
    supabaseAdmin.from("hd_tickets").select("id, code, subject, status, created_at").eq("institution_id", inst).eq("created_by", me).eq("status", "Waiting on you").limit(20),
    supabaseAdmin.from("staff_notification_reads").select("key").eq("profile_id", me).limit(5000),
    mySections(inst, me),
    whoAmI(inst, me),
  ]);
  const readSet = new Set(((check(reads) ?? []) as { key: string }[]).map((r) => r.key));
  const subRows = (check(subs) ?? []) as unknown as { id: string; sub_date: string; created_at: string; section_id: string; subjects: { name: string } | { name: string }[] | null }[];
  const planRows = (check(plans) ?? []) as { id: string; topic: string; week_of: string; section_id: string; created_at: string }[];
  const smap = await sectionMap(inst, [...new Set([...subRows.map((s) => s.section_id), ...planRows.map((p) => p.section_id), ...secs.classTeacherOf])]);
  const out: Note[] = [];
  const add = (n: Omit<Note, "read">) => out.push({ ...n, read: readSet.has(n.key) });
  for (const s of subRows) add({ key: `sub:${s.id}`, type: "Substitution", title: "Substitution assigned", detail: `${s.sub_date === istDate() ? "Today" : s.sub_date} · ${secLabel(smap.get(s.section_id) ?? null)}${one(s.subjects)?.name ? ` ${one(s.subjects)?.name}` : ""}`, at: s.created_at, go: "dialog:substitutions" });
  for (const l of (check(leaves) ?? []) as { id: string; leave_type: string; from_date: string; status: string; decided_at: string }[]) add({ key: `leave:${l.id}`, type: "Leave", title: `Leave ${l.status.toLowerCase()}`, detail: `${l.leave_type} leave from ${l.from_date}`, at: l.decided_at, go: "/teacher/leave/leave-application?tab=history" });
  for (const p of planRows) add({ key: `plan:${p.id}`, type: "Lesson plan", title: "Lesson plan returned", detail: `${secLabel(smap.get(p.section_id) ?? null)} · ${p.topic}`, at: p.created_at, go: "/teacher/subjects/lesson-planning" });
  for (const t of (check(tickets) ?? []) as { id: string; code: string; subject: string; created_at: string }[]) add({ key: `hd:${t.id}`, type: "Help desk", title: `${t.code} is waiting on you`, detail: t.subject, at: t.created_at, go: "/teacher/dashboard/help-desk?tab=my-requests" });
  // the class register, until it is marked
  if (secs.classTeacherOf[0] && new Date(`${istDate()}T00:00:00Z`).getUTCDay() !== 0) {
    const rec = await supabaseAdmin.from("attendance_records").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("section_id", secs.classTeacherOf[0]).eq("att_date", istDate());
    if (!rec.count) add({ key: `att:${secs.classTeacherOf[0]}:${istDate()}`, type: "Attendance", title: `${secLabel(smap.get(secs.classTeacherOf[0]) ?? null)} attendance not marked`, detail: "The register is open until you mark it", at: new Date().toISOString(), go: "/teacher/attendance/daily-attendance" });
  }
  const msgs = await unreadParentMessages(inst, me, secs.classTeacherOf);
  if (msgs.count) add({ key: `pm:${istDate()}:${msgs.count}`, type: "Parent message", title: `${msgs.count} unread parent message${msgs.count > 1 ? "s" : ""}`, detail: "Reply within one working day", at: new Date().toISOString(), go: "/teacher/communication/parent-messages" });
  void sinceDay; void who;
  out.sort((a, b) => (a.at < b.at ? 1 : -1));
  const today = istDate();
  return {
    items: out.map((n) => ({ ...n, when: n.at.slice(0, 10) === today ? `Today ${hm(n.at)}` : `${new Date(n.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: TZ })} ${hm(n.at)}` })),
    total: out.length, unread: out.filter((n) => !n.read).length, today: out.filter((n) => n.at.slice(0, 10) === today).length, parent_unread: msgs.count,
  };
}

export async function markNotificationsRead(inst: string, me: string, input: unknown) {
  const { keys } = z.object({ keys: z.array(z.string().max(120)).max(200).optional() }).strict().parse(input);
  const list = keys?.length ? keys : (await notifications(inst, me)).items.map((n) => n.key);
  if (!list.length) return { ok: true };
  check(await supabaseAdmin.from("staff_notification_reads").upsert(list.map((key) => ({ profile_id: me, key })), { onConflict: "profile_id,key" }).select("key"));
  return { ok: true };
}

// ═════════════ check-in ═════════════
const haversine = (la1: number, lo1: number, la2: number, lo2: number) => {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
};

async function myCampus(inst: string, me: string) {
  const p = check(await supabaseAdmin.from("user_profiles").select("campus_id").eq("id", me).eq("institution_id", inst).maybeSingle()) as { campus_id: string | null } | null;
  let q = supabaseAdmin.from("campuses").select("id, name, latitude, longitude, geofence_m").eq("institution_id", inst);
  q = p?.campus_id ? q.eq("id", p.campus_id) : q.order("is_main", { ascending: false }).limit(1);
  const c = one(check(await q) as unknown as { id: string; name: string; latitude: number | null; longitude: number | null; geofence_m: number }[]);
  return c;
}

export async function checkinState(inst: string, me: string) {
  const today = istDate();
  const from = istDate(new Date(Date.now() - 20 * 86400000));
  const [campus, week, late, geo] = await Promise.all([
    myCampus(inst, me),
    supabaseAdmin.from("staff_attendance").select("att_date, status, in_time, out_time, source").eq("institution_id", inst).eq("staff_id", me).gte("att_date", from).order("att_date", { ascending: false }).limit(31),
    supabaseAdmin.from("att_settings").select("late_after").eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("geo_checkins").select("at, geo_status, resolution, place, distance_m").eq("institution_id", inst).eq("staff_id", me).gte("at", `${today}T00:00:00+05:30`).order("at", { ascending: false }).limit(1),
  ]);
  const lateAfter = ((check(late) as { late_after: string } | null)?.late_after ?? "08:15").slice(0, 5);
  const rows = (check(week) ?? []) as { att_date: string; status: string; in_time: string | null; out_time: string | null; source: string }[];
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const items = rows.map((r) => {
    const inT = r.in_time?.slice(0, 5) ?? null;
    const lateBy = inT && r.status === "P" ? Math.max(0, mins(inT) - mins(lateAfter)) : 0;
    return { date: r.att_date, in: inT, out: r.out_time?.slice(0, 5) ?? null, method: r.source, status: r.status === "A" ? "Absent" : r.status === "V" || r.status === "L" ? "On leave" : r.status === "H" ? "Half day" : lateBy > 0 ? `Late (${lateBy} min)` : "On time", late: lateBy > 0 };
  });
  const t = rows.find((r) => r.att_date === today) ?? null;
  const g = one((check(geo) ?? []) as { at: string; geo_status: string; resolution: string | null; place: string; distance_m: number | null }[]);
  return {
    campus: campus ? { name: campus.name, geofence_m: campus.geofence_m, location_set: campus.latitude !== null && campus.longitude !== null } : null,
    today: { checked_in: !!t?.in_time, in: t?.in_time?.slice(0, 5) ?? null, out: t?.out_time?.slice(0, 5) ?? null, waiting_for_review: !!g && g.geo_status === "Outside" && !g.resolution && !t?.in_time, last_distance_m: g?.distance_m ?? null },
    late_after: lateAfter, items,
  };
}

/** Where the phone is, compared with the campus: used by the Check In page before the teacher taps check in. */
export async function locate(inst: string, me: string, input: unknown) {
  const i = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy_m: z.number().min(0).max(100000).optional() }).strict().parse(input);
  const campus = await myCampus(inst, me);
  if (!campus) return { campus: null, located: false, inside: true, distance_m: null as number | null };
  const located = campus.latitude !== null && campus.longitude !== null;
  const distance = located ? haversine(Number(campus.latitude), Number(campus.longitude), i.lat, i.lng) : null;
  return { campus: campus.name, located, inside: !located || (distance !== null && distance <= campus.geofence_m + Math.min(50, i.accuracy_m ?? 0)), distance_m: distance, accuracy_m: i.accuracy_m ?? null };
}

export async function checkin(inst: string, me: string, input: unknown) {
  const i = z.object({ action: z.enum(["in", "out"]), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), accuracy_m: z.number().min(0).max(100000).optional(), selfie: z.boolean().optional() }).strict().parse(input);
  const today = istDate();
  const nowIso = new Date().toISOString();
  const cur = check(await supabaseAdmin.from("staff_attendance").select("in_time, out_time, status").eq("staff_id", me).eq("institution_id", inst).eq("att_date", today).maybeSingle()) as { in_time: string | null; out_time: string | null; status: string } | null;
  if (i.action === "out") {
    if (!cur?.in_time) throw new HttpError(409, "Check in first.");
    if (cur.out_time) throw new HttpError(409, "You have already checked out today.");
    check(await supabaseAdmin.from("staff_attendance").update({ out_time: hm(nowIso) }).eq("staff_id", me).eq("institution_id", inst).eq("att_date", today).select("id"));
    return { ok: true, message: `Checked out at ${hm(nowIso)}.` };
  }
  if (cur?.in_time) throw new HttpError(409, `You checked in at ${cur.in_time.slice(0, 5)}.`);
  if (i.lat === undefined || i.lng === undefined) throw new HttpError(400, "Allow your location so the school can see you are on campus.");
  if (!i.selfie) throw new HttpError(400, "Take a quick selfie to check in.");
  const campus = await myCampus(inst, me);
  const located = !!campus && campus.latitude !== null && campus.longitude !== null;
  const distance = located ? haversine(Number(campus!.latitude), Number(campus!.longitude), i.lat, i.lng) : null;
  const inside = !located || (distance !== null && distance <= campus!.geofence_m + Math.min(50, i.accuracy_m ?? 0));
  const place = campus?.name ?? "School";
  check(await supabaseAdmin.from("geo_checkins").insert({ institution_id: inst, staff_id: me, method: "Mobile app", place, distance_m: distance, geo_status: inside ? "Inside" : "Outside", selfie: "Matched" }).select("id"));
  if (!inside) return { ok: false, outside: true, message: `You are about ${distance} m from ${place}. Your check-in has gone to the School Admin to review.` };
  check(await supabaseAdmin.from("staff_attendance").upsert({ institution_id: inst, staff_id: me, att_date: today, status: "P", in_time: hm(nowIso), source: "Mobile app" }, { onConflict: "staff_id,att_date" }).select("id"));
  return { ok: true, message: `Checked in at ${hm(nowIso)}.` };
}

// ═════════════ event duties ═════════════
export async function myDuties(inst: string, me: string) {
  const rows = check(await supabaseAdmin.from("event_duties").select("id, duty, time_label, response, event_mgmt:event_id(title, event_date)").eq("institution_id", inst).eq("staff_id", me).limit(200)) as unknown as { id: string; duty: string; time_label: string; response: string; event_mgmt: { title: string; event_date: string } | { title: string; event_date: string }[] | null }[];
  const items = rows.map((r) => { const e = one(r.event_mgmt); return { id: r.id, event: e?.title ?? "", date: e?.event_date ?? "", venue: "", duty: r.duty, time: r.time_label, response: r.response }; }).filter((r) => r.date >= istDate(new Date(Date.now() - 30 * 86400000))).sort((a, b) => (a.date < b.date ? -1 : 1));
  return { items };
}

export async function respondToDuty(inst: string, me: string, id: string, input: unknown) {
  const { response } = z.object({ response: z.enum(["Accepted", "Declined"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("event_duties").update({ response, responded_at: new Date().toISOString() }).eq("id", id).eq("institution_id", inst).eq("staff_id", me).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Duty not found.");
  return { ok: true };
}

// ═════════════ help desk ═════════════
export async function helpCategories(inst: string) {
  const rows = (await categories(inst)).filter((c) => c.raised_by === "Staff");
  return { items: rows.map((c) => ({ name: c.name, handled_by: c.handled_by, reply_hours: c.reply_hours })) };
}

export async function raiseTicket(inst: string, me: string, input: unknown, kind: "Teacher" | "Staff" = "Teacher") {
  const i = z.object({ category: z.string().trim().min(1).max(80), subject: z.string().trim().min(3, "Write the subject.").max(250), details: z.string().trim().min(3, "Tell us what happened.").max(4000), priority: z.enum(["High", "Normal", "Low"]).default("Normal"), attachment_name: z.string().trim().max(160).optional() }).strict().parse(input);
  const cat = (await categories(inst)).find((c) => c.name === i.category && c.raised_by === "Staff");
  if (!cat) throw new HttpError(400, "Choose one of the listed topics.");
  const who = await whoAmI(inst, me);
  const row = check(await supabaseAdmin.from("hd_tickets").insert({ institution_id: inst, subject: i.subject, category: i.category, raised_by_name: who.name, raised_by_kind: kind, priority: i.priority, assigned_name: cat.handled_by, created_by: me, details: i.details, attachment_name: i.attachment_name || null }).select("id, code").single()) as { id: string; code: string };
  return { id: row.id, code: row.code, handled_by: cat.handled_by, reply_hours: cat.reply_hours };
}

export async function myTickets(inst: string, me: string) {
  const [t, cats] = await Promise.all([
    supabaseAdmin.from("hd_tickets").select("id, code, subject, category, priority, assigned_name, status, rating, details, attachment_name, first_reply_at, resolved_at, created_at").eq("institution_id", inst).eq("created_by", me).order("created_at", { ascending: false }).limit(200),
    categories(inst),
  ]);
  const hours = new Map(cats.map((c) => [c.name, c.reply_hours]));
  const now = Date.now();
  const items = ((check(t) ?? []) as { id: string; code: string; subject: string; category: string; priority: string; assigned_name: string | null; status: string; rating: number | null; details: string | null; attachment_name: string | null; first_reply_at: string | null; resolved_at: string | null; created_at: string }[]).map((x) => {
    const h = hours.get(x.category) ?? 24;
    const due = Date.parse(x.created_at) + h * 3600000;
    let reply = "";
    if (x.status === "Resolved") reply = "Resolved";
    else if (x.status === "Waiting on you") reply = "Paused";
    else if (!x.first_reply_at) reply = now > due ? `Overdue ${Math.max(1, Math.round((now - due) / 3600000))} h` : `Reply in ${Math.max(1, Math.round((due - now) / 3600000))} h`;
    else reply = "Replied";
    return { ...x, reply_time: reply, overdue: reply.startsWith("Overdue"), reply_hours: h };
  });
  const n = (s: string) => items.filter((x) => x.status === s).length;
  return { items, counts: { open: n("Open"), in_progress: n("In progress"), waiting: n("Waiting on you"), resolved: n("Resolved") } };
}

export async function rateTicket(inst: string, me: string, id: string, input: unknown) {
  const { rating } = z.object({ rating: z.number().int().min(1).max(5) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hd_tickets").update({ rating }).eq("id", id).eq("institution_id", inst).eq("created_by", me).eq("status", "Resolved").select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Only a resolved request of yours can be rated.");
  return { ok: true };
}

// ═════════════ school calendar ═════════════
/** Who an entry is for: everyone, staff, teachers, or a class this teacher teaches. */
export function visibleToTeacher(audience: string, classes: string[]) {
  const a = audience.trim().toLowerCase();
  if (!a || a === "everyone" || a === "all") return true;
  if (/(staff|teacher|faculty)/.test(a)) return true;
  if (/(parent|student)/.test(a) && !/class|grade/.test(a)) return false;
  const m = a.match(/(?:class|grade)\s*(\d+|[a-z]+)/g);
  if (m) return m.some((x) => classes.some((c) => c.toLowerCase() === x.replace(/^grade/, "class").replace(/\s+/g, " ").trim() || c.toLowerCase().startsWith(x.replace(/^grade/, "class").replace(/\s+/g, " ").trim() + " ")));
  return true;
}

export async function calendar(inst: string, me: string, from: string, to: string) {
  isoDay.parse(from); isoDay.parse(to);
  if (to < from || Date.parse(to) - Date.parse(from) > 400 * 86400000) throw new HttpError(400, "Choose a shorter range.");
  const [e, secs] = await Promise.all([
    supabaseAdmin.from("calendar_events").select("id, title, event_date, end_date, kind, audience, note").eq("institution_id", inst).eq("published", true).lte("event_date", to).order("event_date").limit(2000),
    mySections(inst, me),
  ]);
  const smap = await sectionMap(inst, secs.ids);
  const classes = [...new Set([...smap.values()].map((s) => secLabel(s)))];
  const classOnly = [...new Set(classes.map((c) => c.split(" ").slice(0, 2).join(" ")))];
  const items = ((check(e) ?? []) as { id: string; title: string; event_date: string; end_date: string | null; kind: string; audience: string; note: string | null }[])
    .filter((x) => (x.end_date ?? x.event_date) >= from && visibleToTeacher(x.audience, [...classes, ...classOnly]));
  return { items };
}

// ═════════════ search your students ═════════════
export async function searchMyStudents(inst: string, me: string, raw: unknown) {
  const q = safeSearch(raw);
  if (q.length < 2) return { hits: [] };
  const secs = await mySections(inst, me);
  if (!secs.ids.length) return { hits: [] };
  const like = `%${q}%`;
  const enr = (check(await supabaseAdmin.from("student_enrollments").select("student_id, section_id").in("section_id", secs.ids).eq("status", "Active").limit(5000)) ?? []) as { student_id: string; section_id: string }[];
  if (!enr.length) return { hits: [] };
  const stu = (check(await supabaseAdmin.from("students").select("id, registration_no, first_name, last_name").eq("institution_id", inst).in("id", enr.map((x) => x.student_id)).or(`first_name.ilike.${like},last_name.ilike.${like},registration_no.ilike.${like}`).limit(8)) ?? []) as { id: string; registration_no: string | null; first_name: string | null; last_name: string | null }[];
  const smap = await sectionMap(inst, secs.ids);
  const sec = new Map(enr.map((x) => [x.student_id, x.section_id]));
  return { hits: stu.map((s) => ({ id: s.id, section_id: sec.get(s.id) ?? "", title: [s.first_name, s.last_name].filter(Boolean).join(" ") || s.registration_no || "Student", subtitle: [secLabel(smap.get(sec.get(s.id) ?? "") ?? null), s.registration_no ? `Admission no. ${s.registration_no}` : ""].filter(Boolean).join(" · ") })) };
}
