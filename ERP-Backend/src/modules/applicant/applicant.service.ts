import { z } from "zod";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { admissionFees, collectAdmissionFee, formFee } from "../school/front-office.service";
import { DEFAULT_LETTER, meritList, programmeFor, programmes, seatMatrix, type Programme } from "../school/admission-extra.service";
import { admissionYear, eligibility } from "../admissions/admissions.service";
import { submitApplication } from "../admissions/admissions-selection.service";
import { createOrder, razorpayConfigured, verifyCheckoutSignature } from "../../lib/razorpay";

/**
 * The Applicant portal (families). It reads and writes the same adm_* rows as the Admissions portal and the School Admin
 * Admission module. Every function takes the school and the family account from the signed-in session, and every query
 * names both: a family can only ever see or change the enquiries, applications, documents, slots, payments and messages
 * that carry its own family_id. An id sent by the browser is always looked up with that filter first.
 */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const nameOf = (p: { first_name?: string; last_name?: string } | null) => (p ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : "");
const date10 = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid date.");
const tail10 = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-10);

/** The documents a family uploads. The label is what is stored as the document type, so the office sees the same names. */
export const DOC_TYPES: { label: string; required: boolean }[] = [
  { label: "Birth certificate", required: true }, { label: "Child's Aadhaar card", required: true }, { label: "Parent ID proof", required: true }, { label: "Address proof", required: true },
  { label: "Passport-size photos (child and parents)", required: true }, { label: "Preschool report or certificate", required: false }, { label: "Medical and vaccination record", required: true },
];
export const MAX_FILE = 5 * 1024 * 1024;
export const BUCKET = "applicant-docs";

interface Fam { first_name: string; last_name: string; phone: string | null; email: string }
export interface MyApp { id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; details: Record<string, string> | null; applied_on: string; status: string; submitted_at: string | null; verified_at: string | null; fee_status: "Pending" | "Paid" | "Waived"; fee_amount: number | null; fee_paid_on: string | null; return_reason: string | null; admission_no: string | null; confirmed_at: string | null; created_at: string }
const APP_COLS = "id, code, child, class_sought, parent_name, mobile, details, applied_on, status, submitted_at, verified_at, fee_status, fee_amount, fee_paid_on, return_reason, admission_no, confirmed_at, created_at";

async function family(me: string): Promise<Fam> {
  const p = check(await supabaseAdmin.from("user_profiles").select("first_name, last_name, phone, email").eq("id", me).maybeSingle()) as Fam | null;
  if (!p) throw new HttpError(401, "Sign in again.");
  return p;
}
const myApps = async (inst: string, me: string) => check(await supabaseAdmin.from("adm_applications").select(APP_COLS).eq("institution_id", inst).eq("family_id", me).order("created_at", { ascending: false }).limit(50)) as unknown as MyApp[];
/** One of the family's own applications: an id that is not theirs is "not found", never "forbidden", so ids cannot be probed. */
async function mine(inst: string, me: string, id: string): Promise<MyApp> {
  const a = check(await supabaseAdmin.from("adm_applications").select(APP_COLS).eq("id", z.string().uuid("Invalid id.").parse(id)).eq("institution_id", inst).eq("family_id", me).maybeSingle()) as unknown as MyApp | null;
  if (!a) throw new HttpError(404, "Application not found.");
  return a;
}
const classOnly = (c: string) => c.replace(/\s*·.*$/, "");
const inList = (p: Programme, cls: string) => p.classes.split(",").map((s) => s.trim()).includes(classOnly(cls));

// ═════════════ who, the sidebar and the bell ═════════════
export async function me(inst: string, profile: string) {
  const [f, apps, school, n] = await Promise.all([family(profile), myApps(inst, profile), supabaseAdmin.from("institutions").select("name, code").eq("id", inst).maybeSingle(), notifications(inst, profile)]);
  const docs = apps.length ? (check(await supabaseAdmin.from("adm_documents").select("application_id, status").eq("institution_id", inst).in("application_id", apps.map((a) => a.id))) as { status: string }[]) : [];
  const first = apps[0];
  return {
    name: nameOf(f), email: f.email, school: check(school) as { name: string; code: string },
    line: first ? `Applying for ${first.child.split(" ")[0]} · ${classOnly(first.class_sought)}` : "No application yet",
    badges: { documents: docs.filter((d) => d.status === "Returned").length, unread: n.unread },
  };
}

// ═════════════ About the school (from the School Admin's own setup) ═════════════
export async function schoolOverview(inst: string) {
  const [prof, inst0, campuses, grades, students, staff, cal] = await Promise.all([
    supabaseAdmin.from("school_profile").select("name, board, affiliation_no, year_established, principal, email, phone, website, address, city").eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("institutions").select("name, board, affiliation_number").eq("id", inst).maybeSingle(),
    supabaseAdmin.from("campuses").select("name, city").eq("institution_id", inst).eq("is_active", true),
    supabaseAdmin.from("grades").select("name, sort_order").eq("institution_id", inst).eq("is_active", true).order("sort_order"),
    supabaseAdmin.from("students").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("status", "Enrolled"),
    supabaseAdmin.from("user_profiles").select("id", { count: "exact", head: true }).eq("institution_id", inst).in("role_id", (check(await supabaseAdmin.from("roles").select("id").in("name", ["Faculty", "ClassTeacher", "HOD"])) as { id: string }[]).map((r) => r.id)),
    supabaseAdmin.from("calendar_settings").select("school_week, saturday_hours").eq("institution_id", inst).maybeSingle(),
  ]);
  const p = check(prof) as { name: string; board: string; affiliation_no: string; year_established: number | null; principal: string; email: string; phone: string; website: string; address: string; city: string } | null;
  const i = check(inst0) as { name: string; board: string | null; affiliation_number: string | null } | null;
  const g = (check(grades) ?? []) as { name: string }[];
  const c = (check(cal) ?? null) as { school_week: string; saturday_hours: string } | null;
  const campusRows = (check(campuses) ?? []) as { name: string; city: string | null }[];
  return {
    name: p?.name || i?.name || "", board: p?.board || i?.board || "", affiliation_no: p?.affiliation_no || i?.affiliation_number || "", established: p?.year_established ?? null, principal: p?.principal ?? "",
    classes: g.length ? `${g[0].name} to ${g[g.length - 1].name}` : "", students: students.count ?? 0, teachers: staff.count ?? 0,
    campuses: campusRows.map((x) => x.name), week: c ? `${c.school_week}${c.saturday_hours && c.saturday_hours !== "Full day" ? ` · Saturday ${c.saturday_hours.toLowerCase()}` : ""}` : "",
    contact: { email: p?.email ?? "", phone: p?.phone ?? "", website: p?.website ?? "", address: [p?.address, p?.city].filter(Boolean).join(", ") },
  };
}

function eligText(p: Programme, year: string) {
  const y = /^\d{4}/.test(year) ? year.slice(0, 4) : String(new Date().getFullYear() + 1);
  return p.overall_pct ? `${p.overall_pct}% overall in the last exam` : `${p.min_age} years by 31 Mar ${y}`;
}
export async function classesAndSeats(inst: string) {
  const [list, seats, year] = await Promise.all([programmes(inst), seatMatrix(inst), admissionYear(inst)]);
  const open = new Map(seats.map((s) => [s.name, s.open]));
  return { year, items: list.map((p) => { const left = Math.max(0, open.get(p.name) ?? p.seats_total); return { name: p.name, classes: p.classes, eligibility: eligText(p, year), assessment: p.assessment, seats: p.seats_total, left, status: left === 0 ? "Full" : left <= Math.max(5, Math.round(p.seats_total * 0.2)) ? "Few seats left" : "Open" }; }) };
}

