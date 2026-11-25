import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { assertHrMayChange } from "../school/protected-staff";
import { directory } from "../school/hr.service";
import { candidates, flow, offers, openings, maskPan } from "../school/hr2.service";
import { leaveApprovals } from "../school/hr3.service";
import { compliance, exits, vacancies } from "../school/hr4.service";
import { payStatus } from "../school/pay.service";
import { settings as paySettings } from "../school/pay2.service";
import { claims } from "../school/fees4.service";

/**
 * The HR portal's own reads: the dashboard, notifications, hiring pipeline, the signed-in person's employment record,
 * and the queue of qualifications and documents staff sent in from their own portals. Everything else in the portal is
 * the School Admin's HR and Payroll services, so both work on the same records.
 */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const PRESENT = ["P", "L", "H"];

export const has = (mods: string[], ...codes: string[]) => codes.some((c) => mods.includes(c));
const PAYROLL = ["payroll", "hr_payroll"];

// ═════════════ what is waiting for HR ═════════════
interface Waiting { key: string; count: number; tone: "warn" | "info"; mark: string; title: string; detail: string; action: string; href: string }

async function waiting(inst: string, mods: string[]) {
  const staffing = has(mods, "hr_payroll");
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [dir, leave, ex, syncs, queue] = await Promise.all([
    directory(inst),
    staffing ? leaveApprovals(inst) : Promise.resolve(null),
    staffing ? exits(inst) : Promise.resolve(null),
    supabaseAdmin.from("bio_syncs").select("id, synced_at, device:device_id(code)").eq("institution_id", inst).eq("status", "Failed").gte("synced_at", weekAgo).order("synced_at", { ascending: false }).limit(200),
    staffing ? verificationQueue(inst) : Promise.resolve(null),
  ]);
  const salaries = check(await supabaseAdmin.from("hr_staff").select("profile_id, monthly_salary").eq("institution_id", inst).limit(5000)) as { profile_id: string; monthly_salary: number | null }[];
  const paid = new Set(salaries.filter((s) => (s.monthly_salary ?? 0) > 0).map((s) => s.profile_id));
  const unpaid = dir.items.filter((s) => s.status === "Active" && !paid.has(s.id));
  const failed = check(syncs) as unknown as { id: string; synced_at: string; device: { code: string } | { code: string }[] | null }[];
  const resigned = (ex?.items ?? []).filter((x) => x.status === "Pending");
  const month = today().slice(0, 7);
  const items: Waiting[] = [];
  if (leave?.items.length) items.push({ key: "leave", count: leave.items.length, tone: "warn", mark: "L", title: "Leave requests", detail: `${leave.items.length} to approve before payroll`, action: "Review", href: "/hr/leave/leave-management?tab=approvals" });
  if (unpaid.length && has(mods, ...PAYROLL)) items.push({ key: "salary", count: unpaid.length, tone: "warn", mark: "E", title: unpaid.length === 1 ? "New joiner without salary structure" : "Staff without salary structure", detail: "Assign department, designation and salary", action: "Assign", href: "/hr/organisation/salary-structure" });
  if (failed.length) items.push({ key: "biometric", count: failed.length, tone: "info", mark: "!", title: "Biometric sync failures", detail: `${one(failed[0].device)?.code ?? "Device"} · re-sync before payroll`, action: "View", href: "/hr/attendance/biometric" });
  if (resigned.length) items.push({ key: "exit", count: resigned.length, tone: "info", mark: "R", title: resigned.length === 1 ? "Resignation" : "Resignations", detail: "Exit approval and final settlement", action: "View", href: "/hr/records/staff-exit?tab=exit-approval" });
  if (queue && queue.total) items.push({ key: "verify", count: queue.total, tone: "info", mark: "V", title: "Qualifications and documents to verify", detail: "Sent in by staff from their portals", action: "Verify", href: "/hr/records/verification" });
  return { items, dir, leave: leave?.items.length ?? 0, month };
}

