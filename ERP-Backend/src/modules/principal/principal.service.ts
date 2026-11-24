import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { advance } from "../school/front-office.service";
import { decideConcession, feeSettings, payments, yearStart } from "../school/fees.service";
import { everyone } from "../school/fees2.service";
import { decideExpense } from "../school/fees3.service";
import { decideLeaveStep, increments, leaveApprovals } from "../school/hr3.service";
import { claims, moveClaim } from "../school/fees4.service";
import { moveVacancy } from "../school/hr4.service";
import { decideCircular } from "../school/comm.service";
import { updateLessonPlan } from "../school/academic2.service";
import { publishCards } from "../school/results.service";
import { overview as admissionsOverview } from "../admissions/admissions.service";

/**
 * The Principal portal: the decision layer over the school's own records. It reads what the other portals write
 * (attendance, fees, admissions, academics, leave, circulars) and its decisions are written onto those same records
 * through the services the other portals use, so nothing is kept twice. Every function takes the school and the
 * signed-in person from the server session, never from the request.
 */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const nameOf = (p: { first_name?: string | null; last_name?: string | null } | null) => (p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : "");
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const has = (mods: string[], ...need: string[]) => need.some((m) => mods.includes(m));

interface Year { id: string; name: string; start_date: string; end_date: string }
async function currentYear(inst: string, id?: string): Promise<Year | null> {
  const ys = check(await supabaseAdmin.from("academic_years").select("id, name, start_date, end_date, is_current").eq("institution_id", inst).order("start_date", { ascending: false })) as (Year & { is_current: boolean })[];
  return ys.find((y) => y.id === id) ?? ys.find((y) => y.is_current) ?? ys[0] ?? null;
}
export async function years(inst: string) {
  return check(await supabaseAdmin.from("academic_years").select("id, name, is_current").eq("institution_id", inst).order("start_date", { ascending: false })) as { id: string; name: string; is_current: boolean }[];
}

// ═════════════ who is signed in, and the counts on the sidebar and the bell ═════════════
export async function me(inst: string, profile: string, mods: string[]) {
  const [p, a, n] = await Promise.all([
    supabaseAdmin.from("user_profiles").select("first_name, last_name, designation").eq("id", profile).eq("institution_id", inst).maybeSingle(),
    approvals(inst, profile, mods),
    notifications(inst, profile, mods),
  ]);
  const who = check(p) as { first_name: string; last_name: string; designation: string | null } | null;
  return { name: nameOf(who), line: who?.designation || "Principal", badges: { approvals: a.total, unread: n.total } };
}

// ═════════════ attendance of the day ═════════════
async function sectionsOf(inst: string, year: Year | null) {
  const [g, s] = await Promise.all([
    supabaseAdmin.from("grades").select("id, name, sort_order").eq("institution_id", inst).eq("is_active", true).order("sort_order"),
    year ? supabaseAdmin.from("sections").select("id, name, grade_id, class_teacher_id").eq("institution_id", inst).eq("academic_year_id", year.id) : Promise.resolve({ data: [], error: null }),
  ]);
  return { grades: check(g) as { id: string; name: string; sort_order: number }[], sections: check(s) as { id: string; name: string; grade_id: string; class_teacher_id: string | null }[] };
}
interface Rec { student_id: string; section_id: string | null; att_date: string; status: string }
const PRESENT = ["P", "L", "H"];

async function attendanceDay(inst: string, year: Year | null, day: string) {
  const { grades, sections } = await sectionsOf(inst, year);
  const rec = check(await supabaseAdmin.from("attendance_records").select("student_id, section_id, att_date, status").eq("institution_id", inst).eq("att_date", day).limit(30000)) as Rec[];
  const secGrade = new Map(sections.map((s) => [s.id, s.grade_id]));
  const by = new Map<string, { present: number; total: number }>();
  for (const r of rec) { const g = r.section_id ? secGrade.get(r.section_id) : undefined; if (!g || r.status === "V") continue; const x = by.get(g) ?? { present: 0, total: 0 }; x.total++; if (PRESENT.includes(r.status)) x.present++; by.set(g, x); }
  const marked = new Set(rec.map((r) => r.section_id).filter(Boolean) as string[]);
  const present = rec.filter((r) => PRESENT.includes(r.status)).length;
  return {
    byClass: grades.map((g) => ({ label: g.name, pct: by.get(g.id) ? pct(by.get(g.id)!.present, by.get(g.id)!.total) : null })),
    present, absent: rec.filter((r) => r.status === "A").length, late: rec.filter((r) => r.status === "L").length, recorded: rec.length,
    notMarked: sections.filter((s) => !marked.has(s.id)).map((s) => `${grades.find((g) => g.id === s.grade_id)?.name ?? ""} ${s.name}`.trim()),
    grades, sections,
  };
}