export async function feeStructure(inst: string, cls: string) {
  const c = z.string().trim().min(1).max(40).parse(cls);
  const f = await admissionFees(inst, c);
  const groups = (check(await supabaseAdmin.from("fee_groups").select("id, name, classes").eq("institution_id", inst).eq("status", "Active")) as { id: string; name: string; classes: string }[]).filter((g) => g.classes.split(",").map((s) => s.trim()).includes(classOnly(c)));
  const rows: { fee: string; when: string; amount: number }[] = [
    { fee: "Application fee", when: "One time, non-refundable", amount: f?.form_fee ?? 0 }, { fee: "Admission fee", when: "One time", amount: f?.admission_fee ?? 0 }, { fee: "Caution deposit", when: "Refundable when the student leaves", amount: f?.caution ?? 0 },
  ];
  if (groups.length) {
    const st = check(await supabaseAdmin.from("fee_structure").select("amount, fee_heads:head_id(name, frequency, status, optional_text)").in("group_id", groups.map((g) => g.id))) as unknown as { amount: number; fee_heads: { name: string; frequency: string; status: string; optional_text: string } | { name: string; frequency: string; status: string; optional_text: string }[] }[];
    for (const s of st) { const h = one(s.fee_heads); if (h && h.status === "Active") rows.push({ fee: h.name + (h.optional_text && h.optional_text !== "No" ? " (optional)" : ""), when: h.frequency, amount: s.amount }); }
  }
  const lines = rows.filter((r) => r.amount > 0);
  return { class: c, rows: lines, seat: { admission_fee: f?.admission_fee ?? 0, caution: f?.caution ?? 0, total: (f?.admission_fee ?? 0) + (f?.caution ?? 0) } };
}

export async function calendar(inst: string) {
  const [ev, sl] = await Promise.all([
    supabaseAdmin.from("calendar_events").select("title, event_date, kind").eq("institution_id", inst).eq("published", true).order("event_date").limit(500),
    supabaseAdmin.from("adm_slots").select("slot_date").eq("institution_id", inst).eq("kind", "Assessment").order("slot_date"),
  ]);
  const rows: { date: string; what: string; details: string }[] = ((check(ev) ?? []) as { title: string; event_date: string; kind: string }[]).filter((e) => /admission|application|assessment|result|offer|orientation|reopen|term begin|first day/i.test(e.title)).map((e) => ({ date: e.event_date, what: e.title, details: e.kind }));
  const slots = (check(sl) ?? []) as { slot_date: string }[];
  if (slots.length) { rows.push({ date: slots[0].slot_date, what: "Assessments begin", details: "Book a slot in the portal" }, { date: slots[slots.length - 1].slot_date, what: "Assessments end", details: "Last date to attend" }); }
  const t = today();
  return { items: rows.sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ ...r, status: r.date < t ? "Done" : "Upcoming" })) };
}

export async function faqs(inst: string) {
  const rows = (check(await supabaseAdmin.from("chatbot_faqs").select("topic, question, answer").eq("institution_id", inst).eq("enabled", true).limit(200)) ?? []) as { topic: string; question: string; answer: string }[];
  const adm = rows.filter((r) => /admission|fee|transport|enrol/i.test(r.topic));
  return { items: (adm.length ? adm : rows).filter((r) => r.answer).map((r) => ({ question: r.question, answer: r.answer })) };
}

export async function subjects(inst: string) {
  const g = (check(await supabaseAdmin.from("grades").select("id, name, sort_order").eq("institution_id", inst).eq("is_active", true).order("sort_order")) ?? []) as { id: string; name: string }[];
  const gs = g.length ? (check(await supabaseAdmin.from("grade_subjects").select("grade_id, is_mandatory, subjects:subject_id(name, is_active)").in("grade_id", g.map((x) => x.id))) as unknown as { grade_id: string; is_mandatory: boolean; subjects: { name: string; is_active: boolean } | { name: string; is_active: boolean }[] }[]) : [];
  const board = check(await supabaseAdmin.from("school_profile").select("board, affiliation_no").eq("institution_id", inst).maybeSingle()) as { board: string; affiliation_no: string } | null;
  return { board: board?.board ?? "", affiliation_no: board?.affiliation_no ?? "", classes: g.map((x) => ({ name: x.name, subjects: gs.filter((s) => s.grade_id === x.id).flatMap((s) => { const sub = one(s.subjects); return sub && sub.is_active ? [{ name: sub.name, type: s.is_mandatory ? "Compulsory" : "Optional" }] : []; }) })) };
}

// ═════════════ enquiry and campus visit ═════════════
/** The office's answer to an enquiry: a reply tagged with it, else the office's first message after the question and before the family writes again (staff may answer from the plain thread). */
function answerOf(msgs: { id: string; enquiry_id: string | null; from_family: boolean; body: string }[], enquiryId: string) {
  const tagged = msgs.filter((y) => y.enquiry_id === enquiryId && !y.from_family).pop();
  if (tagged) return tagged;
  const at = msgs.findIndex((y) => y.enquiry_id === enquiryId && y.from_family);
  if (at < 0) return undefined;
  for (let i = at + 1; i < msgs.length; i++) { if (msgs[i].from_family) return undefined; if (!msgs[i].enquiry_id) return msgs[i]; }
  return undefined;
}
const msgOf = (r: { id: string; enquiry_id: string | null; from_family: boolean; body: string; created_at: string }) => r;
export async function enquiries(inst: string, profile: string) {
  const [e, m, classes] = await Promise.all([
    supabaseAdmin.from("adm_enquiries").select("id, code, child, class_sought, notes, enquiry_date, status").eq("institution_id", inst).eq("family_id", profile).order("created_at", { ascending: false }).limit(200),
    supabaseAdmin.from("adm_messages").select("id, enquiry_id, from_family, body, created_at").eq("institution_id", inst).eq("family_id", profile).order("created_at").limit(2000),
    programmes(inst),
  ]);
  const msgs = (check(m) as { id: string; enquiry_id: string | null; from_family: boolean; body: string; created_at: string }[]).map(msgOf);
  return {
    classes: ["Nursery", "LKG", "UKG", ...Array.from({ length: 12 }, (_, i) => `Class ${i + 1}`)].filter((c) => classes.some((p) => inList(p, c))),
    items: (check(e) as { id: string; code: string; child: string; class_sought: string; notes: string | null; enquiry_date: string; status: string }[]).map((x) => { const reply = answerOf(msgs, x.id); return { id: x.id, code: x.code, asked: x.enquiry_date, child: x.child, class_sought: x.class_sought, question: x.notes ?? "", answer: reply?.body ?? "", status: reply ? "Answered" : "Open" }; }),
  };
}

export async function askEnquiry(inst: string, profile: string, body: unknown) {
  const i = z.object({ child: z.string().trim().min(2, "Enter the child's name.").max(150), class_sought: z.string().trim().min(1, "Choose the class.").max(30), question: z.string().trim().min(3, "Write your question.").max(500) }).strict().parse(body);
  const f = await family(profile);
  const row = check(await supabaseAdmin.from("adm_enquiries").insert({ institution_id: inst, child: i.child, class_sought: i.class_sought, parent_name: nameOf(f), mobile: f.phone, email: f.email, source: "Applicant portal", notes: i.question, family_id: profile, created_by: profile }).select("id, code").single()) as { id: string; code: string };
  check(await supabaseAdmin.from("adm_messages").insert({ institution_id: inst, family_id: profile, enquiry_id: row.id, from_family: true, sender_id: profile, body: i.question }).select("id"));
  return { id: row.id, code: row.code };
}