async function payDate(inst: string, month: string) {
  const s = await paySettings(inst);
  if (!/last/i.test(s.paid_on)) return s.paid_on;
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0));
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1); // Sundays are off
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// ═════════════ dashboard overview ═════════════
export async function overview(inst: string, mods: string[]) {
  const now = today(); const month = now.slice(0, 7);
  const payroll = has(mods, ...PAYROLL);
  const [w, att, leaveToday, steps, status, date] = await Promise.all([
    waiting(inst, mods),
    supabaseAdmin.from("staff_attendance").select("staff_id, status, source").eq("institution_id", inst).eq("att_date", now).limit(5000),
    supabaseAdmin.from("leave_requests").select("profile_id").eq("institution_id", inst).eq("status", "Approved").lte("from_date", now).gte("to_date", now).limit(5000),
    flow(inst),
    payroll ? payStatus(inst) : Promise.resolve("Draft"),
    payroll ? payDate(inst, month) : Promise.resolve(""),
  ]);
  const staff = w.dir.items; const ids = new Set(staff.map((s) => s.id));
  const A = (check(att) as { staff_id: string; status: string; source: string }[]).filter((x) => ids.has(x.staff_id));
  const away = new Set((check(leaveToday) as { profile_id: string }[]).map((x) => x.profile_id).filter((id) => ids.has(id)));
  const present = A.filter((x) => PRESENT.includes(x.status)).length;
  const absent = A.filter((x) => x.status === "A" && !away.has(x.staff_id)).length;
  const sources = [...new Set(A.map((x) => x.source.toLowerCase()))];
  const dept = new Map<string, number>();
  for (const s of staff) dept.set(s.department || "Not assigned", (dept.get(s.department || "Not assigned") ?? 0) + 1);
  return {
    date: now, month, month_label: monthLabel(month),
    employees: staff.length, teaching: staff.filter((s) => s.type === "Teaching").length, non_teaching: staff.filter((s) => s.type !== "Teaching").length,
    attendance_marked: A.length, present, present_pct: A.length ? Math.round((present / A.length) * 100) : 0, attendance_source: sources.length === 1 ? sources[0] : "",
    on_leave: away.size, absent, leave_waiting: w.leave,
    payroll_status: status, pay_date: date, steps: steps.steps,
    waiting: w.items,
    headcount: [...dept.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8),
  };
}

// ═════════════ notifications ═════════════
export async function notifications(inst: string, profile: string, mods: string[]) {
  const payroll = has(mods, ...PAYROLL); const staffing = has(mods, "hr_payroll"); const month = today().slice(0, 7);
  const [w, status, due] = await Promise.all([waiting(inst, mods), payroll ? payStatus(inst) : Promise.resolve(""), staffing ? compliance(inst) : Promise.resolve(null)]);
  const list = w.items.map((i) => ({ key: `hr-${i.key}:${i.count}`, mark: i.mark, tone: i.tone as "warn" | "info" | "bad", title: i.key === "leave" ? `${plural(i.count, "leave request")} to approve` : `${i.count} · ${i.title}`, detail: i.detail, href: i.href }));
  const pay: Record<string, [string, string, string]> = {
    Draft: ["Payroll not calculated yet", "Calculate salary and deductions", "/hr/payroll/payroll-processing?tab=generate-payroll"],
    Calculated: ["Payroll waiting for HR verification", "Check the amounts and verify", "/hr/payroll-approval/payroll-approval?tab=hr-verification"],
    Verified: ["Payroll waiting for Finance approval", "The finance officer approves it in Fee & Finance", "/hr/payroll-approval/payroll-approval?tab=finance-approval"],
    Approved: ["Payroll approved by Finance", "Generate payslips", "/hr/payslips/payslips?tab=generate"],
  };
  if (pay[status]) list.push({ key: `hr-pay:${month}:${status}`, mark: "₹", tone: "info", title: `${monthLabel(month)}: ${pay[status][0]}`, detail: pay[status][1], href: pay[status][2] });
  if (due && due.soon + due.overdue > 0) list.push({ key: `hr-compliance:${due.soon}:${due.overdue}`, mark: "!", tone: due.overdue ? "bad" : "warn", title: due.overdue ? `${plural(due.overdue, "statutory item")} overdue` : `${plural(due.soon, "statutory item")} due in 14 days`, detail: "See the Compliance Calendar", href: "/hr/dashboard/hr-dashboard?tab=compliance-calendar" });
  const seen = new Set((check(await supabaseAdmin.from("staff_notification_reads").select("key").eq("profile_id", profile).limit(5000)) as { key: string }[]).map((x) => x.key));
  const items = list.map((i) => ({ ...i, read: seen.has(i.key) }));
  return { items, total: items.filter((i) => !i.read).length };
}
export async function markNotificationsRead(inst: string, profile: string, mods: string[], input: unknown) {
  const { keys } = z.object({ keys: z.array(z.string().max(120)).max(100).optional() }).strict().parse(input ?? {});
  const list = keys ?? (await notifications(inst, profile, mods)).items.map((i) => i.key);
  if (list.length) check(await supabaseAdmin.from("staff_notification_reads").upsert(list.map((key) => ({ profile_id: profile, key })), { onConflict: "profile_id,key" }).select("key"));
  return { ok: true };
}