/** Students absent for three or more of their latest school days in a row, with a parent's mobile to call. */
async function longAbsent(inst: string) {
  const from = new Date(Date.now() - 14 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const rec = check(await supabaseAdmin.from("attendance_records").select("student_id, section_id, att_date, status").eq("institution_id", inst).gte("att_date", from).order("att_date", { ascending: false }).limit(30000)) as Rec[];
  const byKid = new Map<string, Rec[]>();
  for (const r of rec) { if (r.status === "V" || r.status === "H") continue; const l = byKid.get(r.student_id) ?? []; l.push(r); byKid.set(r.student_id, l); }
  const out: { id: string; days: number; section: string | null }[] = [];
  for (const [id, l] of byKid) { let n = 0; for (const r of l) { if (r.status === "A") n++; else break; } if (n >= 3) out.push({ id, days: n, section: l[0].section_id }); }
  out.sort((a, b) => b.days - a.days);
  const top = out.slice(0, 30);
  if (!top.length) return [];
  const ids = top.map((x) => x.id);
  const [st, secs, gl] = await Promise.all([
    supabaseAdmin.from("students").select("id, first_name, last_name").eq("institution_id", inst).in("id", ids),
    supabaseAdmin.from("sections").select("id, name, grades:grade_id(name)").eq("institution_id", inst).in("id", top.map((x) => x.section).filter(Boolean) as string[]),
    supabaseAdmin.from("student_guardians").select("student_id, relation, guardians:guardian_id!inner(institution_id, full_name, phone)").eq("guardians.institution_id", inst).in("student_id", ids),
  ]);
  const S = new Map((check(st) as { id: string; first_name: string; last_name: string }[]).map((s) => [s.id, s]));
  const SEC = new Map((check(secs) as unknown as { id: string; name: string; grades: { name: string } | { name: string }[] | null }[]).map((s) => [s.id, `${one(s.grades)?.name ?? ""} ${s.name}`.trim()]));
  const G = check(gl) as unknown as { student_id: string; relation: string; guardians: { full_name: string; phone: string } | { full_name: string; phone: string }[] | null }[];
  return top.map((x) => { const kin = G.filter((g) => g.student_id === x.id); const f = kin.find((g) => g.relation === "Father") ?? kin[0]; const g = one(f?.guardians ?? null); const s = S.get(x.id); return { id: x.id, name: s ? nameOf(s) : "Student", class_label: x.section ? SEC.get(x.section) ?? "" : "", days: x.days, parent: g?.full_name ?? "", mobile: g?.phone ?? "" }; });
}

// ═════════════ the dashboard, one tab at a time ═════════════
export async function overview(inst: string, profile: string, mods: string[], tab: string, yearId?: string) {
  const year = await currentYear(inst, yearId);
  const base = { years: await years(inst), year: year ? { id: year.id, name: year.name } : null };
  if (tab === "attendance") {
    if (!has(mods, "attendance")) return { ...base, off: "Attendance" };
    const d = await attendanceDay(inst, year, today());
    return { ...base, today: today(), recorded: d.recorded > 0, tiles: { present: d.present, absent: d.absent, late: d.late, total: d.recorded, not_marked: d.notMarked }, by_class: d.byClass, long_absent: await longAbsent(inst) };
  }
  if (tab === "fees") {
    if (!has(mods, "fees")) return { ...base, off: "Fees" };
    return { ...base, ...(await feesTab(inst)) };
  }
  if (tab === "admissions") {
    if (!has(mods, "admissions", "online_admissions")) return { ...base, off: "Admissions" };
    return { ...base, ...(await admissionsTab(inst)) };
  }
  return { ...base, ...(await statisticsTab(inst, profile, mods, year)) };
}

async function statisticsTab(inst: string, profile: string, mods: string[], year: Year | null) {
  const now = today();
  const [enrol, staff, staffAtt, leaveToday, ap] = await Promise.all([
    year ? supabaseAdmin.from("student_enrollments").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("academic_year_id", year.id).not("status", "in", "(Left,Transferred)") : Promise.resolve({ count: 0 }),
    supabaseAdmin.from("user_profiles").select("id, roles:role_id!inner(name)").eq("institution_id", inst).not("roles.name", "in", "(Parent,Student,Applicant)").limit(5000),
    supabaseAdmin.from("staff_attendance").select("staff_id, status").eq("institution_id", inst).eq("att_date", now).limit(5000),
    supabaseAdmin.from("leave_requests").select("profile_id").eq("institution_id", inst).eq("status", "Approved").lte("from_date", now).gte("to_date", now).limit(2000),
    approvals(inst, profile, mods),
  ]);
  const students = (enrol as { count: number | null }).count ?? 0;
  const att = has(mods, "attendance") ? await attendanceDay(inst, year, now) : null;
  const staffTotal = (check(staff) as unknown[]).length;
  const staffPresent = (check(staffAtt) as { status: string }[]).filter((s) => PRESENT.includes(s.status)).length;
  const onLeave = (check(leaveToday) as unknown[]).length;

  let fees: { collected: number; annual: number } | null = null;
  if (has(mods, "fees")) { const f = await feesNumbers(inst); fees = { collected: f.collected, annual: f.annual }; }
  let syllabus: { pct: number } | null = null;
  const ch = check(await supabaseAdmin.from("curriculum_chapters").select("periods, status").eq("institution_id", inst).limit(20000)) as { periods: number; status: string }[];
  if (ch.length) { const all = ch.reduce((n, c) => n + c.periods, 0); syllabus = { pct: Math.round((ch.filter((c) => c.status === "Completed").reduce((n, c) => n + c.periods, 0) / Math.max(1, all)) * 100) }; }
  let adm: { admitted: number; in_progress: number } | null = null;
  if (has(mods, "admissions", "online_admissions")) { const o = await admissionsOverview(inst); adm = { admitted: o.tiles.admitted.total, in_progress: o.steps.filter((s) => s.n >= 3 && s.n <= 10).reduce((n, s) => n + s.count, 0) }; }

  // average marks by class from the latest exam that has marks
  const perf = has(mods, "exams") ? await classPerformance(inst, year) : { exam: "", rows: [] as { label: string; pct: number }[] };
  const watch = await watchList(inst, mods, year, att);
  return {
    today: now,
    tiles: {
      students: { total: students, present: att?.present ?? null, pct: att && att.recorded ? pct(att.present, att.recorded) : null },
      staff: { total: staffTotal, present: staffPresent, on_leave: onLeave },
      fees: fees ? { collected: fees.collected, annual: fees.annual, pct: Math.round(pct(fees.collected, fees.annual)) } : null,
      syllabus, admissions: adm,
    },
    waiting: ap.kinds.filter((k) => k.count > 0), waiting_total: ap.total,
    attendance_by_class: att?.byClass ?? [], class_performance: perf, watch,
  };
}

async function classPerformance(inst: string, year: Year | null) {
  const ex = check(await supabaseAdmin.from("exams").select("id, name, ends_on, exam_types:exam_type_id(max_marks)").eq("institution_id", inst).order("ends_on", { ascending: false }).limit(8)) as unknown as { id: string; name: string; exam_types: { max_marks: number } | { max_marks: number }[] | null }[];
  for (const e of ex) {
    const marks = check(await supabaseAdmin.from("exam_marks").select("student_id, marks, absent").eq("institution_id", inst).eq("exam_id", e.id).eq("absent", false).not("marks", "is", null).limit(30000)) as { student_id: string; marks: number }[];
    if (!marks.length || !year) continue;
    const enr = check(await supabaseAdmin.from("student_enrollments").select("student_id, grades:grade_id(name, sort_order)").eq("institution_id", inst).eq("academic_year_id", year.id).limit(20000)) as unknown as { student_id: string; grades: { name: string; sort_order: number } | { name: string; sort_order: number }[] | null }[];
    const grade = new Map(enr.map((x) => [x.student_id, one(x.grades)]));
    const max = one(e.exam_types)?.max_marks ?? 100;
    const acc = new Map<string, { sum: number; n: number; order: number }>();
    for (const m of marks) { const g = grade.get(m.student_id); if (!g) continue; const a = acc.get(g.name) ?? { sum: 0, n: 0, order: g.sort_order }; a.sum += (Number(m.marks) / max) * 100; a.n++; acc.set(g.name, a); }
    return { exam: e.name, rows: [...acc.entries()].sort((a, b) => a[1].order - b[1].order).map(([label, a]) => ({ label, pct: Math.round(a.sum / a.n) })) };
  }
  return { exam: "", rows: [] as { label: string; pct: number }[] };
}

async function watchList(inst: string, mods: string[], year: Year | null, att: Awaited<ReturnType<typeof attendanceDay>> | null) {
  const items: { key: string; tone: "bad" | "warn" | "info"; mark: string; title: string; note: string; href: string }[] = [];
  if (att && year) {
    const from = new Date(Date.now() - 6 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const rec = check(await supabaseAdmin.from("attendance_records").select("section_id, status").eq("institution_id", inst).gte("att_date", from).limit(60000)) as { section_id: string | null; status: string }[];
    const by = new Map<string, { p: number; t: number }>();
    for (const r of rec) { if (!r.section_id || r.status === "V") continue; const x = by.get(r.section_id) ?? { p: 0, t: 0 }; x.t++; if (PRESENT.includes(r.status)) x.p++; by.set(r.section_id, x); }
    const low = att.sections.filter((s) => by.get(s.id) && pct(by.get(s.id)!.p, by.get(s.id)!.t) < 88);
    if (low.length) {
      const teachers = check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name").eq("institution_id", inst).in("id", low.map((s) => s.class_teacher_id).filter(Boolean) as string[])) as { id: string; first_name: string; last_name: string }[];
      for (const s of low.slice(0, 3)) items.push({ key: `att-${s.id}`, tone: "bad", mark: "!", title: `${att.grades.find((g) => g.id === s.grade_id)?.name ?? ""} ${s.name} attendance below 88% this week`.trim(), note: `Class teacher: ${nameOf(teachers.find((t) => t.id === s.class_teacher_id) ?? null) || "not assigned"}`, href: "/principal/attendance/student-attendance" });
    }
  }
  if (has(mods, "academics")) {
    const lp = check(await supabaseAdmin.from("lesson_plans").select("id, subjects:subject_id(name)").eq("institution_id", inst).eq("status", "Returned").limit(500)) as unknown as { id: string; subjects: { name: string } | { name: string }[] | null }[];
    if (lp.length) items.push({ key: "plans", tone: "warn", mark: "!", title: `${lp.length} lesson plan${lp.length === 1 ? "" : "s"} returned for rework`, note: [...new Set(lp.map((x) => one(x.subjects)?.name).filter(Boolean))].slice(0, 3).join(", "), href: "/principal/academics/academic-overview" });
  }
  if (has(mods, "fees")) {
    const f = await everyone(inst);
    if (f.agg.overdue > 0) items.push({ key: "fees", tone: "warn", mark: "₹", title: `${lakh(f.agg.overdue)} fees overdue`, note: `${f.agg.overdue_students} student${f.agg.overdue_students === 1 ? "" : "s"}`, href: "/principal/fees" });
  }
  const c = await concerns(inst);
  if (c.items.length) items.push({ key: "concerns", tone: "info", mark: "P", title: `${c.items.length} parent concern${c.items.length === 1 ? "" : "s"} waiting`, note: "Open or in progress", href: "/principal/communication/parent-concerns" });
  return items;
}
const lakh = (n: number) => (n >= 10_000_000 ? `₹${(n / 10_000_000).toFixed(2).replace(/\.?0+$/, "")}Cr` : n >= 100_000 ? `₹${(n / 100_000).toFixed(1).replace(/\.0$/, "")}L` : `₹${n.toLocaleString("en-IN")}`);

// ═════════════ fees ═════════════
async function feesNumbers(inst: string) {
  const ys = await yearStart(inst);
  const [ov, pays] = await Promise.all([everyone(inst), supabaseAdmin.from("fee_payments").select("total, mode").eq("institution_id", inst).eq("status", "Paid").gte("paid_on", ys).limit(100000)]);
  const P = check(pays) as { total: number; mode: string }[];
  return { agg: ov.agg, collected: P.reduce((n, p) => n + p.total, 0), annual: ov.agg.annual, pays: P, ys };
}
const MODE = (m: string) => (m === "Bank" ? "Net banking" : m);
async function feesTab(inst: string) {
  const f = await feesNumbers(inst);
  const [lines, list, set] = await Promise.all([
    supabaseAdmin.from("fee_payment_lines").select("label, amount, fee_payments:payment_id!inner(institution_id, status, paid_on)").eq("fee_payments.institution_id", inst).eq("fee_payments.status", "Paid").gte("fee_payments.paid_on", f.ys).limit(100000),
    payments(inst),
    feeSettings(inst),
  ]);
  const modes = new Map<string, number>(); for (const p of f.pays) modes.set(MODE(p.mode), (modes.get(MODE(p.mode)) ?? 0) + p.total);
  const heads = new Map<string, number>(); for (const l of check(lines) as unknown as { label: string; amount: number }[]) heads.set(l.label, (heads.get(l.label) ?? 0) + l.amount);
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([label, total]) => ({ label, total }));
  const due = (set as { due_dates?: unknown }).due_dates;
  return {
    tiles: { annual: f.annual, students: f.agg.students, collected: f.collected, collected_pct: Math.round(pct(f.collected, f.annual)), pending: f.agg.pending, owe_now: f.agg.owe_now, overdue: f.agg.overdue, overdue_students: f.agg.overdue_students },
    by_mode: sorted(modes), by_head: sorted(heads).slice(0, 8), has_due_dates: Array.isArray(due),
    payments: list.items.slice(0, 200).map((p) => ({ id: p.id, receipt_no: p.receipt_no, student: p.student, class_label: p.class_label, fee: p.fee, total: p.total, mode: MODE(p.mode), collected_at: p.collected_at, paid_on: p.paid_on, status: p.status })),
  };
}

// ═════════════ admissions ═════════════
const OK_STATUS = ["Approved", "Fee paid", "Registered", "Allocated"];
async function admissionsTab(inst: string) {
  const [o, apps] = await Promise.all([
    admissionsOverview(inst),
    supabaseAdmin.from("adm_applications").select("id, code, child, class_sought, parent_name, mobile, source, applied_on, status, level, enquiry_id").eq("institution_id", inst).order("applied_on", { ascending: false }).limit(2000),
  ]);
  const A = check(apps) as { id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; source: string; applied_on: string; status: string; level: number }[];
  const approved = A.filter((a) => OK_STATUS.includes(a.status)).length;
  return {
    year: o.year,
    tiles: { enquiries: o.tiles.enquiries.total, applications: A.length, approved, rejected: A.filter((a) => a.status === "Rejected").length, admitted: o.tiles.admitted.total },
    funnel: o.funnel,
    applications: A.slice(0, 300).map((a) => ({ id: a.id, code: a.code, child: a.child, class_sought: a.class_sought, parent_name: a.parent_name, mobile: a.mobile, source: a.source, applied_on: a.applied_on, status: a.status === "Under review" ? `Level ${a.level} review` : a.status })),
  };
}

// ═════════════ the approval centre ═════════════
export type Kind = "admissions" | "leave" | "concession" | "results" | "increment" | "claim" | "circular" | "lesson" | "expense" | "vacancy";
const KINDS: { key: Kind; label: string; needs?: string[] }[] = [
  { key: "admissions", label: "Admissions", needs: ["admissions", "online_admissions"] },
  { key: "leave", label: "Staff leave", needs: ["hr_payroll"] },
  { key: "concession", label: "Fee concessions", needs: ["fees"] },
  { key: "results", label: "Results", needs: ["exams"] },
  { key: "increment", label: "Increments", needs: ["hr_payroll"] },
  { key: "claim", label: "Claims", needs: ["fees"] },
  { key: "circular", label: "Circulars", needs: ["sms_whatsapp", "email", "notifications", "whatsapp", "school_diary", "helpdesk", "surveys", "photo_gallery", "chat", "ai_chatbot"] },
  { key: "lesson", label: "Lesson plans", needs: ["academics", "student_information"] },
  { key: "expense", label: "Expenses", needs: ["fees"] },
  { key: "vacancy", label: "Vacancies", needs: ["hr_payroll"] },
];
interface Act { key: string; label: string; tone: "good" | "bad" | "plain" }
export interface Item { kind: Kind; id: string; title: string; sub: string; when: string | null; detail: [string, string][]; actions: Act[] }
const A = (key: string, label: string, tone: Act["tone"]): Act => ({ key, label, tone });
const inr = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;
const dmy = (d: string | null) => (d ? new Date(d.length > 10 ? d : d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: d.length > 10 ? "Asia/Kolkata" : "UTC" }) : "—");