async function slotRows(inst: string, kind: "Visit" | "Assessment") {
  const slots = (check(await supabaseAdmin.from("adm_slots").select("id, slot_date, slot_time, capacity").eq("institution_id", inst).eq("kind", kind).gte("slot_date", today()).order("slot_date").order("slot_time").limit(300)) ?? []) as { id: string; slot_date: string; slot_time: string; capacity: number }[];
  const used = new Map<string, number>();
  if (slots.length) for (const b of check(await supabaseAdmin.from("adm_slot_bookings").select("slot_id").eq("institution_id", inst).eq("status", "Booked").in("slot_id", slots.map((s) => s.id))) as { slot_id: string }[]) used.set(b.slot_id, (used.get(b.slot_id) ?? 0) + 1);
  return slots.map((s) => ({ id: s.id, date: s.slot_date, time: s.slot_time.slice(0, 5), left: Math.max(0, s.capacity - (used.get(s.id) ?? 0)) }));
}
export async function visits(inst: string, profile: string) {
  const slots = await slotRows(inst, "Visit");
  const mineB = slots.length ? (check(await supabaseAdmin.from("adm_slot_bookings").select("slot_id").eq("institution_id", inst).eq("family_id", profile).eq("status", "Booked").in("slot_id", slots.map((s) => s.id))) as { slot_id: string }[]) : [];
  return { slots: slots.map((s) => ({ ...s, mine: mineB.some((b) => b.slot_id === s.id) })) };
}
async function book(inst: string, profile: string, kind: "Visit" | "Assessment", slotId: string, applicationId: string | null) {
  const slot = check(await supabaseAdmin.from("adm_slots").select("id, slot_date, slot_time, capacity").eq("id", z.string().uuid().parse(slotId)).eq("institution_id", inst).eq("kind", kind).maybeSingle()) as { id: string; slot_date: string; slot_time: string; capacity: number } | null;
  if (!slot || slot.slot_date < today()) throw new HttpError(404, "That slot is not available.");
  const { count } = await supabaseAdmin.from("adm_slot_bookings").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("slot_id", slot.id).eq("status", "Booked");
  if ((count ?? 0) >= slot.capacity) throw new HttpError(409, "That slot is full. Choose another.");
  // one live booking per family (per child for an assessment): an earlier one is released first
  let old = supabaseAdmin.from("adm_slot_bookings").update({ status: "Cancelled" }).eq("institution_id", inst).eq("family_id", profile).eq("status", "Booked").in("slot_id", ((check(await supabaseAdmin.from("adm_slots").select("id").eq("institution_id", inst).eq("kind", kind)) as { id: string }[]).map((s) => s.id)));
  old = applicationId ? old.eq("application_id", applicationId) : old;
  check(await old.select("id"));
  check(await supabaseAdmin.from("adm_slot_bookings").insert({ institution_id: inst, slot_id: slot.id, family_id: profile, application_id: applicationId }).select("id"));
  return slot;
}
export async function bookVisit(inst: string, profile: string, body: unknown) {
  const { slot_id } = z.object({ slot_id: z.string().uuid() }).strict().parse(body);
  await book(inst, profile, "Visit", slot_id, null);
  return { ok: true };
}

// ═════════════ the application ═════════════
const PERSON = z.string().trim().max(150);
const DETAIL_KEYS = z.object({
  dob: date10.optional(), gender: z.enum(["Female", "Male", "Other"]).optional(), languages: PERSON.optional(), prev_school: PERSON.optional(), blood_group: z.string().trim().max(5).optional(),
  father_name: PERSON.optional(), father_occupation: PERSON.optional(), mother_name: PERSON.optional(), mother_occupation: PERSON.optional(), email: z.string().trim().max(150).optional(), sibling: PERSON.optional(),
  address: z.string().trim().max(300).optional(), transport: z.enum(["Yes", "No"]).optional(), transport_stop: PERSON.optional(), health_notes: z.string().trim().max(300).optional(),
}).strict();

export async function programmeCards(inst: string) {
  const [list, seats, year] = await Promise.all([programmes(inst), seatMatrix(inst), admissionYear(inst)]);
  const open = new Map(seats.map((s) => [s.name, s.open]));
  const group = (p: Programme) => { const first = p.classes.split(",")[0].trim(); if (/transfer/i.test(p.name)) return "Board classes · transfer only"; if (["Nursery", "LKG", "UKG"].includes(first)) return "Pre-primary"; const n = Number(first.replace("Class ", "")); return n <= 5 ? "Primary" : n <= 10 ? "Middle and secondary" : "Senior secondary"; };
  return { year, items: list.map((p) => ({ name: p.name, classes: p.classes.split(",").map((s) => s.trim()), group: group(p), left: Math.max(0, open.get(p.name) ?? p.seats_total), assessment: p.assessment, min_age: p.min_age, overall_pct: p.overall_pct, rule: eligText(p, year) })) };
}

export async function checkEligibility(inst: string, body: unknown) {
  const i = z.object({ programme: z.string().trim().min(1).max(80), dob: date10 }).strict().parse(body);
  const p = (await programmes(inst)).find((x) => x.name === i.programme);
  if (!p) throw new HttpError(404, "Choose a programme.");
  if (i.dob > today()) throw new HttpError(400, "The date of birth cannot be in the future.");
  const e = eligibility(i.dob, p.min_age);
  return { state: e.state, age: e.age, rule: eligText(p, await admissionYear(inst)), assessment: p.assessment, message: e.state === "Eligible" ? "Your child meets the age rule for this class." : e.state === "Borderline" ? "Your child is within a month of the age rule. The admissions office decides each case: you can still apply." : "Your child is below the age rule for this class." };
}

export async function myApplications(inst: string, profile: string) {
  const apps = await myApps(inst, profile);
  const [docs, iv, off] = await Promise.all([
    apps.length ? supabaseAdmin.from("adm_documents").select("application_id, status").eq("institution_id", inst).in("application_id", apps.map((a) => a.id)) : Promise.resolve({ data: [], error: null }),
    apps.length ? supabaseAdmin.from("adm_interviews").select("application_id, status").eq("institution_id", inst).in("application_id", apps.map((a) => a.id)) : Promise.resolve({ data: [], error: null }),
    apps.length ? supabaseAdmin.from("adm_offers").select("application_id, status").eq("institution_id", inst).in("application_id", apps.map((a) => a.id)) : Promise.resolve({ data: [], error: null }),
  ]);
  const D = check(docs) as { application_id: string; status: string }[]; const I = check(iv) as { application_id: string; status: string }[]; const O = check(off) as { application_id: string; status: string }[];
  return { items: apps.map((a) => { const t = tracker(a, D.filter((d) => d.application_id === a.id), I.filter((d) => d.application_id === a.id), O.find((d) => d.application_id === a.id)?.status ?? null); return { id: a.id, code: a.code, child: a.child, class_sought: a.class_sought, applied_on: a.submitted_at ?? a.created_at, draft: !a.submitted_at && a.status === "Under review", ...t }; }) };
}

export async function application(inst: string, profile: string, id: string) {
  const a = await mine(inst, profile, id);
  const f = await family(profile);
  return { ...a, details: a.details ?? {}, parent: nameOf(f), mobile: a.mobile ?? f.phone ?? "", draft: !a.submitted_at && a.status === "Under review" };
}