// ═════════════ the signed-in person ═════════════
export async function me(inst: string, profile: string, mods: string[]) {
  const [p, n, leave] = await Promise.all([
    supabaseAdmin.from("user_profiles").select("first_name, last_name, designation").eq("id", profile).eq("institution_id", inst).maybeSingle(),
    notifications(inst, profile, mods),
    has(mods, "hr_payroll") ? leaveApprovals(inst) : Promise.resolve(null),
  ]);
  const who = check(p) as { first_name: string; last_name: string; designation: string | null } | null;
  if (!who) throw new HttpError(404, "Profile not found.");
  return { name: `${who.first_name} ${who.last_name}`.trim(), first_name: who.first_name, line: who.designation || "HR Manager", badges: { leave: leave?.items.length ?? 0, unread: n.total } };
}

/** My own employment, pay and statutory record. The bank account is shown by its last four digits only. */
export async function employment(inst: string, profile: string) {
  const dir = await directory(inst);
  const s = dir.items.find((x) => x.id === profile);
  if (!s) throw new HttpError(404, "Profile not found.");
  const [h, pr, dep, campus] = await Promise.all([
    supabaseAdmin.from("hr_staff").select("bank_name, bank_account, pan, uan, esi_no").eq("profile_id", profile).eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("hr_probation").select("status").eq("staff_id", profile).eq("institution_id", inst).in("status", ["On probation", "Extended"]).limit(1),
    supabaseAdmin.from("hr_departments").select("head:head_id(id, first_name, last_name, designation)").eq("institution_id", inst).eq("name", s.department).maybeSingle(),
    supabaseAdmin.from("user_profiles").select("campuses:campus_id(name)").eq("id", profile).eq("institution_id", inst).maybeSingle(),
  ]);
  const x = check(h) as { bank_name: string | null; bank_account: string | null; pan: string | null; uan: string | null; esi_no: string | null } | null;
  type Head = { id: string; first_name: string; last_name: string; designation: string | null };
  const head = one((check(dep) as unknown as { head: Head | Head[] | null } | null)?.head ?? null);
  const c = check(campus) as unknown as { campuses: { name: string } | { name: string }[] | null } | null;
  return {
    emp_code: s.emp_code, designation: s.designation, department: s.department,
    reports_to: head && head.id !== profile ? `${head.first_name} ${head.last_name}`.trim() + (head.designation ? ` (${head.designation})` : "") : "",
    joined_on: s.joined_on, employment_type: (check(pr) as unknown[]).length ? "On probation" : "",
    campus: one(c?.campuses ?? null)?.name ?? "",
    bank: x?.bank_account ? `${x.bank_name ?? "Bank"} ••${x.bank_account.slice(-4)}` : "",
    pan: maskPan(x?.pan), uan: x?.uan ?? "", esi: x?.esi_no ?? "",
  };
}

// ═════════════ hiring pipeline ═════════════
const REACHED = ["Shortlisted", "Interview scheduled", "Interviewed", "Selected", "Offered", "Accepted"];
const INTERVIEWED = ["Interview scheduled", "Interviewed", "Selected", "Offered", "Accepted"];
const SELECTED = ["Selected", "Offered", "Accepted"];

export async function pipeline(inst: string) {
  const [o, c, f, v] = await Promise.all([openings(inst), candidates(inst), offers(inst), vacancies(inst)]);
  const month = today().slice(0, 7);
  const C = c.items;
  const accepted = f.items.filter((x) => x.status === "Accepted"); const declined = f.items.filter((x) => x.status === "Declined");
  const posted = new Map(o.items.map((x) => [x.id, x.posted_on])); const opening = new Map(C.map((x) => [x.id, x.opening_id]));
  const days = accepted.map((x) => { const p = posted.get(opening.get(x.candidate_id) ?? ""); return p ? Math.max(0, Math.round((Date.parse(x.sent_on) - Date.parse(p)) / 86400000)) : null; }).filter((d): d is number => d !== null);
  const live = o.items.filter((x) => x.status !== "Closed");
  return {
    open_posts: live.length,
    avg_days: days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null,
    acceptance: accepted.length + declined.length ? Math.round((accepted.length / (accepted.length + declined.length)) * 100) : null,
    joining: accepted.filter((x) => x.joining_on.startsWith(month)).length,
    funnel: [
      ["Vacancies approved", v.items.filter((x) => ["Approved", "Posted", "Filled"].includes(x.stage)).reduce((n, x) => n + x.posts, 0)],
      ["Applications", C.length],
      ["Passed screening", C.filter((x) => REACHED.includes(x.stage) || x.rule_pct === 100).length],
      ["Shortlisted", C.filter((x) => REACHED.includes(x.stage)).length],
      ["Demo and interview", C.filter((x) => INTERVIEWED.includes(x.stage) || x.demo_score !== null).length],
      ["Selected", C.filter((x) => SELECTED.includes(x.stage)).length],
      ["Offers accepted", accepted.length],
    ] as [string, number][],
    posts: live.map((x) => { const mine = C.filter((y) => y.opening_id === x.id); return { id: x.id, post: x.position, applied: mine.length, shortlisted: mine.filter((y) => REACHED.includes(y.stage)).length, selected: mine.filter((y) => SELECTED.includes(y.stage)).length, closes_on: x.closes_on }; }),
  };
}

