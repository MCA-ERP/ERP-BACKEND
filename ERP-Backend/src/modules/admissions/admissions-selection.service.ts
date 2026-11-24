import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { formFee } from "../school/front-office.service";
import { programmes, createOffer } from "../school/admission-extra.service";
import { admissionYear, classOf, eligibility, load, classRules, type App, type Family } from "./admissions.service";

/**
 * The Admissions portal's application, verification, test-and-interview and waitlist pages. Same adm_* tables as the School Admin
 * Admission module; every function names the school, and an application id from the client is always looked up inside it.
 */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// ═════════════ applications: the form, its fee and its documents ═════════════
const REQUIRED_DOCS = 6;
async function feeFor(inst: string, cls: string, cache: Map<string, number>) { const k = classOf(cls); if (!cache.has(k)) cache.set(k, await formFee(inst, cls)); return cache.get(k) as number; }
const appOf = async (inst: string, id: string) => { const d = await load(inst); const app = d.apps.find((x) => x.id === id); if (!app) throw new HttpError(404, "Application not found."); return { d, app, fam: d.families.find((f) => f.kind === "application" && f.id === id) as Family }; };

/** Application forms still with the family (fee, details, documents), and forms sent back for a correction. */
export async function applications(inst: string) {
  const d = await load(inst);
  const cache = new Map<string, number>();
  const open = d.families.filter((f) => f.kind === "application" && ((f.status === "Active" && f.step === 3) || f.status === "Returned"));
  const items = [];
  for (const f of open) {
    const x = d.apps.find((a) => a.id === f.id) as App;
    const filled = Object.keys(x.details ?? {}).some((k) => !["last_reminded_on", "notes"].includes(k) && x.details?.[k]);
    const docs = Math.min(REQUIRED_DOCS, d.docTypes.get(x.id)?.size ?? 0);
    items.push({ id: x.id, code: x.code, child: x.child, class_sought: x.class_sought, parent_name: x.parent_name, mobile: x.mobile, form: x.status === "Returned" ? "Returned" : filled || docs > 0 ? "In progress" : "Form sent", reason: x.status === "Returned" ? x.return_reason : null, fee_status: x.fee_status, fee: x.fee_amount && x.fee_amount > 0 ? x.fee_amount : await feeFor(inst, x.class_sought, cache), docs, docs_of: REQUIRED_DOCS, reminded_on: x.details?.last_reminded_on ?? null, dob: x.details?.dob ?? "", gender: x.details?.gender ?? "", email: x.details?.email ?? "", address: x.details?.address ?? "", prev_school: x.details?.prev_school ?? "" });
  }
  const paid = d.apps.filter((x) => x.fee_status === "Paid" && (x.fee_amount ?? 0) > 0);
  return { items, tiles: { pending: items.filter((i) => i.fee_status === "Pending").length, collected: paid.reduce((n, x) => n + (x.fee_amount ?? 0), 0), families: paid.length, waived: d.apps.filter((x) => x.fee_status === "Waived").length } };
}