export async function startApplication(inst: string, profile: string, body: unknown) {
  const i = z.object({ programme: z.string().trim().min(1).max(80), class_sought: z.string().trim().min(1).max(30), child: z.string().trim().min(2, "Enter the child's full name.").max(150), details: DETAIL_KEYS }).strict().parse(body);
  const p = (await programmes(inst)).find((x) => x.name === i.programme);
  if (!p || !inList(p, i.class_sought)) throw new HttpError(400, "Choose a programme and one of its classes.");
  if (!i.details.dob) throw new HttpError(400, "Enter the child's date of birth.");
  const f = await family(profile);
  const stream = p.name.includes("·") ? p.name.split("·")[1].trim() : "";
  const cls = stream ? `${classOnly(i.class_sought)} · ${stream}` : classOnly(i.class_sought);
  const row = check(await supabaseAdmin.from("adm_applications").insert({ institution_id: inst, child: i.child, class_sought: cls, parent_name: nameOf(f), mobile: f.phone, source: "Applicant portal", details: { ...i.details, email: i.details.email || f.email, ...(stream ? { stream } : {}) }, family_id: profile, created_by: profile, fee_status: "Pending" }).select("id, code").single()) as { id: string; code: string };
  return row;
}

export async function saveDetails(inst: string, profile: string, id: string, body: unknown) {
  const a = await mine(inst, profile, id);
  if (a.submitted_at && a.status !== "Returned") throw new HttpError(409, "A submitted application is changed through the admissions office: send them a message.");
  const i = DETAIL_KEYS.extend({ child: z.string().trim().min(2).max(150).optional() }).strict().parse(body);
  const { child, ...rest } = i;
  check(await supabaseAdmin.from("adm_applications").update({ ...(child ? { child } : {}), details: { ...(a.details ?? {}), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) } }).eq("id", a.id).eq("institution_id", inst).eq("family_id", profile).select("id"));
  return { ok: true };
}

export async function submit(inst: string, profile: string, id: string) {
  const a = await mine(inst, profile, id);
  const f = await family(profile);
  check(await supabaseAdmin.from("adm_applications").update({ details: { ...(a.details ?? {}), declared_by: nameOf(f), declared_on: today() } }).eq("id", a.id).eq("institution_id", inst).eq("family_id", profile).select("id"));
  return submitApplication(inst, a.id);
}

// ═════════════ progress ═════════════
const STEP_LABELS = ["Enquiry", "Application submitted", "Documents verified", "Assessment booked", "Assessment done", "Offer made", "Admission fee paid", "Admission confirmed"];
function tracker(a: MyApp, docs: { status: string }[], iv: { status: string }[], offer: string | null) {
  const submitted = !!a.submitted_at;
  const verified = !!a.verified_at || (docs.length > 0 && docs.every((d) => d.status === "Verified") && submitted);
  const booked = iv.length > 0;
  const done = iv.some((x) => x.status === "Completed");
  const made = ["Approved", "Fee paid", "Registered", "Allocated"].includes(a.status) || !!offer;
  const paid = ["Fee paid", "Registered", "Allocated"].includes(a.status) || ["Fee paid", "Confirmed"].includes(offer ?? "");
  const confirmed = !!a.confirmed_at;
  const flags = [true, submitted, verified, booked, done, made, paid, confirmed];
  const current = flags.findIndex((x) => !x);
  const label = confirmed ? "Admission confirmed" : a.status === "Rejected" ? "Not selected" : a.status === "Waitlisted" ? "Waitlisted" : a.status === "Returned" ? "Returned for correction" : paid ? "Admission fee paid" : made ? "Offer made" : done ? "Assessment done" : booked ? "Assessment booked" : verified ? "Documents verified" : submitted ? "Application submitted" : "Draft";
  return { steps: STEP_LABELS.map((s, n) => ({ n: n + 1, label: s, state: flags[n] ? "done" : n === current ? "current" : "todo" })), label };
}

export async function overview(inst: string, profile: string, appId?: string) {
  const apps = await myApps(inst, profile);
  const a = (appId && apps.find((x) => x.id === appId)) || apps[0];
  if (!a) return { application: null, applications: [] as { id: string; code: string; child: string }[] };
  const [docs, iv, off, pays, msgs, seats, cal, slots] = await Promise.all([
    check(await supabaseAdmin.from("adm_documents").select("id, doc_type, status, review_note").eq("institution_id", inst).eq("application_id", a.id)) as { id: string; doc_type: string; status: string; review_note: string | null }[],
    check(await supabaseAdmin.from("adm_interviews").select("status, interview_date, interview_time").eq("institution_id", inst).eq("application_id", a.id)) as { status: string; interview_date: string; interview_time: string | null }[],
    check(await supabaseAdmin.from("adm_offers").select("id, status, accept_by").eq("institution_id", inst).eq("application_id", a.id).maybeSingle()) as { id: string; status: string; accept_by: string } | null,
    check(await supabaseAdmin.from("adm_fee_payments").select("admission_fee, caution").eq("institution_id", inst).eq("application_id", a.id)) as { admission_fee: number; caution: number }[],
    check(await supabaseAdmin.from("adm_messages").select("id, from_family, body, created_at").eq("institution_id", inst).eq("family_id", profile).eq("from_family", false).order("created_at", { ascending: false }).limit(2)) as { id: string; from_family: boolean; body: string; created_at: string }[],
    classesAndSeats(inst), calendar(inst), slotRows(inst, "Assessment"),
  ]);
  const t = tracker(a, docs, iv, off?.status ?? null);
  const prog = programmeFor(await programmes(inst), a.class_sought, a.details?.stream);
  const row = seats.items.find((s) => s.name === prog?.name);
  const returned = docs.find((d) => d.status === "Returned");
  const reqLabels = DOC_TYPES.filter((d) => d.required).map((d) => d.label);
  const reqVerified = reqLabels.every((l) => docs.some((d) => d.doc_type === l && d.status === "Verified"));
  const lastSlot = slots.length ? slots[slots.length - 1].date : null;
  let next: { title: string; text: string; action: string; href: string } | null = null;
  if (returned) next = { title: `Re-upload ${returned.doc_type.toLowerCase()}`, text: returned.review_note ? `The admissions office says: ${returned.review_note}` : "The admissions office couldn't read it. Upload a clear photo or PDF.", action: "Upload now", href: "documents/upload-documents" };
  else if (!a.submitted_at) next = a.fee_status === "Pending" ? { title: "Pay the application fee", text: "Pay the application fee, then submit the application.", action: "Pay now", href: "fees-payment/fees" } : { title: "Finish and submit your application", text: "Your application is saved as a draft.", action: "Continue", href: "application/application?tab=new-application" };
  else if (off?.status === "Offered") next = { title: "Accept the offer and pay the admission fee", text: `Your seat is held until ${off.accept_by}.`, action: "Open offer", href: "application/application?tab=merit-and-offer" };
  else if (!iv.length && reqVerified && !["Rejected", "Waitlisted", "Approved", "Fee paid", "Registered", "Allocated"].includes(a.status)) next = { title: "Book an assessment slot", text: "Your documents are verified. Choose a time for the assessment.", action: "Book a slot", href: "assessment/assessment" };
  else if (docs.length < reqLabels.length) next = { title: "Upload your documents", text: "The office checks each document within two working days.", action: "Upload now", href: "documents/upload-documents" };
  const bookedAt = iv.find((x) => x.status !== "Completed");
  return {
    applications: apps.map((x) => ({ id: x.id, code: x.code, child: x.child })),
    application: { id: a.id, code: a.code, child: a.child, class_sought: a.class_sought, year: seats.year, status: t.label, steps: t.steps },
    next,
    tiles: {
      documents: { verified: docs.filter((d) => d.status === "Verified").length, total: DOC_TYPES.length },
      assessment: bookedAt ? { label: `${bookedAt.interview_date}${bookedAt.interview_time ? " " + bookedAt.interview_time.slice(0, 5) : ""}`, sub: "Booked" } : iv.some((x) => x.status === "Completed") ? { label: "Done", sub: "Result with the office" } : { label: "Not booked", sub: lastSlot ? `Book by ${lastSlot}` : "Slots open soon" },
      seats: { left: row?.left ?? 0, total: row?.seats ?? 0, class: classOnly(a.class_sought) },
      paid: (a.fee_status === "Paid" ? a.fee_amount ?? 0 : 0) + pays.reduce((n, p) => n + p.admission_fee + p.caution, 0),
    },
    key_dates: cal.items.slice(0, 6), messages: msgs.map((m) => ({ id: m.id, from: "Admissions office", body: m.body, at: m.created_at })),
  };
}