async function loadItems(inst: string, profile: string, mods: string[], only?: Kind): Promise<Item[]> {
  const on = (k: Kind) => (!only || only === k) && has(mods, ...(KINDS.find((x) => x.key === k)!.needs ?? []));
  const out: Item[] = [];
  const jobs: Promise<void>[] = [];

  if (on("admissions")) jobs.push((async () => {
    const r = check(await supabaseAdmin.from("adm_applications").select("id, code, child, class_sought, parent_name, mobile, source, applied_on, level, level_since").eq("institution_id", inst).eq("status", "Under review").eq("level", 3).order("level_since").limit(500)) as { id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; source: string; applied_on: string; level_since: string }[];
    for (const x of r) out.push({ kind: "admissions", id: x.id, title: `${x.child} · ${x.class_sought}`, sub: `${x.code} · parent ${x.parent_name}`, when: x.level_since, detail: [["Application", x.code], ["Child", x.child], ["Class sought", x.class_sought], ["Parent", x.parent_name], ["Mobile", x.mobile ?? "—"], ["Source", x.source], ["Applied on", dmy(x.applied_on)], ["Waiting since", dmy(x.level_since)]], actions: [A("approve", "Approve", "good"), A("send-back", "Send back", "plain"), A("waitlist", "Waitlist", "plain"), A("reject", "Reject", "bad")] });
  })());

  if (on("leave")) jobs.push((async () => {
    const [chain, mine] = await Promise.all([leaveApprovals(inst), supabaseAdmin.from("leave_requests").select("id").eq("institution_id", inst).eq("profile_id", profile).eq("status", "Pending")]);
    const own = new Set((check(mine) as { id: string }[]).map((x) => x.id));
    for (const x of chain.items.filter((i) => !own.has(i.id) && i.level >= 3)) out.push({ kind: "leave", id: x.id, title: `${x.employee} · ${x.leave}`, sub: `${x.detail || "Staff"} · ${x.days} day${x.days === 1 ? "" : "s"} from ${dmy(x.from)}`, when: null, detail: [["Request", x.code], ["Staff member", x.employee], ["Role", x.detail || "—"], ["Leave", x.leave], ["From", dmy(x.from)], ["Days", String(x.days)], ["Route", x.route.join(" → ")], ["Waiting", x.waiting]], actions: [A("approve", "Approve", "good"), A("send_back", "Reject", "bad")] });
  })());

  if (on("concession")) jobs.push((async () => {
    const r = check(await supabaseAdmin.from("fee_concessions").select("id, code, student_id, ctype, reason, amount, requested_on, status, source").eq("institution_id", inst).in("status", ["Pending", "Under review", "Info asked"]).order("requested_on").limit(500)) as { id: string; code: string; student_id: string; ctype: string; reason: string; amount: number; requested_on: string; status: string; source: string }[];
    const ids = [...new Set(r.map((x) => x.student_id))];
    const st = ids.length ? (check(await supabaseAdmin.from("students").select("id, first_name, last_name, registration_no").eq("institution_id", inst).in("id", ids)) as { id: string; first_name: string; last_name: string; registration_no: string }[]) : [];
    const S = new Map(st.map((s) => [s.id, s]));
    for (const x of r) { const s = S.get(x.student_id); out.push({ kind: "concession", id: x.id, title: `${s ? nameOf(s) : "Student"} · ${inr(x.amount)}`, sub: `${x.code} · ${x.ctype}${x.source === "Parent" ? " · asked by parent" : ""}`, when: x.requested_on, detail: [["Request", x.code], ["Student", s ? `${nameOf(s)} (${s.registration_no})` : "—"], ["Type", x.ctype], ["Amount", inr(x.amount)], ["Reason", x.reason || "—"], ["Raised by", x.source === "Parent" ? "Parent" : "Fee office"], ["Requested on", dmy(x.requested_on)], ["Status", x.status]], actions: [A("Approved", "Approve", "good"), A("Info asked", "Ask for info", "plain"), A("Rejected", "Reject", "bad")] }); }
  })());

  if (on("results")) jobs.push((async () => {
    const r = check(await supabaseAdmin.from("report_card_runs").select("exam_id, section_id, generated_at, exams:exam_id(name), sections:section_id(name, grades:grade_id(name))").eq("institution_id", inst).eq("status", "Generated").order("generated_at").limit(500)) as unknown as { exam_id: string; section_id: string; generated_at: string; exams: { name: string } | { name: string }[] | null; sections: { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null }[];
    for (const x of r) { const sec = one(x.sections); const cls = `${one(sec?.grades ?? null)?.name ?? ""} ${sec?.name ?? ""}`.trim(); out.push({ kind: "results", id: `${x.exam_id}:${x.section_id}`, title: `${one(x.exams)?.name ?? "Exam"} · ${cls}`, sub: "Marks verified, report cards ready to publish", when: x.generated_at, detail: [["Exam", one(x.exams)?.name ?? "—"], ["Class", cls], ["Report cards ready since", dmy(x.generated_at)], ["On approval", "Parents get a notice that the report card is ready"]], actions: [A("publish", "Publish results", "good"), A("send_back", "Send back", "plain")] }); }
  })());

  if (on("increment")) jobs.push((async () => {
    const inc = await increments(inst);
    const done = new Set((check(await supabaseAdmin.from("hr_cycle").select("staff_id").eq("institution_id", inst).eq("cycle", inc.cycle).eq("inc_approved", true)) as { staff_id: string }[]).map((x) => x.staff_id));
    for (const x of inc.items.filter((i) => i.sent && !done.has(i.id))) out.push({ kind: "increment", id: x.id, title: `${x.name} · ${x.inc}%`, sub: `${x.band} · cycle ${inc.cycle}`, when: null, detail: [["Teacher", x.name], ["Cycle", inc.cycle], ["KRA score", String(x.kra)], ["Student feedback", String(x.feedback)], ["Competency", String(x.competency)], ["Combined", String(x.combined)], ["Band", x.band], ["Increment", `${x.inc}%`], ["Salary now", inr(x.salary)], ["Salary after", inr(x.new_salary)]], actions: [A("approve", "Approve", "good"), A("reject", "Send back", "plain")] });
  })());

  if (on("claim")) jobs.push((async () => {
    const c = await claims(inst);
    for (const x of c.items.filter((i) => i.staff_id !== profile && ["Submitted", "HOD approved"].includes(i.status) && (i.status === "HOD approved" || i.amount > i.limit || i.approver === "Principal"))) out.push({ kind: "claim", id: x.id, title: `${x.staff} · ${inr(x.amount)}`, sub: `${x.code} · ${x.ctype}`, when: x.claim_on, detail: [["Claim", x.code], ["Staff member", x.staff], ["Department", x.dept || "—"], ["Type", x.ctype], ["Description", x.description || "—"], ["Amount", inr(x.amount)], ["Limit without the Principal", inr(x.limit)], ["Receipts", String(x.receipts)], ["Date", dmy(x.claim_on)]], actions: [A("approve", "Approve", "good"), A("reject", "Reject", "bad")] });
  })());

  if (on("circular")) jobs.push((async () => {
    const r = check(await supabaseAdmin.from("comm_circulars").select("id, code, title, audience, issued_by, circ_date, body").eq("institution_id", inst).eq("status", "Draft").order("circ_date").limit(300)) as { id: string; code: string; title: string; audience: string; issued_by: string; circ_date: string; body: string }[];
    for (const x of r) out.push({ kind: "circular", id: x.id, title: x.title, sub: `${x.code} · for ${x.audience} · by ${x.issued_by}`, when: x.circ_date, detail: [["Circular", x.code], ["Title", x.title], ["For", x.audience], ["Issued by", x.issued_by], ["Date", dmy(x.circ_date)], ["Wording", x.body || "—"]], actions: [A("approve", "Approve and publish", "good"), A("reject", "Reject", "bad")] });
  })());

  if (on("lesson")) jobs.push((async () => {
    const r = check(await supabaseAdmin.from("lesson_plans").select("id, topic, week_of, periods, teacher_id, subjects:subject_id(name), sections:section_id(name, grades:grade_id(name))").eq("institution_id", inst).eq("status", "Submitted").order("week_of").limit(300)) as unknown as { id: string; topic: string; week_of: string; periods: number; teacher_id: string; subjects: { name: string } | { name: string }[] | null; sections: { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null }[];
    const t = r.length ? (check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name").eq("institution_id", inst).in("id", [...new Set(r.map((x) => x.teacher_id))])) as { id: string; first_name: string; last_name: string }[]) : [];
    for (const x of r) { const sec = one(x.sections); const cls = `${one(sec?.grades ?? null)?.name ?? ""} ${sec?.name ?? ""}`.trim(); const tn = nameOf(t.find((y) => y.id === x.teacher_id) ?? null); out.push({ kind: "lesson", id: x.id, title: `${x.topic} · ${one(x.subjects)?.name ?? ""}`, sub: `${cls} · ${tn}`, when: x.week_of, detail: [["Topic", x.topic], ["Subject", one(x.subjects)?.name ?? "—"], ["Class", cls], ["Teacher", tn || "—"], ["Week of", dmy(x.week_of)], ["Periods", String(x.periods)]], actions: [A("Approved", "Approve", "good"), A("Returned", "Return for rework", "plain")] }); }
  })());

  if (on("expense")) jobs.push((async () => {
    const r = check(await supabaseAdmin.from("fee_expenses").select("id, voucher, paid_to, amount, mode, spent_on, cat:category_id(name, approver)").eq("institution_id", inst).eq("status", "Pending").order("spent_on").limit(300)) as unknown as { id: string; voucher: string; paid_to: string; amount: number; mode: string | null; spent_on: string; cat: { name: string; approver: string } | { name: string; approver: string }[] | null }[];
    for (const x of r.filter((y) => one(y.cat)?.approver === "Principal")) out.push({ kind: "expense", id: x.id, title: `${x.paid_to} · ${inr(x.amount)}`, sub: `${x.voucher} · ${one(x.cat)?.name ?? "Expense"}`, when: x.spent_on, detail: [["Voucher", x.voucher], ["Paid to", x.paid_to], ["Category", one(x.cat)?.name ?? "—"], ["Amount", inr(x.amount)], ["Mode", x.mode ?? "—"], ["Spent on", dmy(x.spent_on)]], actions: [A("Approved", "Approve", "good"), A("Rejected", "Reject", "bad")] });
  })());

  if (on("vacancy")) jobs.push((async () => {
    const r = check(await supabaseAdmin.from("hr_vacancies").select("id, code, post, department, vtype, note, posts, cost_year, requested_by, requested_on").eq("institution_id", inst).eq("stage", "Requested").order("requested_on").limit(200)) as { id: string; code: string; post: string; department: string; vtype: string; note: string; posts: number; cost_year: number; requested_by: string; requested_on: string }[];
    for (const x of r) out.push({ kind: "vacancy", id: x.id, title: `${x.post} · ${x.posts} post${x.posts === 1 ? "" : "s"}`, sub: `${x.code} · ${x.vtype}${x.department ? ` · ${x.department}` : ""}`, when: x.requested_on, detail: [["Request", x.code], ["Post", x.post], ["Department", x.department || "—"], ["Type", x.vtype], ["Posts", String(x.posts)], ["Yearly cost", inr(x.cost_year)], ["Requested by", x.requested_by || "—"], ["Reason", x.note || "—"]], actions: [A("approve", "Approve", "good"), A("reject", "Reject", "bad")] });
  })());

  await Promise.all(jobs);
  return out;
}

export async function approvals(inst: string, profile: string, mods: string[], only?: string) {
  const kind = KINDS.find((k) => k.key === only)?.key;
  const items = await loadItems(inst, profile, mods, kind);
  const kinds = KINDS.filter((k) => has(mods, ...(k.needs ?? []))).map((k) => ({ key: k.key, label: k.label, count: items.filter((i) => i.kind === k.key).length }));
  const summary = kind === "increment" && has(mods, "hr_payroll") ? await increments(inst).then((x) => ({ cycle: x.cycle, teachers: x.items.length, cost: x.cost, budget: x.budget, over: x.over, budget_pct: x.budget_pct })) : null;
  return { kinds, items, total: items.length, summary };
}

const KIND_KEYS = KINDS.map((k) => k.key) as [Kind, ...Kind[]];
const BODY = z.object({ action: z.string().trim().min(1).max(20), note: z.string().trim().max(300).optional() }).strict();

/** Records the Principal's decision on the record it belongs to (through the service that record's own portal uses), then logs it. */
export async function decide(inst: string, profile: string, role: string, mods: string[], kindRaw: string, id: string, input: unknown) {
  const kind = z.enum(KIND_KEYS).parse(kindRaw);
  const { action, note } = BODY.parse(input);
  if (!has(mods, ...(KINDS.find((k) => k.key === kind)!.needs ?? []))) throw new HttpError(403, "That is not part of your school's plan.");
  const pending = (await loadItems(inst, profile, mods, kind)).find((i) => i.id === id);
  if (!pending) throw new HttpError(409, "That was already decided, or it is not waiting for you.");
  if (!pending.actions.some((a) => a.key === action)) throw new HttpError(400, "That action is not available.");
  switch (kind) {
    case "admissions": await advance(inst, id, { action }, role); break;
    case "leave": await decideLeaveStep(inst, id, { action }, role, profile); break;
    case "concession": await decideConcession(inst, id, { status: action }); break;
    case "results": { const [exam_id, section_id] = id.split(":"); if (action === "publish") await publishCards(inst, { exam_id, section_id }, profile); else check(await supabaseAdmin.from("report_card_runs").delete().eq("exam_id", exam_id).eq("section_id", section_id).eq("institution_id", inst).eq("status", "Generated").select("section_id")); break; }
    case "increment": { const cy = (await increments(inst)).cycle; check(await supabaseAdmin.from("hr_cycle").update(action === "approve" ? { inc_approved: true, inc_decided_at: new Date().toISOString() } : { inc_sent: false }).eq("institution_id", inst).eq("staff_id", id).eq("cycle", cy).select("staff_id")); break; }
    case "claim": await moveClaim(inst, id, { action }, role, profile); break;
    case "circular": await decideCircular(inst, id, { action }); break;
    case "lesson": await updateLessonPlan(inst, id, { status: action }); break;
    case "expense": await decideExpense(inst, id, { status: action }, role); break;
    case "vacancy": await moveVacancy(inst, id, { action }, role); break;
  }
  const who = check(await supabaseAdmin.from("user_profiles").select("first_name, last_name").eq("id", profile).eq("institution_id", inst).maybeSingle()) as { first_name: string; last_name: string } | null;
  check(await supabaseAdmin.from("principal_decisions").insert({ institution_id: inst, kind, ref_id: id, title: pending.title.slice(0, 200), action, note: note ?? null, decided_by: profile, decided_name: nameOf(who) }).select("id"));
  return { ok: true };
}

export async function decided(inst: string) {
  return { items: check(await supabaseAdmin.from("principal_decisions").select("id, kind, title, action, note, decided_name, decided_at").eq("institution_id", inst).order("decided_at", { ascending: false }).limit(200)) as { id: string; kind: string; title: string; action: string; note: string | null; decided_name: string; decided_at: string }[], kinds: Object.fromEntries(KINDS.map((k) => [k.key, k.label])) };
}

// ═════════════ parent concerns ═════════════
/** Complaints and parents' help-desk tickets still open, oldest first. */
export async function concerns(inst: string) {
  const [c, t] = await Promise.all([
    supabaseAdmin.from("fo_complaints").select("id, code, raised_by, about, details, raised_on, status").eq("institution_id", inst).neq("status", "Resolved").order("raised_on").limit(300),
    supabaseAdmin.from("hd_tickets").select("id, code, subject, category, raised_by_name, priority, status, created_at").eq("institution_id", inst).eq("raised_by_kind", "Parent").neq("status", "Resolved").order("created_at").limit(300),
  ]);
  const items = [
    ...(check(c) as { id: string; code: string; raised_by: string; about: string; details: string; raised_on: string; status: string }[]).map((x) => ({ source: "complaint" as const, id: x.id, code: x.code, title: x.about, from: x.raised_by, details: x.details, since: x.raised_on, status: x.status, priority: "Normal" })),
    ...(check(t) as { id: string; code: string; subject: string; category: string; raised_by_name: string; priority: string; status: string; created_at: string }[]).map((x) => ({ source: "ticket" as const, id: x.id, code: x.code, title: x.subject, from: x.raised_by_name, details: x.category, since: x.created_at.slice(0, 10), status: x.status, priority: x.priority })),
  ].sort((a, b) => a.since.localeCompare(b.since));
  return { items };
}
export async function setConcern(inst: string, profile: string, source: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["In progress", "Resolved"]) }).strict().parse(input);
  const src = z.enum(["complaint", "ticket"]).parse(source);
  const patch = status === "Resolved" ? (src === "complaint" ? { status, resolved_at: new Date().toISOString() } : { status, resolved_at: new Date().toISOString() }) : { status };
  const r = check(await supabaseAdmin.from(src === "complaint" ? "fo_complaints" : "hd_tickets").update(patch).eq("id", id).eq("institution_id", inst).neq("status", "Resolved").select("id")) as unknown[];
  if (!r.length) throw new HttpError(409, "That concern is already resolved, or was not found.");
  const who = check(await supabaseAdmin.from("user_profiles").select("first_name, last_name").eq("id", profile).eq("institution_id", inst).maybeSingle()) as { first_name: string; last_name: string } | null;
  check(await supabaseAdmin.from("principal_decisions").insert({ institution_id: inst, kind: "concern", ref_id: id, title: `Parent concern ${status === "Resolved" ? "resolved" : "taken up"}`, action: status === "Resolved" ? "resolved" : "in-progress", decided_by: profile, decided_name: nameOf(who) }).select("id"));
  return { ok: true };
}