// ═════════════ verification of what staff sent in ═════════════
type Person = { first_name: string; last_name: string; institution_id: string };

export async function verificationQueue(inst: string) {
  const [d, q, dir] = await Promise.all([
    supabaseAdmin.from("hr_documents").select("id, staff_id, title, doc_type, file_name, uploaded_on").eq("institution_id", inst).eq("status", "Pending review").order("uploaded_on", { ascending: false }).limit(1000),
    // qualifications carry no school id: the school is the owner's, so the join filters on it
    supabaseAdmin.from("staff_qualifications").select("id, profile_id, title, institution, year, result, certificate_name, who:profile_id!inner(first_name, last_name, institution_id)").eq("status", "Pending").eq("who.institution_id", inst).order("created_at", { ascending: false }).limit(1000),
    directory(inst),
  ]);
  const name = new Map(dir.items.map((s) => [s.id, s.name]));
  const documents = (check(d) as { id: string; staff_id: string; title: string | null; doc_type: string; file_name: string; uploaded_on: string }[]).map((x) => ({ ...x, staff: name.get(x.staff_id) ?? "" }));
  const qualifications = (check(q) as unknown as { id: string; profile_id: string; title: string; institution: string; year: number; result: string | null; certificate_name: string | null; who: Person | Person[] }[]).map(({ who, ...x }) => ({ ...x, staff: name.get(x.profile_id) ?? `${one(who)?.first_name ?? ""} ${one(who)?.last_name ?? ""}`.trim() }));
  return { documents, qualifications, total: documents.length + qualifications.length };
}

/** Marks a staff member's qualification or document verified. Nobody verifies their own. */
export async function verify(inst: string, actor: string, kind: string, id: string) {
  const k = z.enum(["document", "qualification"]).parse(kind);
  if (k === "document") {
    const d = check(await supabaseAdmin.from("hr_documents").select("id, staff_id").eq("id", id).eq("institution_id", inst).eq("status", "Pending review").maybeSingle()) as { id: string; staff_id: string } | null;
    if (!d) throw new HttpError(404, "Nothing is waiting under that record.");
    if (d.staff_id === actor) throw new HttpError(403, "You cannot verify your own document. Ask the School Admin.");
    await assertHrMayChange("HR", inst, d.staff_id);
    check(await supabaseAdmin.from("hr_documents").update({ status: "Verified" }).eq("id", d.id).eq("institution_id", inst).select("id"));
    return { ok: true };
  }
  const q = check(await supabaseAdmin.from("staff_qualifications").select("id, profile_id").eq("id", id).eq("status", "Pending").maybeSingle()) as { id: string; profile_id: string } | null;
  const owner = q ? (check(await supabaseAdmin.from("user_profiles").select("id").eq("id", q.profile_id).eq("institution_id", inst).maybeSingle()) as { id: string } | null) : null;
  if (!q || !owner) throw new HttpError(404, "Nothing is waiting under that record.");
  if (q.profile_id === actor) throw new HttpError(403, "You cannot verify your own qualification. Ask the School Admin.");
  await assertHrMayChange("HR", inst, q.profile_id);
  check(await supabaseAdmin.from("staff_qualifications").update({ status: "Verified" }).eq("id", q.id).eq("profile_id", owner.id).select("id"));
  return { ok: true };
}

// ═════════════ staff claims (HR sees them; the approvers are unchanged) ═════════════
export async function claimRegister(inst: string) {
  const c = await claims(inst);
  return { items: c.items, waiting: c.waiting, to_pay: c.to_pay, to_pay_amount: c.to_pay_amount, paid_month: c.paid_month };
}