// ═════════════ documents ═════════════
export async function documents(inst: string, profile: string, appId: string) {
  const a = await mine(inst, profile, appId);
  const rows = check(await supabaseAdmin.from("adm_documents").select("id, doc_type, file_name, status, review_note, storage_path, updated_at").eq("institution_id", inst).eq("application_id", a.id)) as { id: string; doc_type: string; file_name: string | null; status: string; review_note: string | null; storage_path: string | null; updated_at: string }[];
  const items = DOC_TYPES.map((t) => { const d = rows.find((r) => r.doc_type === t.label); return { id: d?.id ?? null, doc_type: t.label, required: t.required, file_name: d?.file_name ?? "", status: !d ? "Not uploaded" : d.status === "Returned" ? "Re-upload needed" : d.status === "Verified" ? "Verified" : "Under review", note: d?.review_note ?? "", has_file: !!d?.storage_path }; });
  // documents the office added itself (other types) stay visible
  for (const d of rows.filter((r) => !DOC_TYPES.some((t) => t.label === r.doc_type))) items.push({ id: d.id, doc_type: d.doc_type, required: false, file_name: d.file_name ?? "", status: d.status === "Returned" ? "Re-upload needed" : d.status === "Verified" ? "Verified" : "Under review", note: d.review_note ?? "", has_file: !!d.storage_path });
  return { application: { id: a.id, code: a.code, child: a.child }, items, max_mb: MAX_FILE / 1048576, accepted: "PDF, JPG or PNG" };
}

const SIGS: { mime: string; ext: string; ok: (b: Buffer) => boolean }[] = [
  { mime: "application/pdf", ext: "pdf", ok: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", ext: "png", ok: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: "jpg", ok: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
let bucketReady = false;
async function ensureBucket() {
  if (bucketReady) return;
  const { error } = await supabaseAdmin.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_FILE });
  if (error && !/already exists|duplicate/i.test(error.message)) throw new HttpError(503, "File storage is not available right now. Please try again later.");
  bucketReady = true;
}
const safeName = (n: string) => n.replace(/[^\w.\- ()]/g, "_").slice(0, 100) || "document";

export async function uploadDocument(inst: string, profile: string, appId: string, docType: string, fileName: string, mime: string, data: Buffer) {
  const a = await mine(inst, profile, appId);
  const type = DOC_TYPES.find((t) => t.label === docType)?.label;
  if (!type) throw new HttpError(400, "Choose which document this is.");
  if (!data?.length) throw new HttpError(400, "Choose a file to upload.");
  if (data.length > MAX_FILE) throw new HttpError(413, "The file is larger than 5 MB.");
  const sig = SIGS.find((s) => s.mime === mime);
  if (!sig || !sig.ok(data)) throw new HttpError(415, "Upload a PDF, JPG or PNG file.");
  await ensureBucket();
  const path = `${inst}/${a.id}/${randomUUID()}.${sig.ext}`;
  const up = await supabaseAdmin.storage.from(BUCKET).upload(path, data, { contentType: sig.mime, upsert: false });
  if (up.error) throw new HttpError(502, "Could not store the file. Please try again.");
  const cur = check(await supabaseAdmin.from("adm_documents").select("id, status, storage_path").eq("institution_id", inst).eq("application_id", a.id).eq("doc_type", type).order("created_at").limit(1).maybeSingle()) as { id: string; status: string; storage_path: string | null } | null;
  if (cur?.status === "Verified") { await supabaseAdmin.storage.from(BUCKET).remove([path]); throw new HttpError(409, "That document is already verified."); }
  const fields = { file_name: safeName(fileName), storage_path: path, mime: sig.mime, size_bytes: data.length, status: "Pending review", review_note: null, updated_at: new Date().toISOString() };
  if (cur) { check(await supabaseAdmin.from("adm_documents").update(fields).eq("id", cur.id).eq("institution_id", inst).select("id")); if (cur.storage_path) await supabaseAdmin.storage.from(BUCKET).remove([cur.storage_path]); }
  else check(await supabaseAdmin.from("adm_documents").insert({ institution_id: inst, application_id: a.id, doc_type: type, ...fields }).select("id"));
  return { ok: true };
}

/** A short-lived link to the family's own file. */
export async function documentLink(inst: string, profile: string, docId: string) {
  const d = check(await supabaseAdmin.from("adm_documents").select("storage_path, application_id").eq("id", z.string().uuid().parse(docId)).eq("institution_id", inst).maybeSingle()) as { storage_path: string | null; application_id: string } | null;
  if (!d) throw new HttpError(404, "Document not found.");
  await mine(inst, profile, d.application_id);
  if (!d.storage_path) throw new HttpError(404, "No file was uploaded for this document.");
  const s = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(d.storage_path, 300);
  if (s.error || !s.data) throw new HttpError(502, "Could not open the file.");
  return { url: s.data.signedUrl };
}

// ═════════════ assessment ═════════════
const reqVerifiedFor = async (inst: string, appId: string) => {
  const docs = check(await supabaseAdmin.from("adm_documents").select("doc_type, status").eq("institution_id", inst).eq("application_id", appId)) as { doc_type: string; status: string }[];
  return DOC_TYPES.filter((d) => d.required).every((r) => docs.some((d) => d.doc_type === r.label && d.status === "Verified"));
};
export async function assessment(inst: string, profile: string, appId: string) {
  const a = await mine(inst, profile, appId);
  const [slots, iv, prog] = await Promise.all([slotRows(inst, "Assessment"), check(await supabaseAdmin.from("adm_interviews").select("id, status, interview_date, interview_time, panel_name, recommendation, slot_id").eq("institution_id", inst).eq("application_id", a.id).order("created_at", { ascending: false }).limit(1)) as { id: string; status: string; interview_date: string; interview_time: string | null; panel_name: string; recommendation: string | null; slot_id: string | null }[], programmes(inst)]);
  const p = programmeFor(prog, a.class_sought, a.details?.stream);
  const cur = iv[0] ?? null;
  const [ready, off, school] = await Promise.all([reqVerifiedFor(inst, a.id), check(await supabaseAdmin.from("adm_offers").select("status").eq("institution_id", inst).eq("application_id", a.id).maybeSingle()) as { status: string } | null, supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle()]);
  return {
    application: { id: a.id, code: a.code, child: a.child, class_sought: a.class_sought }, school: (check(school) as { name: string }).name, ready, rule: p?.assessment ?? "", slots: slots.map((s) => ({ ...s, mine: cur?.slot_id === s.id && cur.status !== "Completed" })),
    booking: cur && cur.status !== "Completed" ? { date: cur.interview_date, time: cur.interview_time?.slice(0, 5) ?? "", panel: cur.panel_name } : null,
    result: cur?.status === "Completed" ? { done: true, date: cur.interview_date, outcome: off ? "Offer made" : a.status === "Waitlisted" ? "Waitlisted" : a.status === "Rejected" ? "Not selected" : "Result with the admissions office" } : { done: false, date: null, outcome: "" },
  };
}
export async function bookAssessment(inst: string, profile: string, appId: string, body: unknown) {
  const { slot_id } = z.object({ slot_id: z.string().uuid() }).strict().parse(body);
  const a = await mine(inst, profile, appId);
  if (!a.submitted_at) throw new HttpError(400, "Submit your application first.");
  if (!(await reqVerifiedFor(inst, a.id))) throw new HttpError(400, "Finish your documents first. You can book once every required document is verified.");
  const done = check(await supabaseAdmin.from("adm_interviews").select("id").eq("institution_id", inst).eq("application_id", a.id).eq("status", "Completed").limit(1)) as { id: string }[];
  if (done.length) throw new HttpError(409, "The assessment is already done.");
  const slot = await book(inst, profile, "Assessment", slot_id, a.id);
  // the Admissions portal's Test & Interview schedule is this same row
  const cur = check(await supabaseAdmin.from("adm_interviews").select("id").eq("institution_id", inst).eq("application_id", a.id).in("status", ["Scheduled", "Rescheduled"]).limit(1)) as { id: string }[];
  const f = { interview_date: slot.slot_date, interview_time: slot.slot_time, slot_id: slot.id };
  if (cur.length) check(await supabaseAdmin.from("adm_interviews").update({ ...f, status: "Rescheduled" }).eq("id", cur[0].id).eq("institution_id", inst).select("id"));
  else check(await supabaseAdmin.from("adm_interviews").insert({ institution_id: inst, application_id: a.id, panel_name: "Booked by family", ...f }).select("id"));
  return { ok: true };
}