// ═════════════ the bell ═════════════
export async function notifications(inst: string, profile: string, mods: string[]) {
  const [a, c] = await Promise.all([approvals(inst, profile, mods), concerns(inst)]);
  const href: Record<string, string> = { admissions: "/principal/approvals/approval-centre?tab=admissions", leave: "/principal/approvals/approval-centre?tab=leave", results: "/principal/approvals/approval-centre?tab=results", circular: "/principal/communication/circulars?tab=approve" };
  const items: { key: string; tone: "warn"; title: string; href: string; count: number }[] = a.kinds.filter((k) => k.count > 0).map((k) => ({ key: k.key as string, tone: "warn" as const, title: `${k.count} ${k.label.toLowerCase()} waiting for your decision`, href: href[k.key] ?? "/principal/approvals/approval-centre?tab=admissions", count: k.count }));
  if (c.items.length) items.push({ key: "concerns", tone: "warn", title: `${c.items.length} parent concern${c.items.length === 1 ? "" : "s"} open`, href: "/principal/communication/parent-concerns", count: c.items.length });
  // a notice is unread until it is opened; when the number changes it is a new notice
  const seen = new Set((check(await supabaseAdmin.from("staff_notification_reads").select("key").eq("profile_id", profile).limit(5000)) as { key: string }[]).map((x) => x.key));
  const list = items.map((i) => ({ key: `${i.key}:${i.count}`, tone: i.tone, title: i.title, href: i.href, read: seen.has(`${i.key}:${i.count}`) }));
  return { items: list, total: list.filter((i) => !i.read).length };
}

// ═════════════ subjects by class (read-only view of the academic set-up) ═════════════

/** Marks notices as read: the ones named, or every notice there is now. */
export async function markNotificationsRead(inst: string, profile: string, mods: string[], input: unknown) {
  const { keys } = z.object({ keys: z.array(z.string().max(120)).max(100).optional() }).strict().parse(input ?? {});
  const list = keys ?? (await notifications(inst, profile, mods)).items.map((i) => i.key);
  if (list.length) check(await supabaseAdmin.from("staff_notification_reads").upsert(list.map((key) => ({ profile_id: profile, key })), { onConflict: "profile_id,key" }).select("key"));
  return { ok: true };
}