export async function collectFee(inst: string, id: string, input: unknown) {
  const { mode } = z.object({ mode: z.enum(["UPI", "Card", "Cash", "Cheque", "Net banking"]) }).strict().parse(input);
  const { app } = await appOf(inst, id);
  if (app.fee_status !== "Pending") throw new HttpError(409, "The application fee is already settled.");
  check(await supabaseAdmin.from("adm_applications").update({ fee_status: "Paid", fee_amount: await formFee(inst, app.class_sought), fee_mode: mode, fee_paid_on: today() }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

export async function waiveFee(inst: string, id: string, input: unknown) {
  const { reason } = z.object({ reason: z.string().trim().min(2, "Say why the fee is waived.").max(120) }).strict().parse(input);
  const { app } = await appOf(inst, id);
  if (app.fee_status !== "Pending") throw new HttpError(409, "The application fee is already settled.");
  check(await supabaseAdmin.from("adm_applications").update({ fee_status: "Waived", fee_amount: 0, fee_note: reason }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

/** No SMS is connected, so a reminder is recorded on the application and shown in the list. */
export async function remind(inst: string, id: string) {
  const { app } = await appOf(inst, id);
  check(await supabaseAdmin.from("adm_applications").update({ details: { ...(app.details ?? {}), last_reminded_on: today() } }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

const text200 = z.string().trim().max(200);
/** "Fill at front office": the details staff type in for a family. Merged into the application; only these fields are accepted. */
export async function saveDetails(inst: string, id: string, input: unknown) {
  const i = z.object({ dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")), gender: z.enum(["Female", "Male", "Other"]).or(z.literal("")), email: text200, address: text200, prev_school: text200 }).partial().strict().parse(input);
  const { app } = await appOf(inst, id);
  const merged = { ...(app.details ?? {}), ...Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) };
  check(await supabaseAdmin.from("adm_applications").update({ details: merged }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

/** Review and submit: the form goes for verification once the fee is paid or waived (a returned form comes back to verification once fixed). */
export async function submitApplication(inst: string, id: string) {
  const { app } = await appOf(inst, id);
  if (app.status !== "Returned" && app.status !== "Under review") throw new HttpError(409, "That application is past this step.");
  if (app.fee_status === "Pending") throw new HttpError(400, "The application fee must be paid or waived before the form goes for verification.");
  if (!app.details?.dob) throw new HttpError(400, "Add the child's date of birth first (Fill at front office).");
  const now = new Date().toISOString();
  const update = app.status === "Returned" ? { status: "Under review", level: 1, level_since: now, return_reason: null, submitted_at: now } : { submitted_at: now };
  check(await supabaseAdmin.from("adm_applications").update(update).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ verification ═════════════
const assessmentLabel = async (inst: string, needs: boolean, cls: string) => { if (!needs) return "Straight to approval"; const p = (await programmes(inst)).find((x) => x.classes.split(",").map((s) => s.trim()).includes(classOf(cls))); return p && p.test_weight > 0 ? "Test + interview" : "Interaction"; };

export async function verificationPending(inst: string) {
  const d = await load(inst);
  const items = [];
  for (const f of d.families.filter((x) => x.kind === "application" && x.status === "Active" && x.step === 4)) {
    const x = d.apps.find((a) => a.id === f.id) as App;
    const rule = d.rules.find((r) => r.class_name === classOf(x.class_sought));
    const e = eligibility(x.details?.dob, rule?.min_age ?? 0);
    items.push({ id: x.id, code: x.code, child: x.child, class_sought: x.class_sought, dob: x.details?.dob ?? null, age: e.age, state: e.state, min_age: rule?.min_age ?? null, next: await assessmentLabel(inst, rule?.needs_assessment ?? true, x.class_sought) });
  }
  return { items };
}

/** Verify: eligibility is checked, the documents are marked verified, and the application moves on. */
export async function verify(inst: string, id: string) {
  const { d, app, fam } = await appOf(inst, id);
  if (fam.step !== 4 || fam.status !== "Active") throw new HttpError(409, "That application is not waiting for verification.");
  const rule = d.rules.find((r) => r.class_name === classOf(app.class_sought));
  const e = eligibility(app.details?.dob, rule?.min_age ?? 0);
  if (e.state === "No date of birth") throw new HttpError(400, "The application has no date of birth.");
  if (e.state === "Not eligible") throw new HttpError(400, `${app.child} is below the minimum age of ${rule?.min_age} on 31 March. Send the application back, or ask the Principal for an exception.`);
  check(await supabaseAdmin.from("adm_applications").update({ verified_at: new Date().toISOString() }).eq("id", id).eq("institution_id", inst).select("id"));
  await supabaseAdmin.from("adm_documents").update({ status: "Verified" }).eq("institution_id", inst).eq("application_id", id).eq("status", "Pending review");
  return { ok: true };
}

export async function returnApplication(inst: string, id: string, input: unknown) {
  const { reason } = z.object({ reason: z.string().trim().min(2, "Say what needs correcting.").max(200) }).strict().parse(input);
  const { fam } = await appOf(inst, id);
  if (fam.step !== 4 || fam.status !== "Active") throw new HttpError(409, "That application is not waiting for verification.");
  check(await supabaseAdmin.from("adm_applications").update({ status: "Returned", return_reason: reason }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

export async function returned(inst: string) {
  const d = await load(inst);
  return { items: d.apps.filter((x) => x.status === "Returned").map((x) => ({ id: x.id, code: x.code, child: x.child, class_sought: x.class_sought, reason: x.return_reason ?? "—", parent_name: x.parent_name, mobile: x.mobile })) };
}

export async function eligibilityRules(inst: string) {
  const rules = await classRules(inst);
  const rows = [];
  for (const r of rules) rows.push({ ...r, assessment: await assessmentLabel(inst, true, r.class_name) });
  return { year: await admissionYear(inst), items: rows };
}

export async function setRule(inst: string, input: unknown) {
  const i = z.object({ class_name: z.string().max(30), needs_assessment: z.boolean() }).strict().parse(input);
  const row = check(await supabaseAdmin.from("adm_class_rules").update({ needs_assessment: i.needs_assessment }).eq("institution_id", inst).eq("class_name", i.class_name).select("class_name").maybeSingle());
  if (!row) throw new HttpError(404, "Class not found.");
  return eligibilityRules(inst);
}

// ═════════════ test and interview ═════════════
export async function toSchedule(inst: string) {
  const d = await load(inst);
  const booked = new Set(d.interviews.filter((i) => ["Scheduled", "Rescheduled"].includes(i.status)).map((i) => i.application_id));
  const items = [];
  for (const f of d.families.filter((x) => x.kind === "application" && x.status === "Active" && x.step === 5 && !booked.has(x.id))) {
    const x = d.apps.find((a) => a.id === f.id) as App;
    items.push({ id: x.id, code: x.code, child: x.child, class_sought: x.class_sought, parent_name: x.parent_name, mobile: x.mobile, assessment: await assessmentLabel(inst, true, x.class_sought) });
  }
  return { items };
}

export async function schedule(inst: string, id: string, input: unknown) {
  const i = z.object({ panel_name: z.string().trim().min(1, "Choose the panel.").max(120), interview_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date."), interview_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional() }).strict().parse(input);
  const { fam } = await appOf(inst, id);
  if (fam.step !== 5 || fam.status !== "Active") throw new HttpError(409, "That child is not waiting for a test or interaction.");
  if (i.interview_date < today()) throw new HttpError(400, "The date cannot be in the past.");
  check(await supabaseAdmin.from("adm_interviews").insert({ institution_id: inst, application_id: id, panel_name: i.panel_name, interview_date: i.interview_date, interview_time: i.interview_time ?? null }).select("id"));
  return { ok: true };
}

export async function resultsToEnter(inst: string) {
  const d = await load(inst);
  const items = d.interviews.filter((i) => ["Scheduled", "Rescheduled"].includes(i.status)).flatMap((i) => { const a = d.apps.find((x) => x.id === i.application_id); const f = d.families.find((x) => x.kind === "application" && x.id === i.application_id); return a && f?.step === 5 ? [{ id: i.id, application_id: a.id, code: a.code, child: a.child, class_sought: a.class_sought, panel_name: i.panel_name, interview_date: i.interview_date, interview_time: i.interview_time, status: i.status }] : []; });
  return { items: items.sort((x, y) => x.interview_date.localeCompare(y.interview_date)) };
}

export async function enterResult(inst: string, id: string, input: unknown) {
  const i = z.object({ score: z.number().int().min(0).max(100), recommendation: z.enum(["Recommend", "Waitlist", "Do not recommend"]) }).strict().parse(input);
  const row = check(await supabaseAdmin.from("adm_interviews").update({ status: "Completed", score: i.score, recommendation: i.recommendation }).eq("id", id).eq("institution_id", inst).in("status", ["Scheduled", "Rescheduled"]).select("id").maybeSingle());
  if (!row) throw new HttpError(404, "That slot is not waiting for a result.");
  return { ok: true };
}

// ═════════════ approval: waitlisted and rejected ═════════════
export async function waitlistedRejected(inst: string) {
  const d = await load(inst);
  return { items: d.apps.filter((x) => ["Waitlisted", "Rejected"].includes(x.status)).map((x) => ({ id: x.id, code: x.code, child: x.child, class_sought: x.class_sought, decision: x.status })) };
}

/** A waitlisted child is approved when a seat frees up: the seat offer is made, as when the last level approves. */
export async function approveWaitlisted(inst: string, id: string) {
  const { app } = await appOf(inst, id);
  if (app.status !== "Waitlisted") throw new HttpError(409, "Only a waitlisted child can be approved from here.");
  check(await supabaseAdmin.from("adm_applications").update({ status: "Approved" }).eq("id", id).eq("institution_id", inst).select("id"));
  await createOffer(inst, id);
  return { ok: true };
}