// ═════════════ merit, offer and letter ═════════════
export async function meritAndOffer(inst: string, profile: string) {
  const apps = await myApps(inst, profile);
  const prog = await programmes(inst);
  const items = [];
  for (const a of apps.filter((x) => x.submitted_at)) {
    const p = programmeFor(prog, a.class_sought, a.details?.stream);
    const offer = check(await supabaseAdmin.from("adm_offers").select("id, status, accept_by, offered_on, category").eq("institution_id", inst).eq("application_id", a.id).maybeSingle()) as { id: string; status: string; accept_by: string; offered_on: string; category: string } | null;
    let rank: number | null = null; let state = "";
    if (p) { const m = await meritList(inst, p.name); const r = m.rows.find((x) => x.id === a.id); if (r && r.score !== null) { rank = r.rank; state = r.state; } }
    const fees = await admissionFees(inst, a.class_sought);
    items.push({ id: a.id, code: a.code, child: a.child, class_sought: a.class_sought, status: a.status, rank, state: offer ? offer.status : a.status === "Waitlisted" ? "Waitlisted" : a.status === "Rejected" ? "Not selected" : rank === null ? "Not yet ranked" : state, offer: offer ? { status: offer.status, accept_by: offer.accept_by, offered_on: offer.offered_on, category: offer.category, amount: (fees?.admission_fee ?? 0) + (fees?.caution ?? 0), expired: offer.status === "Offered" && offer.accept_by < today() } : null });
  }
  return { items };
}
export async function acceptOffer(inst: string, profile: string, appId: string) {
  const a = await mine(inst, profile, appId);
  const off = check(await supabaseAdmin.from("adm_offers").select("id, status, accept_by").eq("institution_id", inst).eq("application_id", a.id).maybeSingle()) as { id: string; status: string; accept_by: string } | null;
  if (!off) throw new HttpError(404, "There is no offer for this application yet.");
  if (off.status !== "Offered") throw new HttpError(409, off.status === "Expired" ? "This offer has expired." : "The offer is already accepted.");
  if (off.accept_by < today()) throw new HttpError(409, "The offer deadline has passed.");
  check(await supabaseAdmin.from("adm_offers").update({ status: "Accepted" }).eq("id", off.id).eq("institution_id", inst).select("id"));
  return { ok: true };
}
export async function letter(inst: string, profile: string) {
  const apps = await myApps(inst, profile);
  const school = check(await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle()) as { name: string };
  const set = check(await supabaseAdmin.from("adm_settings").select("letter_template").eq("institution_id", inst).maybeSingle()) as { letter_template: string | null } | null;
  const items = [];
  for (const a of apps) {
    const o = check(await supabaseAdmin.from("adm_offers").select("category, offered_on, accept_by, status").eq("institution_id", inst).eq("application_id", a.id).maybeSingle()) as { category: string; offered_on: string; accept_by: string; status: string } | null;
    if (!o) continue;
    const f = await admissionFees(inst, a.class_sought);
    const fee = `₹${((f?.admission_fee ?? 0) + (f?.caution ?? 0)).toLocaleString("en-IN")}`;
    const text = (set?.letter_template ?? DEFAULT_LETTER).replaceAll("{school}", school.name).replaceAll("{app}", a.code).replaceAll("{date}", o.offered_on).replaceAll("{child}", a.child).replaceAll("{class}", classOnly(a.class_sought)).replaceAll("{category}", o.category).replaceAll("{fee}", fee).replaceAll("{deadline}", o.accept_by);
    items.push({ id: a.id, code: a.code, child: a.child, status: o.status, text, admission_no: a.admission_no });
  }
  return { items };
}

// ═════════════ fees and payment ═════════════
export async function fees(inst: string, profile: string, appId?: string) {
  const apps = await myApps(inst, profile);
  const items = [];
  for (const a of apps) {
    if (appId && a.id !== appId) continue;
    const [f, form, off, pays] = await Promise.all([admissionFees(inst, a.class_sought), formFee(inst, a.class_sought), check(await supabaseAdmin.from("adm_offers").select("status, accept_by").eq("institution_id", inst).eq("application_id", a.id).maybeSingle()) as { status: string; accept_by: string } | null, check(await supabaseAdmin.from("adm_fee_payments").select("code, admission_fee, caution, mode, paid_on").eq("institution_id", inst).eq("application_id", a.id)) as { code: string; admission_fee: number; caution: number; mode: string; paid_on: string }[]]);
    const lines = [
      { key: "application_fee", label: "Application fee", amount: form, status: a.fee_status === "Paid" ? "Paid" : a.fee_status === "Waived" ? "Waived" : form === 0 ? "Not due" : "Due", paid_on: a.fee_paid_on, can_pay: a.fee_status === "Pending" && form > 0 },
      { key: "admission_fee", label: "Admission fee and caution deposit", amount: (f?.admission_fee ?? 0) + (f?.caution ?? 0), status: pays.length ? "Paid" : a.status === "Approved" ? "Due" : "Not yet due", paid_on: pays[0]?.paid_on ?? null, can_pay: a.status === "Approved" && !pays.length && (off?.status === "Offered" || off?.status === "Accepted") && (off?.accept_by ?? "9999") >= today(), by: off?.accept_by ?? null },
    ];
    items.push({ id: a.id, code: a.code, child: a.child, class_sought: a.class_sought, lines, receipts: [...(a.fee_status === "Paid" && (a.fee_amount ?? 0) > 0 ? [{ ref: `${a.code}-FORM`, label: "Application fee", amount: a.fee_amount ?? 0, mode: "", on: a.fee_paid_on }] : []), ...pays.map((p) => ({ ref: p.code, label: "Admission fee and caution deposit", amount: p.admission_fee + p.caution, mode: p.mode, on: p.paid_on }))] });
  }
  return { online: razorpayConfigured(), key_id: process.env.RAZORPAY_KEY_ID ?? "", items };
}

