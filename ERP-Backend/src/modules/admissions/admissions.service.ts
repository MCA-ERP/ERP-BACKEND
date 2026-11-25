import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { convertEnquiry, formFee } from "../school/front-office.service";
import { programmes, seatMatrix, createOffer } from "../school/admission-extra.service";
import { savePlan, studentPlan } from "../school/fees.service";
import { createParentAccount, createStudentAccounts, type Credential } from "../admin/users-mgmt.service";
import { whoAmI } from "../teacher/teacher.service";
import { hideAadhaar } from "../../lib/identity";

/**
 * The Admissions portal. It works on the same adm_* tables as the School Admin Admission module, so a family entered in
 * one portal is in the other. Every function takes the school and the signed-in person from the server session.
 * The pipeline step of a family is worked out from the records (documents, marks, interviews, fee, admission number,
 * enrolment, logins), never typed in, so the two portals can never disagree about where a family is.
 */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const istTime = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const nameOf = (p: { first_name?: string; last_name?: string } | null) => (p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : "");

export const STEPS = ["Enquiry", "Lead", "Application", "Verification", "Test / Interview", "Approval", "Fee assignment", "Registration", "Class allocation", "Portal accounts", "Confirmation"] as const;

// ═════════════ the records, and where each family stands ═════════════
interface Enq { id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; source: string; counsellor: string | null; enquiry_date: string; status: string; interest: string; next_followup: string | null; created_at: string; staff: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }
export interface App { id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; source: string; enquiry_id: string | null; applied_on: string; status: string; level: number; level_since: string; admission_no: string | null; confirmed_at: string | null; created_by: string | null; created_at: string; details: Record<string, string> | null; submitted_at: string | null; verified_at: string | null; fee_status: "Pending" | "Paid" | "Waived"; fee_amount: number | null; fee_mode: string | null; fee_paid_on: string | null; fee_note: string | null; return_reason: string | null }
interface Iv { id: string; application_id: string; status: string; panel_name: string; interview_date: string; interview_time: string | null; score: number | null; recommendation: string | null }
export interface ClassRule { class_name: string; min_age: number; seats: number; needs_assessment: boolean }
export interface Family {
  key: string; kind: "enquiry" | "application"; id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; source: string; counsellor: string;
  /** 1 to 11: the pipeline step the family is at */ step: number; step_label: string; done: boolean;
  status: "Active" | "Admitted" | "Waitlisted" | "Returned" | "Rejected" | "Lost"; level: number; admission_no: string | null; student_id: string | null; since: string;
}

const CLASSES = ["Nursery", "LKG", "UKG", ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)];
/** "Class 11 · Science" is Class 11. */
export const classOf = (cls: string) => CLASSES.find((c) => cls === c || cls.startsWith(c + " ")) ?? cls;

/** Age rules and whether each class needs a test or interaction. Seeded from the admission programmes the first time, then kept per class. */
export async function classRules(inst: string): Promise<ClassRule[]> {
  const cols = "class_name, min_age, seats, needs_assessment";
  let rows = check(await supabaseAdmin.from("adm_class_rules").select(cols).eq("institution_id", inst)) as ClassRule[];
  if (!rows.length) {
    const list = await programmes(inst);
    const seed = CLASSES.flatMap((c, i) => { const p = list.find((x) => x.classes.split(",").map((s) => s.trim()).includes(c)); return p ? [{ institution_id: inst, class_name: c, min_age: p.min_age, seats: Math.max(1, Math.round(p.seats_total / p.classes.split(",").length)), needs_assessment: true, sort_order: i + 1 }] : []; });
    if (seed.length) rows = check(await supabaseAdmin.from("adm_class_rules").upsert(seed, { onConflict: "institution_id,class_name" }).select(cols)) as ClassRule[];
  }
  return rows.sort((a, b) => CLASSES.indexOf(a.class_name) - CLASSES.indexOf(b.class_name));
}

/** The age of a child on 31 March of the admission year, against the minimum age. Within a month short is "Borderline". */
export function eligibility(dob: string | undefined, minAge: number) {
  if (!dob) return { state: "No date of birth" as const, age: null as number | null };
  const b = new Date(dob + "T00:00:00Z"); const now = new Date();
  const ref = new Date(Date.UTC(now.getMonth() >= 5 ? now.getFullYear() + 1 : now.getFullYear(), 2, 31));
  let months = (ref.getUTCFullYear() - b.getUTCFullYear()) * 12 + (ref.getUTCMonth() - b.getUTCMonth());
  if (ref.getUTCDate() < b.getUTCDate()) months--;
  return { state: (months >= minAge * 12 ? "Eligible" : months >= minAge * 12 - 1 ? "Borderline" : "Not eligible") as "Eligible" | "Borderline" | "Not eligible", age: Math.floor(months / 12) };
}

