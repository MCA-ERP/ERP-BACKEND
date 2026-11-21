import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { createOffer } from "./admission-extra.service";
import { HttpError } from "../../lib/http-error";

/**
 * The front desk of a school: enquiries, visitors, appointments, calls and post. One small config per register keeps the
 * five alike: what is stored, how it is checked, how it is sorted, and which status values it may take.
 * Every query is limited to the signed-in school.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-03.");
const time = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Use a time like 09:30.");
const opt = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.literal(""), z.null()]).optional();
const txt = (max: number) => z.string().trim().max(max);
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === "" ? null : v]));

interface Reg {
  table: string;
  select: string;
  order: string[];
  create: z.ZodTypeAny;
  patch: z.ZodTypeAny;
  filters: string[];
}

const REGISTERS: Record<string, Reg> = {
  enquiries: {
    table: "fo_enquiries",
    select: "id, code, visitor, purpose, mobile, assigned_to, enquiry_date, next_followup, status, created_at, staff:assigned_to(first_name, last_name)",
    order: ["enquiry_date", "created_at"],
    filters: ["status"],
    create: z.object({ visitor: txt(150).min(1, "Enter the visitor's name."), purpose: txt(60).min(1), mobile: opt(txt(30)), assigned_to: opt(z.string().uuid()), enquiry_date: date.optional(), next_followup: opt(date) }).strict(),
    patch: z.object({ status: z.enum(["Open", "Follow-up", "Converted", "Closed"]), next_followup: opt(date) }).partial().strict(),
  },
  visitors: {
    table: "fo_visitors",
    select: "id, visit_date, visitor, purpose, details, meeting, id_proof, in_time, out_time, created_at",
    order: ["visit_date", "in_time"],
    filters: [],
    create: z.object({ visit_date: date.optional(), visitor: txt(150).min(1, "Enter the visitor's name."), purpose: txt(60).min(1), details: opt(txt(300)), meeting: opt(txt(150)), id_proof: opt(txt(80)), in_time: opt(time), out_time: opt(time) }).strict(),
    patch: z.object({ out_time: opt(time) }).partial().strict(),
  },
  appointments: {
    table: "fo_appointments",
    select: "id, code, with_whom, visitor, purpose, appt_date, appt_time, status, created_at",
    order: ["appt_date", "appt_time"],
    filters: ["status"],
    create: z.object({ with_whom: txt(80).min(1), visitor: txt(150).min(1, "Enter the visitor's name."), purpose: txt(80).min(1), appt_date: date, appt_time: opt(time) }).strict(),
    patch: z.object({ status: z.enum(["Pending", "Confirmed", "Completed", "Cancelled"]) }).partial().strict(),
  },
  calls: {
    table: "fo_calls",
    select: "id, code, direction, caller, number, about, handled_by, duration_min, call_date, follow_up, created_at",
    order: ["call_date", "created_at"],
    filters: ["direction", "follow_up"],
    create: z.object({ direction: z.enum(["Incoming", "Outgoing"]), caller: txt(150).min(1), number: opt(txt(30)), about: txt(100).min(1), handled_by: opt(txt(150)), duration_min: z.number().int().min(0).max(600).optional(), call_date: date.optional(), follow_up: z.enum(["Not needed", "Callback due", "Done"]).optional() }).strict(),
    patch: z.object({ follow_up: z.enum(["Not needed", "Callback due", "Done"]) }).partial().strict(),
  },
  post: {
    table: "fo_post",
    select: "id, code, direction, party, post_type, courier, handled_by, post_date, status, created_at",
    order: ["post_date", "created_at"],
    filters: ["direction", "status"],
    create: z.object({ direction: z.enum(["Incoming", "Outgoing"]), party: txt(150).min(1), post_type: txt(40).min(1), courier: opt(txt(60)), handled_by: opt(txt(150)), post_date: date.optional(), status: z.enum(["Delivered", "In transit", "Pending dispatch"]).optional() }).strict(),
    patch: z.object({ status: z.enum(["Delivered", "In transit", "Pending dispatch"]) }).partial().strict(),
  },
  complaints: {
    table: "fo_complaints",
    select: "id, code, raised_by, about, details, assigned_to, raised_on, status, created_at, staff:assigned_to(first_name, last_name)",
    order: ["raised_on", "created_at"],
    filters: ["status"],
    create: z.object({ raised_by: txt(150).min(1, "Enter who raised it."), about: txt(60).min(1), details: txt(500).min(2, "Say what the complaint is."), assigned_to: opt(z.string().uuid()), raised_on: date.optional() }).strict(),
    patch: z.object({ status: z.enum(["Open", "In progress", "Resolved"]) }).partial().strict(),
  },
  "gate-passes": {
    table: "fo_gate_passes",
    select: "id, code, kind, person_name, class_dept, reason, out_time, picked_up_by, pass_date, status, created_at, staff:decided_by(first_name, last_name)",
    order: ["pass_date", "created_at"],
    filters: ["kind", "status"],
    create: z.object({ kind: z.enum(["Student", "Staff"]), person_name: txt(150).min(1), class_dept: opt(txt(60)), reason: txt(300).min(2, "Give a reason."), out_time: opt(time), picked_up_by: opt(txt(150)), pass_date: date.optional() }).strict(),
    patch: z.object({ status: z.enum(["Pending approval", "Expected", "Left", "Out", "Returned", "Rejected"]), out_time: opt(time) }).partial().strict(),
  },
  tickets: {
    table: "hd_tickets",
    select: "id, code, subject, category, raised_by_name, raised_by_kind, priority, assigned_name, status, rating, first_reply_at, resolved_at, created_at",
    order: ["created_at"],
    filters: ["status", "raised_by_kind"],
    create: z.object({ subject: txt(250).min(3, "Write the subject."), category: txt(80).min(1), raised_by_name: txt(150).min(1), raised_by_kind: z.enum(["Parent", "Teacher", "Staff"]), priority: z.enum(["High", "Normal", "Low"]).optional(), assigned_name: opt(txt(150)) }).strict(),
    patch: z.object({ status: z.enum(["Open", "In progress", "Waiting on you", "Resolved"]), priority: z.enum(["High", "Normal", "Low"]), assigned_name: opt(txt(150)), rating: z.number().int().min(1).max(5) }).partial().strict(),
  },
  "adm-enquiries": {
    table: "adm_enquiries",
    select: "id, code, child, class_sought, parent_name, mobile, source, counsellor, enquiry_date, status, created_at, staff:counsellor(first_name, last_name)",
    order: ["enquiry_date", "created_at"],
    filters: ["status"],
    create: z.object({ child: txt(150).min(1, "Enter the child's name."), class_sought: txt(30).min(1), parent_name: txt(150).min(1, "Enter the parent's name."), mobile: opt(txt(30)), source: txt(40).min(1), counsellor: opt(z.string().uuid()), enquiry_date: date.optional() }).strict(),
    patch: z.object({ status: z.enum(["New", "Follow-up", "Converted", "Closed"]) }).partial().strict(),
  },
  "adm-applications": {
    table: "adm_applications",
    select: "id, code, child, class_sought, parent_name, mobile, source, details, enquiry_id, applied_on, status, level, level_since, admission_no, created_at",
    order: ["applied_on", "created_at"],
    filters: ["status", "source"],
    create: z.object({ child: txt(150).min(1, "Enter the child's name."), class_sought: txt(30).min(1), parent_name: txt(150).min(1, "Enter the parent's name."), mobile: opt(txt(30)), source: txt(40).min(1), details: z.record(z.string(), z.unknown()).optional(), applied_on: date.optional() }).strict(),
    patch: z.object({ status: z.enum(["Under review", "Approved", "Fee paid", "Registered", "Allocated", "Returned", "Rejected", "Waitlisted"]) }).partial().strict(),
  },
  "adm-documents": {
    table: "adm_documents",
    select: "id, application_id, doc_type, file_name, status, created_at, app:application_id(code, child)",
    order: ["created_at"],
    filters: ["status"],
    create: z.object({ application_id: z.string().uuid(), doc_type: txt(60).min(1), file_name: opt(txt(150)) }).strict(),
    patch: z.object({ status: z.enum(["Pending review", "Verified", "Returned"]) }).partial().strict(),
  },
  "adm-tests": {
    table: "adm_tests",
    select: "id, name, subjects, max_marks, test_date, test_time, venue, status, created_at",
    order: ["test_date", "created_at"],
    filters: ["status"],
    create: z.object({ name: txt(120).min(2), subjects: txt(200).min(2, "List the subjects, like English, Maths."), max_marks: z.number().int().min(1).max(1000), test_date: date, test_time: opt(time), venue: opt(txt(80)), status: z.enum(["Draft", "Scheduled", "Completed"]).optional() }).strict(),
    patch: z.object({ status: z.enum(["Draft", "Scheduled", "Completed"]), test_date: date, test_time: opt(time), venue: opt(txt(80)) }).partial().strict(),
  },
  "adm-panels": {
    table: "adm_panels",
    select: "id, name, for_classes, members, status, created_at",
    order: ["name"],
    filters: [],
    create: z.object({ name: txt(60).min(1), for_classes: txt(80).min(1), members: txt(200).min(1) }).strict(),
    patch: z.object({ status: z.enum(["Active", "Inactive"]), members: txt(200).min(1) }).partial().strict(),
  },
  "adm-interviews": {
    table: "adm_interviews",
    select: "id, application_id, panel_name, interview_date, interview_time, status, created_at, app:application_id(code, child, class_sought, parent_name)",
    order: ["interview_date", "interview_time"],
    filters: ["status"],
    create: z.object({ application_id: z.string().uuid(), panel_name: txt(120).min(1), interview_date: date, interview_time: opt(time) }).strict(),
    patch: z.object({ status: z.enum(["Scheduled", "Completed", "Rescheduled"]), interview_date: date, interview_time: opt(time) }).partial().strict(),
  },
  "adm-fee-payments": {
    table: "adm_fee_payments",
    select: "id, application_id, code, admission_fee, caution, mode, paid_on, status, created_at, app:application_id(code, child, class_sought)",
    order: ["paid_on", "created_at"],
    filters: [],
    create: z.object({}).strict(),
    patch: z.object({}).strict(),
  },
};

const reg = (name: string): Reg => {
  const r = REGISTERS[name];
  if (!r) throw new HttpError(404, "Unknown register.");
  return r;
};

const staffName = (s: unknown) => { const v = Array.isArray(s) ? s[0] : s; const o = v as { first_name?: string; last_name?: string } | null; return o ? `${o.first_name ?? ""} ${o.last_name ?? ""}`.trim() : null; };
const shape = (_name: string, row: Record<string, unknown>) => {
  let out = row;
  if ("staff" in out) out = { ...out, assigned_name: staffName(out.staff), staff: undefined };
  if ("app" in out) { const a = Array.isArray(out.app) ? out.app[0] : out.app; out = { ...out, app: a ?? null }; }
  return out;
};

export async function list(inst: string, name: string, query: Record<string, string | undefined>) {
  const r = reg(name);
  let q = supabaseAdmin.from(r.table).select(r.select).eq("institution_id", inst);
  for (const f of r.filters) if (query[f]) q = q.eq(f, query[f]);
  for (const o of r.order) q = q.order(o, { ascending: false, nullsFirst: false });
  const rows = check(await q.limit(2000)) as unknown as Record<string, unknown>[];
  const out = rows.map((x) => shape(name, x));
  const term = (query.search ?? "").trim().toLowerCase();
  return { items: term ? out.filter((x) => JSON.stringify(Object.values(x)).toLowerCase().includes(term)) : out };
}

export async function create(inst: string, name: string, body: unknown, actor?: string) {
  const r = reg(name);
  const input = r.create.parse(body) as Record<string, unknown>;
  for (const k of ["assigned_to", "counsellor"]) if (input[k]) await assertStaff(inst, String(input[k]));
  const row = check(await supabaseAdmin.from(r.table).insert({ ...clean(input), institution_id: inst, created_by: actor ?? null }).select(r.select).single()) as unknown as Record<string, unknown>;
  return shape(name, row);
}

export async function patch(inst: string, name: string, id: string, body: unknown, actor?: string) {
  const r = reg(name);
  const input = clean(r.patch.parse(body) as Record<string, unknown>);
  if (!Object.keys(input).length) throw new HttpError(400, "Nothing to change.");
  const now = new Date().toISOString();
  if (name === "complaints" && input.status) input.resolved_at = input.status === "Resolved" ? now : null;
  if (name === "tickets" && input.status) {
    input.resolved_at = input.status === "Resolved" ? now : null;
    if (input.status === "In progress" || input.status === "Waiting on you") {
      const cur = check(await supabaseAdmin.from("hd_tickets").select("first_reply_at").eq("id", id).eq("institution_id", inst).maybeSingle()) as { first_reply_at: string | null } | null;
      if (cur && !cur.first_reply_at) input.first_reply_at = now;
    }
  }
  if (name === "gate-passes" && input.status) {
    input.decided_by = actor ?? null;
    if ((input.status === "Left" || input.status === "Out") && !input.out_time) input.out_time = new Date().toTimeString().slice(0, 5);
  }
  const row = check(await supabaseAdmin.from(r.table).update(input).eq("id", id).eq("institution_id", inst).select(r.select).maybeSingle()) as unknown as Record<string, unknown> | null;
  if (!row) throw new HttpError(404, "Record not found.");
  return shape(name, row);
}

/** Logs a follow-up on an enquiry: the note is kept, the next date is set and the enquiry is marked Follow-up. */
export async function logFollowup(inst: string, id: string, body: unknown, actor?: string) {
  const input = z.object({ note: txt(500).min(2, "Write what was said."), next_followup: opt(date) }).strict().parse(body);
  const enquiry = check(await supabaseAdmin.from("fo_enquiries").select("id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { status: string } | null;
  if (!enquiry) throw new HttpError(404, "Enquiry not found.");
  check(await supabaseAdmin.from("fo_enquiry_followups").insert({ enquiry_id: id, note: input.note, next_followup: input.next_followup || null, logged_by: actor ?? null }).select("id"));
  const next = enquiry.status === "Converted" || enquiry.status === "Closed" ? {} : { status: "Follow-up" };
  return patchRaw(inst, id, { ...next, next_followup: input.next_followup || null });
}

async function patchRaw(inst: string, id: string, update: Record<string, unknown>) {
  const r = REGISTERS.enquiries;
  const row = check(await supabaseAdmin.from(r.table).update(update).eq("id", id).eq("institution_id", inst).select(r.select).single()) as unknown as Record<string, unknown>;
  return shape("enquiries", row);
}

export async function followups(inst: string, id: string) {
  const own = check(await supabaseAdmin.from("fo_enquiries").select("id").eq("id", id).eq("institution_id", inst).maybeSingle());
  if (!own) throw new HttpError(404, "Enquiry not found.");
  return check(await supabaseAdmin.from("fo_enquiry_followups").select("id, note, next_followup, created_at, staff:logged_by(first_name, last_name)").eq("enquiry_id", id).order("created_at", { ascending: false })) as unknown as Record<string, unknown>[];
}

async function assertStaff(inst: string, profileId: string) {
  const ok = check(await supabaseAdmin.from("user_profiles").select("id").eq("id", profileId).eq("institution_id", inst).maybeSingle());
  if (!ok) throw new HttpError(400, "Choose someone from this school.");
}

/** The people an enquiry can be assigned to. */
export async function staffChoices(inst: string) {
  const rows = check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, roles:role_id(name, display_name)").eq("institution_id", inst).order("first_name").limit(500)) as unknown as { id: string; first_name: string; last_name: string; roles: { name: string; display_name: string } | { name: string; display_name: string }[] | null }[];
  return rows.map((p) => ({ id: p.id, name: `${p.first_name} ${p.last_name}`.trim(), role: (Array.isArray(p.roles) ? p.roles[0] : p.roles)?.display_name ?? "", kind: (Array.isArray(p.roles) ? p.roles[0] : p.roles)?.name ?? "" })).filter((p) => !["Parent", "Student"].includes(p.kind));
}

/** Turns an admission enquiry into an application and marks the enquiry Converted. */
export async function convertEnquiry(inst: string, id: string, actor?: string) {
  const e = check(await supabaseAdmin.from("adm_enquiries").select("id, child, class_sought, parent_name, mobile, source, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { child: string; class_sought: string; parent_name: string; mobile: string | null; source: string; status: string } | null;
  if (!e) throw new HttpError(404, "Enquiry not found.");
  if (e.status === "Converted") throw new HttpError(409, "That enquiry was already converted.");
  const app = check(await supabaseAdmin.from("adm_applications").insert({ institution_id: inst, child: e.child, class_sought: e.class_sought, parent_name: e.parent_name, mobile: e.mobile, source: e.source, enquiry_id: id, created_by: actor ?? null }).select(REGISTERS["adm-applications"].select).single()) as unknown as Record<string, unknown>;
  check(await supabaseAdmin.from("adm_enquiries").update({ status: "Converted" }).eq("id", id).eq("institution_id", inst).select("id"));
  return app;
}

// ═════════════ help desk categories and reply times ═════════════
const CATEGORY_DEFAULTS: [string, "Parents" | "Staff", string, number][] = [
  ["Fees and payments", "Parents", "Accounts office", 24], ["Transport", "Parents", "Transport office", 24], ["Academics and homework", "Parents", "Class teacher", 48],
  ["Portal login and app", "Parents", "IT support", 8], ["Certificates and documents", "Parents", "Front office", 48], ["Hostel and mess", "Parents", "Hostel office", 24],
  ["Admissions", "Parents", "Admissions office", 48], ["Other", "Parents", "Front office", 72],
  ["IT and devices", "Staff", "IT support", 8], ["Maintenance and repairs", "Staff", "Estate team", 48], ["Classroom supplies", "Staff", "Estate team", 48],
  ["HR and payroll", "Staff", "HR office", 48], ["Portal access", "Staff", "IT support", 8], ["Leave and attendance", "Staff", "HR office", 24], ["Other staff requests", "Staff", "Front office", 72],
];

export async function categories(inst: string) {
  const cols = "name, raised_by, handled_by, reply_hours, sort_order";
  let rows = check(await supabaseAdmin.from("hd_categories").select(cols).eq("institution_id", inst).order("sort_order")) as { name: string; raised_by: string; handled_by: string; reply_hours: number; sort_order: number }[];
  if (!rows.length) {
    rows = check(await supabaseAdmin.from("hd_categories").upsert(CATEGORY_DEFAULTS.map(([name, raised_by, handled_by, reply_hours], i) => ({ institution_id: inst, name, raised_by, handled_by, reply_hours, sort_order: i + 1 })), { onConflict: "institution_id,name" }).select(cols)) as typeof rows;
    rows.sort((a, b) => a.sort_order - b.sort_order);
  }
  return rows;
}

export async function setReplyHours(inst: string, name: string, body: unknown) {
  const { reply_hours } = z.object({ reply_hours: z.number().int().min(1).max(720) }).strict().parse(body);
  const row = check(await supabaseAdmin.from("hd_categories").update({ reply_hours }).eq("institution_id", inst).eq("name", name).select("name, reply_hours").maybeSingle());
  if (!row) throw new HttpError(404, "Category not found.");
  return row;
}

// ═════════════ admission processing ═════════════
const FEE_DEFAULTS: [string, number, number, number][] = [["Nursery – UKG", 25000, 10000, 750], ["Class 1 – 5", 25000, 10000, 1000], ["Class 6 – 10", 25000, 10000, 1000], ["Class 11", 25000, 10000, 1500]];
const LEVEL_DEFAULTS: [number, string, string, number, string][] = [[1, "Document verifier", "Admissions counsellor on duty", 24, "Admissions head"], [2, "Admissions head", "Admissions head", 48, "Vice principal"], [3, "Principal", "Principal", 48, "Chairman"]];

export async function feeSetup(inst: string) {
  let rows = check(await supabaseAdmin.from("adm_fee_setup").select("class_group, admission_fee, caution, form_fee, sort_order").eq("institution_id", inst).order("sort_order")) as { class_group: string; admission_fee: number; caution: number; form_fee: number; sort_order: number }[];
  if (!rows.length) rows = check(await supabaseAdmin.from("adm_fee_setup").upsert(FEE_DEFAULTS.map(([class_group, admission_fee, caution, form_fee], i) => ({ institution_id: inst, class_group, admission_fee, caution, form_fee, sort_order: i + 1 })), { onConflict: "institution_id,class_group" }).select("class_group, admission_fee, caution, form_fee, sort_order")) as typeof rows;
  const set = check(await supabaseAdmin.from("adm_fee_settings").select("pay_within_days, online_payment").eq("institution_id", inst).maybeSingle()) as { pay_within_days: number; online_payment: boolean } | null;
  return { rows: rows.sort((a, b) => a.sort_order - b.sort_order), pay_within_days: set?.pay_within_days ?? 7, online_payment: set?.online_payment ?? true };
}

export async function saveFeeSetup(inst: string, body: unknown) {
  const input = z.object({ rows: z.array(z.object({ class_group: txt(40), admission_fee: z.number().int().min(0).max(10_000_000), caution: z.number().int().min(0).max(10_000_000), form_fee: z.number().int().min(0).max(1_000_000) })).min(1).max(20), pay_within_days: z.number().int().min(1).max(90), online_payment: z.boolean() }).strict().parse(body);
  for (const [i, r] of input.rows.entries()) check(await supabaseAdmin.from("adm_fee_setup").upsert({ institution_id: inst, ...r, sort_order: i + 1 }, { onConflict: "institution_id,class_group" }).select("class_group"));
  check(await supabaseAdmin.from("adm_fee_settings").upsert({ institution_id: inst, pay_within_days: input.pay_within_days, online_payment: input.online_payment }, { onConflict: "institution_id" }).select("institution_id"));
  return feeSetup(inst);
}

const CLASS_ORDER = ["Nursery", "LKG", "UKG", ...Array.from({ length: 12 }, (_, i) => "Class " + (i + 1))];
const groupOf = (cls: string) => { const i = CLASS_ORDER.indexOf(cls.split(" ").slice(0, 2).join(" ").replace(/^(Class \d+).*$/, "$1")); return i < 0 ? 1 : i <= 2 ? 0 : i <= 7 ? 1 : i <= 12 ? 2 : 3; };

/** Takes the admission fee for an approved application: the amounts come from the fee setup, the status becomes Fee paid. */
export async function collectAdmissionFee(inst: string, body: unknown, actor?: string) {
  const { application_id, mode } = z.object({ application_id: z.string().uuid(), mode: z.enum(["UPI", "Card", "Cash", "Cheque", "Net banking"]) }).strict().parse(body);
  const app = check(await supabaseAdmin.from("adm_applications").select("id, class_sought, status").eq("id", application_id).eq("institution_id", inst).maybeSingle()) as { class_sought: string; status: string } | null;
  if (!app) throw new HttpError(404, "Application not found.");
  if (app.status !== "Approved") throw new HttpError(400, "The admission fee is taken once the application is approved.");
  const fees = (await feeSetup(inst)).rows;
  const fee = fees[Math.min(groupOf(app.class_sought), fees.length - 1)];
  const pay = check(await supabaseAdmin.from("adm_fee_payments").insert({ institution_id: inst, application_id, admission_fee: fee.admission_fee, caution: fee.caution, mode, created_by: actor ?? null }).select(REGISTERS["adm-fee-payments"].select).single()) as unknown as Record<string, unknown>;
  check(await supabaseAdmin.from("adm_applications").update({ status: "Fee paid" }).eq("id", application_id).eq("institution_id", inst).select("id"));
  return shape("fee", pay);
}

/** Gives a paid application its admission number, like TIR/2027/1001, and marks it Registered. */
export async function generateAdmissionNumber(inst: string, id: string) {
  const app = check(await supabaseAdmin.from("adm_applications").select("id, status, admission_no").eq("id", id).eq("institution_id", inst).maybeSingle()) as { status: string; admission_no: string | null } | null;
  if (!app) throw new HttpError(404, "Application not found.");
  if (app.admission_no) throw new HttpError(409, "It already has an admission number.");
  if (app.status !== "Fee paid") throw new HttpError(400, "Take the admission fee first.");
  const school = check(await supabaseAdmin.from("institutions").select("code").eq("id", inst).maybeSingle()) as { code: string } | null;
  const used = check(await supabaseAdmin.from("adm_applications").select("admission_no").eq("institution_id", inst).not("admission_no", "is", null)) as { admission_no: string }[];
  const next = Math.max(1000, ...used.map((u) => Number(u.admission_no.split("/").pop()) || 0)) + 1;
  const no = `${(school?.code ?? "ADM").slice(0, 6)}/${new Date().getFullYear() + 1}/${next}`;
  return check(await supabaseAdmin.from("adm_applications").update({ admission_no: no, status: "Registered" }).eq("id", id).eq("institution_id", inst).select(REGISTERS["adm-applications"].select).single());
}

export async function approvalLevels(inst: string) {
  let rows = check(await supabaseAdmin.from("adm_approval_levels").select("level, role, person, hours, escalate_to").eq("institution_id", inst).order("level")) as { level: number; role: string; person: string; hours: number; escalate_to: string }[];
  if (!rows.length) rows = check(await supabaseAdmin.from("adm_approval_levels").upsert(LEVEL_DEFAULTS.map(([level, role, person, hours, escalate_to]) => ({ institution_id: inst, level, role, person, hours, escalate_to })), { onConflict: "institution_id,level" }).select("level, role, person, hours, escalate_to")) as typeof rows;
  return rows.sort((a, b) => a.level - b.level);
}

/** Moves an application along the approval chain. Level 3 approving makes the offer (status Approved). */
export async function advance(inst: string, id: string, body: unknown) {
  const { action } = z.object({ action: z.enum(["approve", "send-back", "waitlist", "reject", "correct"]) }).strict().parse(body);
  const app = check(await supabaseAdmin.from("adm_applications").select("id, status, level").eq("id", id).eq("institution_id", inst).maybeSingle()) as { status: string; level: number } | null;
  if (!app) throw new HttpError(404, "Application not found.");
  const now = new Date().toISOString();
  let update: Record<string, unknown>;
  if (action === "correct") { if (app.status !== "Returned") throw new HttpError(400, "Only a returned application can be marked corrected."); update = { status: "Under review", level: 1, level_since: now }; }
  else {
    if (app.status !== "Under review") throw new HttpError(400, "That application is not waiting for a decision.");
    update = action === "approve" ? (app.level >= 3 ? { status: "Approved" } : { level: app.level + 1, level_since: now }) : action === "send-back" ? { status: "Returned" } : action === "waitlist" ? { status: "Waitlisted" } : { status: "Rejected" };
  }
  const row = check(await supabaseAdmin.from("adm_applications").update(update).eq("id", id).eq("institution_id", inst).select(REGISTERS["adm-applications"].select).single());
  if (update.status === "Approved") await createOffer(inst, id);
  return row;
}

// ═════════════ entrance marks ═════════════
export async function testMarks(inst: string, testId: string) {
  const test = check(await supabaseAdmin.from("adm_tests").select("id, name, subjects, max_marks").eq("id", testId).eq("institution_id", inst).maybeSingle()) as { id: string; name: string; subjects: string; max_marks: number } | null;
  if (!test) throw new HttpError(404, "Test not found.");
  const [apps, marks] = await Promise.all([
    supabaseAdmin.from("adm_applications").select("id, code, child, class_sought").eq("institution_id", inst).in("status", ["Under review", "Approved", "Waitlisted"]).order("code").limit(300),
    supabaseAdmin.from("adm_test_marks").select("application_id, marks").eq("test_id", testId),
  ]);
  const byApp = new Map(((marks.data ?? []) as { application_id: string; marks: Record<string, number> }[]).map((m) => [m.application_id, m.marks]));
  return { test: { ...test, subject_list: test.subjects.split(",").map((x) => x.trim()).filter(Boolean) }, rows: ((apps.data ?? []) as { id: string; code: string; child: string; class_sought: string }[]).map((a) => ({ ...a, marks: byApp.get(a.id) ?? {} })) };
}

export async function saveMarks(inst: string, testId: string, body: unknown) {
  const { rows } = z.object({ rows: z.array(z.object({ application_id: z.string().uuid(), marks: z.record(z.string(), z.number().min(0).max(1000)) })).max(300) }).strict().parse(body);
  const t = await testMarks(inst, testId);
  const per = t.test.subject_list.length ? t.test.max_marks / t.test.subject_list.length : t.test.max_marks;
  const ids = new Set(t.rows.map((r) => r.id));
  for (const r of rows) {
    if (!ids.has(r.application_id)) throw new HttpError(400, "One of those applicants is not from this school.");
    for (const [subject, v] of Object.entries(r.marks)) if (v > per) throw new HttpError(400, `${subject} marks cannot be more than ${per}.`);
  }
  if (rows.length) check(await supabaseAdmin.from("adm_test_marks").upsert(rows.map((r) => ({ test_id: testId, application_id: r.application_id, marks: r.marks, updated_at: new Date().toISOString() })), { onConflict: "test_id,application_id" }).select("test_id"));
  return testMarks(inst, testId);
}

// ═════════════ class allocation ═════════════
/**
 * The last admission step: puts a registered child in a class and section with a roll number and creates the student record
 * (profile, enrolment and the parent as guardian). Parent and student logins are not created here.
 */
export async function allocate(inst: string, id: string, body: unknown) {
  const input = z.object({ academic_year_id: z.string().uuid(), grade_id: z.string().uuid(), section_id: z.string().uuid(), roll_no: txt(30).min(1, "Give a roll number.") }).strict().parse(body);
  const app = check(await supabaseAdmin.from("adm_applications").select("id, child, parent_name, mobile, status, admission_no, details, applied_on").eq("id", id).eq("institution_id", inst).maybeSingle()) as { child: string; parent_name: string; mobile: string | null; status: string; admission_no: string | null; details: Record<string, string>; applied_on: string } | null;
  if (!app) throw new HttpError(404, "Application not found.");
  if (app.status !== "Registered" || !app.admission_no) throw new HttpError(400, "Give the child an admission number first.");
  const dob = app.details?.dob;
  if (!dob) throw new HttpError(400, "The application has no date of birth. Add it to the application first.");
  const sec = check(await supabaseAdmin.from("sections").select("id").eq("id", input.section_id).eq("institution_id", inst).eq("grade_id", input.grade_id).eq("academic_year_id", input.academic_year_id).maybeSingle());
  if (!sec) throw new HttpError(400, "That section does not belong to the chosen class and year.");
  const taken = check(await supabaseAdmin.from("student_enrollments").select("id").eq("institution_id", inst).eq("academic_year_id", input.academic_year_id).eq("section_id", input.section_id).eq("roll_no", input.roll_no).limit(1)) as unknown[];
  if (taken.length) throw new HttpError(409, "That roll number is already used in the section.");
  const gender = /^m/i.test(app.details?.gender ?? "") ? "Male" : /^f/i.test(app.details?.gender ?? "") ? "Female" : "Other";
  const [first, ...rest] = app.child.trim().split(/s+/);
  const student = check(await supabaseAdmin.from("students").insert({ institution_id: inst, registration_no: app.admission_no, roll_no: input.roll_no, first_name: first, last_name: rest.join(" ") || "-", gender, date_of_birth: dob, status: "Enrolled" }).select("id").single()) as { id: string };
  try {
    check(await supabaseAdmin.from("student_enrollments").insert({ institution_id: inst, student_id: student.id, academic_year_id: input.academic_year_id, grade_id: input.grade_id, section_id: input.section_id, roll_no: input.roll_no }).select("id"));
    check(await supabaseAdmin.from("student_profiles").insert({ student_id: student.id, date_of_birth: dob, gender, blood_group: app.details?.blood_group || null, permanent_address: app.details?.address || null }).select("id"));
    const g = check(await supabaseAdmin.from("guardians").insert({ institution_id: inst, full_name: app.parent_name, phone: app.mobile ?? "-", email: app.details?.email || null, occupation: app.details?.occupation || null }).select("id").single()) as { id: string };
    check(await supabaseAdmin.from("student_guardians").insert({ student_id: student.id, guardian_id: g.id, relation: app.details?.relation || "Parent", is_primary_contact: true }).select("student_id"));
  } catch (err) {
    await supabaseAdmin.from("students").delete().eq("id", student.id).eq("institution_id", inst);
    throw err;
  }
  return check(await supabaseAdmin.from("adm_applications").update({ status: "Allocated" }).eq("id", id).eq("institution_id", inst).select(REGISTERS["adm-applications"].select).single());
}