const PAY_MODES = ["UPI", "Card", "Net banking"] as const;
export async function payOrder(inst: string, profile: string, body: unknown) {
  const i = z.object({ application_id: z.string().uuid(), purpose: z.enum(["application_fee", "admission_fee"]) }).strict().parse(body);
  const a = await mine(inst, profile, i.application_id);
  let amount = 0;
  if (i.purpose === "application_fee") {
    if (a.fee_status !== "Pending") throw new HttpError(409, "The application fee is already settled.");
    amount = await formFee(inst, a.class_sought);
  } else {
    const off = check(await supabaseAdmin.from("adm_offers").select("status, accept_by").eq("institution_id", inst).eq("application_id", a.id).maybeSingle()) as { status: string; accept_by: string } | null;
    if (a.status !== "Approved" || !off || !["Offered", "Accepted"].includes(off.status)) throw new HttpError(409, "There is no offer waiting for payment.");
    if (off.accept_by < today()) throw new HttpError(409, "The offer deadline has passed.");
    const f = await admissionFees(inst, a.class_sought);
    amount = (f?.admission_fee ?? 0) + (f?.caution ?? 0);
  }
  if (amount <= 0) throw new HttpError(400, "There is nothing to pay.");
  if (!razorpayConfigured()) throw new HttpError(503, "Online payments are not set up for this school yet. Pay at the admissions office, they will record it here.");
  const order = await createOrder({ amountPaise: amount * 100, receipt: `${a.code}-${i.purpose === "application_fee" ? "F" : "A"}`, notes: { institution_id: inst, application_id: a.id, purpose: i.purpose } });
  check(await supabaseAdmin.from("adm_payment_orders").insert({ institution_id: inst, family_id: profile, application_id: a.id, purpose: i.purpose, amount, gateway_order_id: order.id }).select("id"));
  return { order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID ?? "" };
}

/** The gateway's signature settles the order; the amount and the application come from the order saved on the server. */
export async function payVerify(inst: string, profile: string, body: unknown) {
  const i = z.object({ razorpay_order_id: z.string().min(1).max(60), razorpay_payment_id: z.string().min(1).max(60), razorpay_signature: z.string().min(1).max(200), mode: z.enum(PAY_MODES).optional() }).strict().parse(body);
  const o = check(await supabaseAdmin.from("adm_payment_orders").select("id, application_id, purpose, status").eq("gateway_order_id", i.razorpay_order_id).eq("institution_id", inst).eq("family_id", profile).maybeSingle()) as { id: string; application_id: string; purpose: "application_fee" | "admission_fee"; status: string } | null;
  if (!o) throw new HttpError(404, "Payment not found.");
  if (!verifyCheckoutSignature(i.razorpay_order_id, i.razorpay_payment_id, i.razorpay_signature)) throw new HttpError(400, "The payment could not be verified. If money was taken it will be matched by the school.");
  if (o.status === "Paid") return { ok: true };
  const claimed = check(await supabaseAdmin.from("adm_payment_orders").update({ status: "Paid", gateway_payment_id: i.razorpay_payment_id, paid_at: new Date().toISOString() }).eq("id", o.id).eq("institution_id", inst).eq("family_id", profile).eq("status", "Created").select("id")) as { id: string }[];
  if (!claimed.length) return { ok: true };
  const mode = i.mode ?? "UPI";
  const a = await mine(inst, profile, o.application_id);
  if (o.purpose === "application_fee") {
    check(await supabaseAdmin.from("adm_applications").update({ fee_status: "Paid", fee_amount: await formFee(inst, a.class_sought), fee_mode: mode, fee_paid_on: today() }).eq("id", a.id).eq("institution_id", inst).eq("family_id", profile).eq("fee_status", "Pending").select("id"));
  } else {
    // the same admission-fee record the Admissions portal makes: the application becomes "Fee paid", ready for registration
    await collectAdmissionFee(inst, { application_id: a.id, mode }, profile);
    check(await supabaseAdmin.from("adm_offers").update({ status: "Fee paid" }).eq("institution_id", inst).eq("application_id", a.id).select("id"));
  }
  return { ok: true };
}

// ═════════════ messages ═════════════
export async function messages(inst: string, profile: string) {
  const rows = check(await supabaseAdmin.from("adm_messages").select("id, from_family, body, created_at, application_id, read_at").eq("institution_id", inst).eq("family_id", profile).order("created_at").limit(500)) as { id: string; from_family: boolean; body: string; created_at: string; application_id: string | null; read_at: string | null }[];
  const unread = rows.filter((r) => !r.from_family && !r.read_at).map((r) => r.id);
  if (unread.length) await supabaseAdmin.from("adm_messages").update({ read_at: new Date().toISOString() }).in("id", unread).eq("institution_id", inst).eq("family_id", profile);
  const apps = await myApps(inst, profile);
  return { applications: apps.map((a) => ({ id: a.id, code: a.code, child: a.child })), items: rows.map((r) => ({ id: r.id, mine: r.from_family, body: r.body, at: r.created_at, application_id: r.application_id })) };
}
export async function sendMessage(inst: string, profile: string, body: unknown) {
  const i = z.object({ body: z.string().trim().min(1, "Write a message.").max(1000), application_id: z.string().uuid().nullable().optional() }).strict().parse(body);
  if (i.application_id) await mine(inst, profile, i.application_id);
  check(await supabaseAdmin.from("adm_messages").insert({ institution_id: inst, family_id: profile, application_id: i.application_id ?? null, from_family: true, sender_id: profile, body: i.body }).select("id"));
  return { ok: true };
}