export async function load(inst: string) {
  const [e, a, d, m, iv, rules] = await Promise.all([
    supabaseAdmin.from("adm_enquiries").select("id, code, child, class_sought, parent_name, mobile, source, counsellor, enquiry_date, status, interest, next_followup, created_at, staff:counsellor(first_name, last_name)").eq("institution_id", inst).limit(5000),
    supabaseAdmin.from("adm_applications").select("id, code, child, class_sought, parent_name, mobile, source, enquiry_id, applied_on, status, level, level_since, admission_no, confirmed_at, created_by, created_at, details, submitted_at, verified_at, fee_status, fee_amount, fee_mode, fee_paid_on, fee_note, return_reason").eq("institution_id", inst).limit(5000),
    supabaseAdmin.from("adm_documents").select("application_id, status, doc_type").eq("institution_id", inst).limit(20000),
    supabaseAdmin.from("adm_test_marks").select("application_id, adm_tests!inner(institution_id)").eq("adm_tests.institution_id", inst).limit(20000),
    supabaseAdmin.from("adm_interviews").select("id, application_id, status, panel_name, interview_date, interview_time, score, recommendation").eq("institution_id", inst).limit(20000),
    classRules(inst),
  ]);
  const enquiries = check(e) as unknown as Enq[];
  const apps = (check(a) as unknown as App[]).map((x) => ({ ...x, details: hideAadhaar(x.details) }));
  const docs = new Map<string, string[]>();
  for (const x of check(d) as { application_id: string; status: string }[]) docs.set(x.application_id, [...(docs.get(x.application_id) ?? []), x.status]);
  const assessed = new Set((check(m) as { application_id: string }[]).map((x) => x.application_id));
  const interviews = check(iv) as unknown as Iv[];
  for (const x of interviews) if (x.status === "Completed") assessed.add(x.application_id);
  const docTypes = new Map<string, Set<string>>();
  for (const x of check(d) as { application_id: string; doc_type: string }[]) docTypes.set(x.application_id, (docTypes.get(x.application_id) ?? new Set()).add(x.doc_type));

  // students made at class allocation, and whether their sign-ins exist
  const nos = apps.filter((x) => x.admission_no && x.status === "Allocated").map((x) => x.admission_no as string);
  const students = nos.length ? (check(await supabaseAdmin.from("students").select("id, registration_no, user_profile_id").eq("institution_id", inst).in("registration_no", nos).limit(5000)) as { id: string; registration_no: string; user_profile_id: string | null }[]) : [];
  const stuByNo = new Map(students.map((s) => [s.registration_no, s]));
  const links = students.length ? (check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, is_primary_contact, guardians:guardian_id(id, full_name, phone, user_profile_id)").in("student_id", students.map((s) => s.id))) as unknown as { student_id: string; is_primary_contact: boolean; guardians: { id: string; full_name: string; phone: string; user_profile_id: string | null } | { id: string; full_name: string; phone: string; user_profile_id: string | null }[] | null }[]) : [];
  const guardianOf = new Map<string, { id: string; full_name: string; phone: string; user_profile_id: string | null }>();
  for (const l of links.sort((x, y) => Number(x.is_primary_contact) - Number(y.is_primary_contact))) { const g = one(l.guardians); if (g) guardianOf.set(l.student_id, g); }

  const ids = [...new Set([...apps.map((x) => x.created_by), ...enquiries.map((x) => x.counsellor)].filter((x): x is string => !!x))];
  const people = ids.length ? (check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name").eq("institution_id", inst).in("id", ids)) as { id: string; first_name: string; last_name: string }[]) : [];
  const who = new Map(people.map((p) => [p.id, nameOf(p)]));
  const enqById = new Map(enquiries.map((x) => [x.id, x]));

  const families: Family[] = [];
  for (const x of enquiries) {
    if (x.status === "Converted" && apps.some((p) => p.enquiry_id === x.id)) continue;
    const lost = x.status === "Closed";
    const n = x.status === "New" ? 1 : 2;
    families.push({ key: `e:${x.id}`, kind: "enquiry", id: x.id, code: x.code, child: x.child, class_sought: x.class_sought, parent_name: x.parent_name, mobile: x.mobile, source: x.source, counsellor: nameOf(one(x.staff)) || "—", step: n, step_label: STEPS[n - 1], done: false, status: lost ? "Lost" : "Active", level: 0, admission_no: null, student_id: null, since: x.enquiry_date });
  }
  for (const x of apps) {
    const stu = x.admission_no ? stuByNo.get(x.admission_no) : undefined;
    const g = stu ? guardianOf.get(stu.id) : undefined;
    const portalDone = !!stu?.user_profile_id && !!g?.user_profile_id;
    const st = docs.get(x.id) ?? [];
    const verified = !!x.verified_at || (st.length > 0 && st.every((s) => s === "Verified"));
    const submitted = !!x.submitted_at || verified;
    const needs = rules.find((r) => r.class_name === classOf(x.class_sought))?.needs_assessment ?? true;
    let step: number; let status: Family["status"] = "Active";
    if (x.confirmed_at) { step = 11; status = "Admitted"; }
    else if (x.status === "Allocated") step = portalDone ? 11 : 10;
    else if (x.status === "Registered") step = 9;
    else if (x.status === "Fee paid") step = 8;
    else if (x.status === "Approved") step = 7;
    else if (x.status === "Rejected") { step = 6; status = "Rejected"; }
    else if (x.status === "Waitlisted") { step = 6; status = "Waitlisted"; }
    else if (x.status === "Returned") { step = 4; status = "Returned"; }
    else step = !submitted ? 3 : !verified ? 4 : needs && !assessed.has(x.id) ? 5 : 6;
    const counsellor = (x.enquiry_id ? nameOf(one(enqById.get(x.enquiry_id)?.staff ?? null)) : "") || (x.created_by ? who.get(x.created_by) ?? "" : "");
    families.push({ key: `a:${x.id}`, kind: "application", id: x.id, code: x.code, child: x.child, class_sought: x.class_sought, parent_name: x.parent_name, mobile: x.mobile, source: x.source, counsellor: counsellor || "—", step, step_label: status === "Admitted" ? "Admitted" : STEPS[step - 1], done: status === "Admitted", status, level: x.level, admission_no: x.admission_no, student_id: stu?.id ?? null, since: x.applied_on });
  }
  return { enquiries, apps, families, guardianOf, stuByNo, who, docs: check(d) as unknown as { application_id: string; status: string; doc_type: string }[], docTypes, interviews, rules };
}

/** How many families wait at each step (those still moving), and how many are admitted. */
function counts(families: Family[]) {
  const live = families.filter((f) => !["Lost", "Rejected", "Admitted"].includes(f.status));
  return { steps: STEPS.map((label, i) => ({ n: i + 1, label, count: live.filter((f) => f.step === i + 1).length })), admitted: families.filter((f) => f.status === "Admitted").length };
}

/** The school year the admissions are for: the next one that has not started, else the current year. */
export async function admissionYear(inst: string): Promise<string> {
  const ys = check(await supabaseAdmin.from("academic_years").select("name, start_date, is_current").eq("institution_id", inst).order("start_date")) as { name: string; start_date: string; is_current: boolean }[];
  return (ys.find((y) => y.start_date > today()) ?? ys.find((y) => y.is_current) ?? ys[ys.length - 1])?.name ?? "";
}

export async function steps(inst: string) { const { families } = await load(inst); return counts(families); }

// ═════════════ who, and the badges ═════════════
export async function me(inst: string, profile: string) {
  const [who, { families }, notes] = await Promise.all([whoAmI(inst, profile), load(inst), notifications(inst, profile)]);
  return { name: who.name, line: who.designation || "Admissions Head", emp_code: who.emp_code, badges: { approvals: families.filter((f) => f.status === "Active" && f.step === 6 && f.kind === "application").length, unread: notes.unread } };
}

// ═════════════ dashboard: overview ═════════════
export async function overview(inst: string) {
  const { enquiries, apps, families, who } = await load(inst);
  const c = counts(families);
  const now = today();
  const since = enquiries.map((x) => x.enquiry_date).sort()[0] ?? null;
  const totalFamilies = enquiries.length + apps.filter((x) => !x.enquiry_id).length;
  const pending = families.filter((f) => f.kind === "application" && f.status === "Active" && f.step === 6 && (apps.find((a) => a.id === f.id)?.level ?? 3) < 3).length;
  const due = enquiries.filter((x) => x.status === "Follow-up" && x.next_followup && x.next_followup <= now).sort((a, b) => (a.next_followup ?? "").localeCompare(b.next_followup ?? ""));
  const seats = await seatMatrix(inst);
  // the application form fee: collected so far, how many families paid, and how many forms still wait on it
  const paidApps = apps.filter((x) => x.fee_status === "Paid" && (x.fee_amount ?? 0) > 0);
  const collected = paidApps.reduce((n, x) => n + (x.fee_amount ?? 0), 0);
  const paidCount = paidApps.length;
  const approved = families.filter((f) => f.kind === "application" && f.status === "Active" && f.step === 3 && apps.find((a) => a.id === f.id)?.fee_status === "Pending").length;
  const bySource = new Map<string, number>();
  for (const x of enquiries) bySource.set(x.source, (bySource.get(x.source) ?? 0) + 1);
  for (const x of apps) if (!x.enquiry_id) bySource.set(x.source, (bySource.get(x.source) ?? 0) + 1);
  void who;
  return {
    year: await admissionYear(inst),
    steps: c.steps,
    tiles: {
      enquiries: { total: totalFamilies, since },
      applications: { total: apps.length, pct: totalFamilies ? Math.round((apps.length / totalFamilies) * 100) : 0 },
      admitted: { total: c.admitted, pct: totalFamilies ? Math.round((c.admitted / totalFamilies) * 100) : 0 },
      waiting: { total: pending + due.length, approvals: pending, followups: due.length },
      fees: { collected, paid: paidCount, pending: approved },
    },
    funnel: [...c.steps.map((s) => ({ label: s.label, count: s.count })), { label: "Admitted", count: c.admitted }],
    seats: seats.filter((s) => s.total > 0).map((s) => ({ name: s.name, taken: s.total - s.open, total: s.total })),
    followups: due.slice(0, 5).map((x) => ({ id: x.id, child: x.child, class_sought: x.class_sought, counsellor: nameOf(one(x.staff)) || "—", mobile: x.mobile, date: x.next_followup })),
    sources: [...bySource.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
  };
}

// ═════════════ dashboard: pipeline ═════════════
export async function pipeline(inst: string) {
  const { families } = await load(inst);
  const order = (f: Family) => (f.done ? 1 : 0);
  return { year: await admissionYear(inst), items: families.sort((a, b) => order(a) - order(b) || b.since.localeCompare(a.since)).map((f) => ({ key: f.key, kind: f.kind, id: f.id, code: f.code, child: f.child, class_sought: f.class_sought, parent_name: f.parent_name, mobile: f.mobile, source: f.source, counsellor: f.counsellor, step: f.step, step_label: f.step_label, status: f.status })) };
}

/** The top-bar search: name, mobile, enquiry or application number, admission number. */
export async function search(inst: string, q: unknown) {
  const term = z.string().trim().min(2).max(60).safeParse(q);
  if (!term.success) return { hits: [] };
  const needle = term.data.toLowerCase();
  const { families } = await load(inst);
  return { hits: families.filter((f) => `${f.child} ${f.parent_name} ${f.mobile ?? ""} ${f.code} ${f.admission_no ?? ""}`.toLowerCase().includes(needle)).slice(0, 8).map((f) => ({ key: f.key, title: f.child, subtitle: `${f.class_sought} · ${f.code}${f.admission_no ? ` · ${f.admission_no}` : ""} · ${f.done ? "Admitted" : `Step ${f.step}/11 ${f.step_label}`}`, step: f.step, done: f.done })) };
}

// ═════════════ notifications ═════════════
export interface Note { key: string; tone: "bad" | "warn" | "info" | "good"; mark: string; title: string; note: string; when: string; read: boolean; href?: string }
const PRETTY = (l: string[]) => (l.length <= 1 ? l.join("") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`);

export async function notifications(inst: string, profile: string): Promise<{ items: Note[]; unread: number }> {
  const now = today();
  const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const [{ enquiries, apps, families }, reads, fees, docs, offers] = await Promise.all([
    load(inst),
    supabaseAdmin.from("staff_notification_reads").select("key").eq("profile_id", profile).limit(5000),
    supabaseAdmin.from("adm_fee_payments").select("id, created_at").eq("institution_id", inst).gte("created_at", since).order("created_at", { ascending: false }).limit(200),
    supabaseAdmin.from("adm_documents").select("id, created_at").eq("institution_id", inst).eq("status", "Pending review").order("created_at", { ascending: false }).limit(500),
    supabaseAdmin.from("adm_offers").select("id, accept_by").eq("institution_id", inst).eq("status", "Offered").lte("accept_by", plusDays(2)).limit(200),
  ]);
  const R = new Set(((check(reads) ?? []) as { key: string }[]).map((r) => r.key));
  const items: Note[] = [];
  const add = (n: Omit<Note, "read">) => items.push({ ...n, read: R.has(n.key) });
  const fresh = enquiries.filter((x) => x.status === "New" && x.created_at >= since).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const web = fresh.filter((x) => x.source === "Website");
  const grouped = (list: Enq[], label: string, key: string, mark: string) => { if (list.length) add({ key: `${key}:${list.length}:${list[0].created_at.slice(0, 10)}`, tone: "info", mark, title: `${list.length} new ${label} ${list.length === 1 ? "enquiry" : "enquiries"}`, note: PRETTY([...new Set(list.map((x) => x.class_sought))]), when: istTime(list[0].created_at) === "00:00" ? "Today" : `${list[0].created_at.slice(0, 10) === now ? "Today" : "Yesterday"} ${istTime(list[0].created_at)}`, href: "/admissions/enquiries/admission-enquiry?tab=enquiry-list" }); };
  grouped(web, "website", "web", "W");
  grouped(fresh.filter((x) => x.source !== "Website"), "front-desk", "desk", "E");
  const due = enquiries.filter((x) => x.status === "Follow-up" && x.next_followup && x.next_followup <= now);
  if (due.length) { const hot = due.filter((x) => x.interest === "Hot").length; add({ key: `due:${now}:${due.length}`, tone: "warn", mark: "F", title: `${due.length} follow-up${due.length === 1 ? "" : "s"} due today`, note: hot ? "Hot leads first" : "Call them before the day ends", when: "Today", href: "/admissions/leads/lead-management?tab=followups-due" }); }
  const wait = families.filter((f) => f.kind === "application" && f.status === "Active" && f.step === 6);
  if (wait.length) add({ key: `approve:${now}:${wait.length}`, tone: "warn", mark: "A", title: `${wait.length} admission${wait.length === 1 ? "" : "s"} waiting for approval`, note: "Test results are in", when: "Today", href: "/admissions/approval/admission-approval" });
  const D = (check(docs) ?? []) as { created_at: string }[];
  if (D.length) add({ key: `docs:${D.length}:${D[0].created_at.slice(0, 10)}`, tone: "info", mark: "D", title: `${D.length} document${D.length === 1 ? "" : "s"} to verify`, note: "Uploaded with applications", when: "Today", href: "/admissions/verification/verification" });
  const online = apps.filter((x) => x.source === "Online" && x.status === "Under review" && x.created_at >= since);
  if (online.length) add({ key: `online:${online.length}:${online[0].created_at.slice(0, 10)}`, tone: "info", mark: "O", title: `${online.length} new online application${online.length === 1 ? "" : "s"}`, note: PRETTY([...new Set(online.map((x) => x.class_sought))]), when: "Recently", href: "/admissions/applications/applications?tab=online-applications" });
  const F = (check(fees) ?? []) as { created_at: string }[];
  if (F.length) add({ key: `fee:${F.length}:${F[0].created_at.slice(0, 10)}`, tone: "good", mark: "₹", title: `Fee received from ${F.length} ${F.length === 1 ? "family" : "families"}`, note: "Ready for registration", when: `${F[0].created_at.slice(0, 10) === now ? "Today" : "Yesterday"} ${istTime(F[0].created_at)}`, href: "/admissions/registration/student-registration" });
  const O = (check(offers) ?? []) as { id: string }[];
  if (O.length) add({ key: `offers:${now}:${O.length}`, tone: "bad", mark: "!", title: `${O.length} seat offer${O.length === 1 ? "" : "s"} about to expire`, note: "The family has not paid the admission fee yet", when: "Today", href: "/admissions/approval/offers" });
  return { items, unread: items.filter((n) => !n.read).length };
}

export async function markRead(inst: string, profile: string, input: unknown) {
  const { keys } = z.object({ keys: z.array(z.string().max(120)).max(200).optional() }).strict().parse(input);
  const list = keys?.length ? keys : (await notifications(inst, profile)).items.map((n) => n.key);
  if (list.length) check(await supabaseAdmin.from("staff_notification_reads").upsert(list.map((key) => ({ profile_id: profile, key })), { onConflict: "profile_id,key" }).select("key"));
  return { ok: true };
}

// ═════════════ leads and follow-ups ═════════════
const HOW = ["Call", "Visit", "Message", "Email"] as const;
const INTEREST = ["Hot", "Warm", "Cold"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-03.");

interface FollowRow { id: string; enquiry_id: string; how: string; outcome: string; interest: string; next_followup: string | null; done_on: string; created_at: string; staff: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }
const followCols = "id, enquiry_id, how, outcome, interest, next_followup, done_on, created_at, staff:logged_by(first_name, last_name)";

export async function leads(inst: string, dueOnly: boolean) {
  const now = today();
  const rows = check(await supabaseAdmin.from("adm_enquiries").select("id, code, child, class_sought, parent_name, mobile, interest, next_followup, counsellor, status, staff:counsellor(first_name, last_name)").eq("institution_id", inst).eq("status", "Follow-up").limit(2000)) as unknown as { id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; interest: string; next_followup: string | null; staff: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null }[];
  const ids = rows.map((r) => r.id);
  const last = new Map<string, FollowRow>();
  if (ids.length) for (const f of check(await supabaseAdmin.from("adm_followups").select(followCols).eq("institution_id", inst).in("enquiry_id", ids).order("done_on", { ascending: false }).order("created_at", { ascending: false }).limit(20000)) as unknown as FollowRow[]) if (!last.has(f.enquiry_id)) last.set(f.enquiry_id, f);
  const items = rows.filter((r) => !dueOnly || (r.next_followup && r.next_followup <= now)).map((r) => ({ id: r.id, code: r.code, child: r.child, class_sought: r.class_sought, parent_name: r.parent_name, mobile: r.mobile, interest: r.interest, last_on: last.get(r.id)?.done_on ?? null, last_how: last.get(r.id)?.how ?? null, next_followup: r.next_followup, overdue: !!r.next_followup && r.next_followup < now, counsellor: nameOf(one(r.staff)) || "—" }));
  items.sort((a, b) => (a.next_followup ?? "9999").localeCompare(b.next_followup ?? "9999"));
  return { items };
}

export async function followupHistory(inst: string) {
  const rows = check(await supabaseAdmin.from("adm_followups").select(followCols).eq("institution_id", inst).order("done_on", { ascending: false }).order("created_at", { ascending: false }).limit(2000)) as unknown as FollowRow[];
  const ids = [...new Set(rows.map((r) => r.enquiry_id))];
  const enq = ids.length ? (check(await supabaseAdmin.from("adm_enquiries").select("id, code, child, class_sought").eq("institution_id", inst).in("id", ids)) as { id: string; code: string; child: string; class_sought: string }[]) : [];
  const apps = ids.length ? (check(await supabaseAdmin.from("adm_applications").select("enquiry_id, code").eq("institution_id", inst).in("enquiry_id", ids)) as { enquiry_id: string; code: string }[]) : [];
  const E = new Map(enq.map((e) => [e.id, e])); const A = new Map(apps.map((a) => [a.enquiry_id, a.code]));
  return { items: rows.map((r) => ({ id: r.id, done_on: r.done_on, how: r.how, outcome: r.outcome, interest: r.interest, by: nameOf(one(r.staff)) || "—", child: E.get(r.enquiry_id)?.child ?? "—", class_sought: E.get(r.enquiry_id)?.class_sought ?? "", code: A.get(r.enquiry_id) ?? E.get(r.enquiry_id)?.code ?? "" })) };
}

/** The new enquiries (not yet leads). */
export async function newEnquiries(inst: string) {
  const rows = check(await supabaseAdmin.from("adm_enquiries").select("id, code, child, class_sought, parent_name, mobile, source, enquiry_date").eq("institution_id", inst).eq("status", "New").order("enquiry_date", { ascending: false }).order("created_at", { ascending: false }).limit(2000)) as { id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; source: string; enquiry_date: string }[];
  return { items: rows };
}

async function enquiryOf(inst: string, id: string, statuses: string[]) {
  const e = check(await supabaseAdmin.from("adm_enquiries").select("id, status, counsellor, interest").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string; counsellor: string | null; interest: string } | null;
  if (!e) throw new HttpError(404, "Enquiry not found.");
  if (!statuses.includes(e.status)) throw new HttpError(409, `That enquiry is ${e.status.toLowerCase()}.`);
  return e;
}

/** Makes a new enquiry a lead: the counsellor is the person who takes it up, and the first follow-up is tomorrow. */
export async function createLead(inst: string, me: string, id: string) {
  const e = await enquiryOf(inst, id, ["New"]);
  check(await supabaseAdmin.from("adm_enquiries").update({ status: "Follow-up", counsellor: e.counsellor ?? me, next_followup: plusDays(1) }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

export async function logFollowup(inst: string, me: string, id: string, input: unknown) {
  const i = z.object({ how: z.enum(HOW), outcome: z.string().trim().min(2, "Write what was said.").max(300), interest: z.enum(INTEREST), next_followup: date.nullable().optional(), done_on: date.optional() }).strict().parse(input);
  await enquiryOf(inst, id, ["Follow-up"]);
  if (i.next_followup && i.next_followup < today()) throw new HttpError(400, "The next follow-up cannot be in the past.");
  check(await supabaseAdmin.from("adm_followups").insert({ institution_id: inst, enquiry_id: id, how: i.how, outcome: i.outcome, interest: i.interest, next_followup: i.next_followup ?? null, done_on: i.done_on ?? today(), logged_by: me }).select("id"));
  check(await supabaseAdmin.from("adm_enquiries").update({ interest: i.interest, next_followup: i.next_followup ?? null }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

/** Send application: the family becomes an application in the same list the School Admin sees. */
export async function sendApplication(inst: string, me: string, id: string) {
  await enquiryOf(inst, id, ["Follow-up"]);
  return convertEnquiry(inst, id, me);
}

export async function markLost(inst: string, id: string, input: unknown) {
  const { reason } = z.object({ reason: z.string().trim().min(2, "Say why.").max(200) }).strict().parse(input);
  await enquiryOf(inst, id, ["New", "Follow-up"]);
  check(await supabaseAdmin.from("adm_enquiries").update({ status: "Closed", closed_reason: reason, next_followup: null }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ fee assignment (the admitted child's fee plan, in the Fees module) ═════════════
export async function feePlans(inst: string) {
  const { families } = await load(inst);
  const kids = families.filter((f) => f.kind === "application" && f.student_id);
  const have = kids.length ? new Set((check(await supabaseAdmin.from("student_fee_plans").select("student_id").eq("institution_id", inst).in("student_id", kids.map((k) => k.student_id as string))) as { student_id: string }[]).map((x) => x.student_id)) : new Set<string>();
  const out = [];
  for (const k of kids) {
    let annual: number | null = null; let group: string | null = null;
    try { const p = await studentPlan(inst, k.student_id as string); annual = p.annual; group = p.group_id; } catch { /* the student is not on the roster yet */ }
    out.push({ application_id: k.id, student_id: k.student_id, code: k.code, child: k.child, class_sought: k.class_sought, admission_no: k.admission_no, assigned: have.has(k.student_id as string), has_group: !!group, annual });
  }
  return { items: out };
}

/** Gives the admitted child the school's standard fee plan for their class, as the Fees module works it out. Concessions stay with the accounts team. */
export async function assignFeePlan(inst: string, applicationId: string) {
  const { families } = await load(inst);
  const f = families.find((x) => x.kind === "application" && x.id === applicationId);
  if (!f?.student_id) throw new HttpError(400, "The child needs a class first. Finish Class Allocation.");
  const p = await studentPlan(inst, f.student_id);
  if (!p.group_id) throw new HttpError(400, "The school has no fee group for this class yet. Ask the accounts team to set up the fee structure.");
  await savePlan(inst, f.student_id, { group_id: p.group_id, transport_id: p.transport_id, hostel_id: p.hostel_id, concession_pct: p.concession_pct });
  return { ok: true };
}

// ═════════════ portal accounts ═════════════
export async function portalAccounts(inst: string) {
  const { families, guardianOf, stuByNo } = await load(inst);
  const kids = families.filter((f) => f.kind === "application" && f.student_id);
  const users = new Map<string, boolean>();
  for (const k of kids) { const s = [...stuByNo.values()].find((x) => x.id === k.student_id); users.set(k.id, !!s?.user_profile_id); }
  return { items: kids.map((k) => { const g = guardianOf.get(k.student_id as string); return { application_id: k.id, code: k.code, child: k.child, class_sought: k.class_sought, admission_no: k.admission_no, parent_name: g?.full_name ?? k.parent_name, mobile: g?.phone ?? k.mobile, student_login: users.get(k.id) ?? false, parent_login: !!g?.user_profile_id, confirmed: k.done }; }) };
}

/** Creates the student's and the parent's sign-ins for an allocated child. The temporary passwords come back once, to hand to the family. */
export async function createPortalAccounts(inst: string, profile: string, actorName: string, actorRole: string, applicationId: string) {
  const { families, guardianOf } = await load(inst);
  const f = families.find((x) => x.kind === "application" && x.id === applicationId);
  if (!f?.student_id) throw new HttpError(400, "The child needs a class first. Finish Class Allocation.");
  const actor = { profileId: profile, name: actorName };
  const made: Credential[] = []; const problems: string[] = [];
  const kid = check(await supabaseAdmin.from("students").select("id, user_profile_id").eq("id", f.student_id).eq("institution_id", inst).maybeSingle()) as { id: string; user_profile_id: string | null } | null;
  if (!kid) throw new HttpError(404, "Student not found.");
  if (!kid.user_profile_id) { const r = await createStudentAccounts([kid.id], actor, actorRole); made.push(...r.created); problems.push(...r.skipped.map((s) => `Student: ${s.reason}`)); }
  const g = guardianOf.get(f.student_id);
  if (!g) problems.push("Parent: no guardian is linked to this child.");
  else if (!g.user_profile_id) {
    const owns = check(await supabaseAdmin.from("guardians").select("id").eq("id", g.id).eq("institution_id", inst).maybeSingle());
    if (!owns) problems.push("Parent: guardian not found in this school.");
    else { try { made.push(await createParentAccount(g.id, actor, actorRole)); } catch (e) { problems.push(`Parent: ${e instanceof Error ? e.message : "could not create the account."}`); } }
  }
  return { created: made.map((c) => ({ who: c.student_id ? "Student" : "Parent", name: c.name, login_id: c.login_id, temporary_password: c.temporary_password })), problems };
}

// ═════════════ confirmation ═════════════
export async function confirmations(inst: string) {
  const { families } = await load(inst);
  const accounts = new Map((await portalAccounts(inst)).items.map((x) => [x.application_id, x]));
  const kids = families.filter((f) => f.kind === "application" && f.student_id);
  const planned = kids.length ? new Set((check(await supabaseAdmin.from("student_fee_plans").select("student_id").eq("institution_id", inst).in("student_id", kids.map((k) => k.student_id as string))) as { student_id: string }[]).map((x) => x.student_id)) : new Set<string>();
  return { items: kids.map((k) => { const a = accounts.get(k.id); return { application_id: k.id, code: k.code, child: k.child, class_sought: k.class_sought, admission_no: k.admission_no, accounts: !!a?.student_login && !!a?.parent_login, fee_plan: planned.has(k.student_id as string), confirmed: k.done }; }) };
}

/** The last step: the child is admitted. It needs the sign-ins and the fee plan; the parent gets a notice and the seat offer is marked Confirmed. */
export async function confirmAdmission(inst: string, profile: string, applicationId: string) {
  const { items } = await confirmations(inst);
  const c = items.find((x) => x.application_id === applicationId);
  if (!c) throw new HttpError(400, "That child has not been given a class yet.");
  if (c.confirmed) throw new HttpError(409, "That admission is already confirmed.");
  if (!c.accounts) throw new HttpError(400, "Create the student and parent sign-ins first.");
  if (!c.fee_plan) throw new HttpError(400, "Assign the fee plan first.");
  const { families, guardianOf } = await load(inst);
  const f = families.find((x) => x.id === applicationId)!;
  check(await supabaseAdmin.from("adm_applications").update({ confirmed_at: new Date().toISOString() }).eq("id", applicationId).eq("institution_id", inst).select("id"));
  await supabaseAdmin.from("adm_offers").update({ status: "Confirmed" }).eq("institution_id", inst).eq("application_id", applicationId);
  const g = f.student_id ? guardianOf.get(f.student_id) : undefined;
  if (g) check(await supabaseAdmin.from("parent_messages").insert({ institution_id: inst, kind: "notification", guardian_id: g.id, student_id: f.student_id, subject: "Admission confirmed", body: `${f.child} is admitted to ${f.class_sought}. Admission number ${f.admission_no ?? ""}. Welcome to the school.`, created_by: profile }).select("id"));
  return { ok: true };
}