// ═════════════ notifications and search ═════════════
export async function notifications(inst: string, profile: string) {
  const apps = await myApps(inst, profile);
  const ids = apps.map((a) => a.id);
  const [msgs, docs, offers, orders, vis, asm, reads] = await Promise.all([
    check(await supabaseAdmin.from("adm_messages").select("id, body, created_at").eq("institution_id", inst).eq("family_id", profile).eq("from_family", false).order("created_at", { ascending: false }).limit(20)) as { id: string; body: string; created_at: string }[],
    ids.length ? (check(await supabaseAdmin.from("adm_documents").select("id, doc_type, review_note, updated_at").eq("institution_id", inst).in("application_id", ids).eq("status", "Returned")) as { id: string; doc_type: string; review_note: string | null; updated_at: string }[]) : [],
    ids.length ? (check(await supabaseAdmin.from("adm_offers").select("id, application_id, accept_by, created_at").eq("institution_id", inst).in("application_id", ids)) as { id: string; application_id: string; accept_by: string; created_at: string }[]) : [],
    check(await supabaseAdmin.from("adm_payment_orders").select("id, purpose, amount, paid_at").eq("institution_id", inst).eq("family_id", profile).eq("status", "Paid").order("paid_at", { ascending: false }).limit(10)) as { id: string; purpose: string; amount: number; paid_at: string }[],
    slotRows(inst, "Visit"), slotRows(inst, "Assessment"),
    check(await supabaseAdmin.from("applicant_notification_reads").select("key").eq("profile_id", profile)) as { key: string }[],
  ]);
  const read = new Set(reads.map((r) => r.key));
  const out: { key: string; kind: string; title: string; text: string; at: string; unread: boolean; href?: string }[] = [];
  for (const m of msgs) out.push({ key: `m:${m.id}`, kind: "M", title: "Message from the admissions office", text: m.body.slice(0, 120), at: m.created_at, unread: false });
  for (const d of docs) out.push({ key: `d:${d.id}:${d.updated_at}`, kind: "M", title: `Please re-upload your ${d.doc_type.toLowerCase()}`, text: d.review_note ?? "The document could not be accepted.", at: d.updated_at, unread: false });
  for (const o of offers) { const a = apps.find((x) => x.id === o.application_id); out.push({ key: `o:${o.id}`, kind: "O", title: "Your offer letter is ready", text: `${a?.child ?? ""} · accept by ${o.accept_by}`, at: o.created_at, unread: false }); }
  for (const p of orders) out.push({ key: `p:${p.id}`, kind: "✓", title: p.purpose === "application_fee" ? "Application fee received" : "Admission fee received", text: `₹${p.amount.toLocaleString("en-IN")} paid`, at: p.paid_at, unread: false });
  for (const a of apps.filter((x) => x.submitted_at)) out.push({ key: `a:${a.id}`, kind: "✓", title: "Application received", text: `${a.code}${a.fee_status === "Paid" ? ` · fee ₹${(a.fee_amount ?? 0).toLocaleString("en-IN")} paid` : ""}`, at: a.submitted_at as string, unread: false });
  if (asm.length && apps.some((a) => a.submitted_at)) out.push({ key: `s:${asm[0].date}:${asm[asm.length - 1].date}`, kind: "E", title: "Assessment slots are open", text: `${asm[0].date} to ${asm[asm.length - 1].date}`, at: new Date().toISOString(), unread: false });
  if (vis.length) out.push({ key: `v:${vis[0].date}`, kind: "P", title: "Campus visits available", text: `Next: ${vis[0].date}, ${vis[0].time}`, at: new Date().toISOString(), unread: false });
  const links: Record<string, string> = {"m:":"/applicant/messages/messages","d:":"/applicant/documents/upload-documents","o:":"/applicant/application/application?tab=merit-and-offer","p:":"/applicant/fees/fees-and-payment?tab=receipts","a:":"/applicant/dashboard/application-status","s:":"/applicant/assessment/assessment","v:":"/applicant/enquiry/enquiry-and-visit?tab=campus-visit"};
  const items = out.sort((a, b) => b.at.localeCompare(a.at)).map((n) => ({ ...n, href: links[n.key.slice(0, 2)] ?? "/applicant", unread: !read.has(n.key) }));
  return { items, unread: items.filter((n) => n.unread).length };
}
export async function markRead(profile: string, body: unknown) {
  const { keys } = z.object({ keys: z.array(z.string().max(80)).max(200) }).strict().parse(body);
  if (keys.length) check(await supabaseAdmin.from("applicant_notification_reads").upsert(keys.map((key) => ({ profile_id: profile, key })), { onConflict: "profile_id,key" }).select("key"));
  return { ok: true };
}
export async function search(inst: string, profile: string, q: unknown) {
  const needle = z.string().trim().min(2).max(60).parse(q).toLowerCase();
  const apps = await myApps(inst, profile);
  const hits: { key: string; title: string; subtitle: string; href: string }[] = [];
  for (const a of apps) if (`${a.code} ${a.child}`.toLowerCase().includes(needle)) hits.push({ key: `a:${a.id}`, title: `${a.child} · ${a.code}`, subtitle: "Application", href: "/applicant/dashboard/application-status" });
  for (const d of DOC_TYPES) if (d.label.toLowerCase().includes(needle)) hits.push({ key: `d:${d.label}`, title: d.label, subtitle: "Document", href: "/applicant/documents/upload-documents" });
  return { hits: hits.slice(0, 8) };
}

// ═════════════ the office's side (called from the Admissions portal router) ═════════════
export async function staffThreads(inst: string) {
  const rows = check(await supabaseAdmin.from("adm_messages").select("id, family_id, from_family, body, created_at, enquiry_id, application_id, read_at").eq("institution_id", inst).order("created_at", { ascending: false }).limit(3000)) as { id: string; family_id: string; from_family: boolean; body: string; created_at: string; enquiry_id: string | null; application_id: string | null; read_at: string | null }[];
  const ids = [...new Set(rows.map((r) => r.family_id))];
  const people = ids.length ? (check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, phone").eq("institution_id", inst).in("id", ids)) as { id: string; first_name: string; last_name: string; phone: string | null }[]) : [];
  return { items: ids.map((id) => { const mine = rows.filter((r) => r.family_id === id); const p = people.find((x) => x.id === id); return { family_id: id, name: nameOf(p ?? null), mobile: p?.phone ?? null, last: mine[0].body, at: mine[0].created_at, awaiting: mine[0].from_family, messages: mine.slice(0, 50).reverse().map((m) => ({ id: m.id, mine: !m.from_family, body: m.body, at: m.created_at, enquiry_id: m.enquiry_id })) }; }) };
}
export async function staffReply(inst: string, staff: string, body: unknown) {
  const i = z.object({ family_id: z.string().uuid(), body: z.string().trim().min(1, "Write a reply.").max(1000), enquiry_id: z.string().uuid().nullable().optional() }).strict().parse(body);
  const fam = check(await supabaseAdmin.from("user_profiles").select("id").eq("id", i.family_id).eq("institution_id", inst).maybeSingle());
  if (!fam) throw new HttpError(404, "Family not found.");
  if (i.enquiry_id) { const e = check(await supabaseAdmin.from("adm_enquiries").select("id").eq("id", i.enquiry_id).eq("institution_id", inst).eq("family_id", i.family_id).maybeSingle()); if (!e) throw new HttpError(404, "Enquiry not found."); }
  check(await supabaseAdmin.from("adm_messages").insert({ institution_id: inst, family_id: i.family_id, enquiry_id: i.enquiry_id ?? null, from_family: false, sender_id: staff, body: i.body }).select("id"));
  return { ok: true };
}
export async function staffSlots(inst: string) {
  const rows = check(await supabaseAdmin.from("adm_slots").select("id, kind, slot_date, slot_time, capacity").eq("institution_id", inst).gte("slot_date", today()).order("slot_date").order("slot_time").limit(500)) as { id: string; kind: string; slot_date: string; slot_time: string; capacity: number }[];
  const used = new Map<string, number>();
  if (rows.length) for (const b of check(await supabaseAdmin.from("adm_slot_bookings").select("slot_id").eq("institution_id", inst).eq("status", "Booked").in("slot_id", rows.map((r) => r.id))) as { slot_id: string }[]) used.set(b.slot_id, (used.get(b.slot_id) ?? 0) + 1);
  return { items: rows.map((r) => ({ id: r.id, kind: r.kind, date: r.slot_date, time: r.slot_time.slice(0, 5), capacity: r.capacity, booked: used.get(r.id) ?? 0 })) };
}
export async function staffAddSlots(inst: string, staff: string, body: unknown) {
  const i = z.object({ kind: z.enum(["Visit", "Assessment"]), dates: z.array(date10).min(1).max(31), times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1).max(12), capacity: z.number().int().min(1).max(200) }).strict().parse(body);
  const rows = i.dates.flatMap((d) => i.times.map((t) => ({ institution_id: inst, kind: i.kind, slot_date: d, slot_time: t, capacity: i.capacity, created_by: staff }))).filter((r) => r.slot_date >= today());
  if (!rows.length) throw new HttpError(400, "Choose dates that are not in the past.");
  check(await supabaseAdmin.from("adm_slots").upsert(rows, { onConflict: "institution_id,kind,slot_date,slot_time", ignoreDuplicates: true }).select("id"));
  return { added: rows.length };
}
export async function staffDeleteSlot(inst: string, id: string) {
  const row = check(await supabaseAdmin.from("adm_slots").delete().eq("id", z.string().uuid().parse(id)).eq("institution_id", inst).select("id").maybeSingle());
  if (!row) throw new HttpError(404, "Slot not found.");
  return { ok: true };
}
export async function staffReturnDocument(inst: string, docId: string, body: unknown) {
  const { note } = z.object({ note: z.string().trim().min(2, "Say what to fix.").max(200) }).strict().parse(body);
  const row = check(await supabaseAdmin.from("adm_documents").update({ status: "Returned", review_note: note, updated_at: new Date().toISOString() }).eq("id", z.string().uuid().parse(docId)).eq("institution_id", inst).select("id").maybeSingle());
  if (!row) throw new HttpError(404, "Document not found.");
  return { ok: true };
}

export { tail10 };
