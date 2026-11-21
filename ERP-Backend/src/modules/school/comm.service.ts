import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";

/** Communication: circulars, announcements, notice board, message templates and the message log.
 *  Nothing here talks to an SMS, e-mail or WhatsApp gateway; messages are recorded as Pending. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const decide = z.object({ action: z.enum(["approve", "reject"]) }).strict();

// ═════════════ circulars ═════════════
const AUD = ["Staff", "All parents", "Transport users", "Students", "Everyone"] as const;
export const CIRCULAR_TEMPLATES = [
  { key: "holiday-notice", name: "Holiday notice", audience: "All parents", wording: "The school will remain closed on {date} for {occasion}. Classes resume on {resume date}." },
  { key: "exam-date-sheet", name: "Exam date sheet", audience: "All parents", wording: "{exam} for Classes {classes} runs from {start} to {end}. The date sheet is attached. Students must carry their hall ticket." },
  { key: "ptm", name: "Parent–teacher meeting", audience: "All parents", wording: "The parent–teacher meeting is on {date}, {time}. Book a 10-minute slot with each teacher in the parent app." },
  { key: "fee-due", name: "Fee due reminder", audience: "All parents", wording: "{term} fees are due on {due date}. A late fee of {late fee} applies after that. Pay online in the parent app." },
  { key: "uniform", name: "Uniform change", audience: "All parents", wording: "From {date}, students wear the {season} uniform: {items}." },
  { key: "event-invite", name: "Event invitation", audience: "All parents", wording: "You are invited to {event} on {date} at {venue}, {time}." },
  { key: "emergency", name: "Emergency closure", audience: "Everyone", wording: "Because of {reason}, the school is closed on {date}. Watch the app for updates." },
  { key: "staff-duty", name: "Staff duty list", audience: "Staff", wording: "Duties for {event} are attached. Report to {in-charge} by {time}." },
];
export async function circulars(inst: string) {
  const c = check(await supabaseAdmin.from("comm_circulars").select("id, code, title, audience, issued_by, circ_date, status, body, template_key").eq("institution_id", inst).order("circ_date", { ascending: false }).order("code", { ascending: false }).limit(2000)) as { id: string; code: string; title: string; audience: string; issued_by: string; circ_date: string; status: string; body: string; template_key: string | null }[];
  return { audiences: AUD, items: c, templates: CIRCULAR_TEMPLATES.map((t) => { const u = c.filter((x) => x.template_key === t.key); return { ...t, used: u.length, last_used: u.map((x) => x.circ_date).sort().pop() ?? null }; }) };
}
export async function addCircular(inst: string, input: unknown) {
  const i = z.object({ code: z.string().trim().max(20).optional(), title: z.string().trim().min(2, "Enter the title.").max(160), audience: z.enum(AUD), issued_by: z.string().trim().min(2).max(60), circ_date: date, template_key: z.string().max(30).nullable().optional() }).strict().parse(input);
  const t = i.template_key ? CIRCULAR_TEMPLATES.find((x) => x.key === i.template_key) : null; if (i.template_key && !t) throw new HttpError(404, "Template not found.");
  let code = i.code;
  if (!code) { const yr = i.circ_date.slice(0, 4); const ex = (check(await supabaseAdmin.from("comm_circulars").select("code").eq("institution_id", inst).like("code", `CIR-${yr}-%`)) as { code: string }[]).map((x) => Number(x.code.split("-")[2]) || 0); code = `CIR-${yr}-${String(Math.max(0, ...ex) + 1).padStart(3, "0")}`; }
  if ((check(await supabaseAdmin.from("comm_circulars").select("id").eq("institution_id", inst).eq("code", code)) as unknown[]).length) throw new HttpError(409, "That circular number is already used.");
  return check(await supabaseAdmin.from("comm_circulars").insert({ institution_id: inst, code, title: i.title, audience: i.audience, issued_by: i.issued_by, circ_date: i.circ_date, template_key: i.template_key ?? null, body: t?.wording ?? "" }).select("id, code").single());
}
export async function decideCircular(inst: string, id: string, input: unknown) {
  const { action } = decide.parse(input);
  const r = check(await supabaseAdmin.from("comm_circulars").update({ status: action === "approve" ? "Published" : "Archived" }).eq("id", id).eq("institution_id", inst).eq("status", "Draft").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That was already decided."); return { ok: true };
}

// ═════════════ announcements ═════════════
const CH = ["App", "App + SMS", "App + Email", "App + SMS + Email"] as const;
export async function announcements(inst: string) {
  return { channels: CH, items: check(await supabaseAdmin.from("comm_announcements").select("id, title, audience, channels, send_on, status").eq("institution_id", inst).order("send_on", { ascending: false }).limit(2000)) as { id: string; title: string; audience: string; channels: string; send_on: string; status: string }[] };
}
export async function addAnnouncement(inst: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(2, "Enter the title.").max(160), audience: z.enum(["Everyone", "Students", "Staff", "Parents"]), channels: z.enum(CH), send_on: date }).strict().parse(input);
  if (i.send_on < today()) throw new HttpError(400, "Pick today or a later date.");
  return check(await supabaseAdmin.from("comm_announcements").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function decideAnnouncement(inst: string, id: string, input: unknown) {
  const { action } = decide.parse(input);
  const r = check(await supabaseAdmin.from("comm_announcements").update({ status: action === "approve" ? "Scheduled" : "Rejected" }).eq("id", id).eq("institution_id", inst).eq("status", "Draft").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That was already decided."); return { ok: true };
}

// ═════════════ notice board ═════════════
export async function notices(inst: string) {
  const n = today();
  return { items: (check(await supabaseAdmin.from("comm_notices").select("id, title, audience, posted_by, posted_on, expires_on").eq("institution_id", inst).order("posted_on", { ascending: false }).limit(2000)) as { id: string; title: string; audience: string; posted_by: string; posted_on: string; expires_on: string }[]).map((x) => ({ ...x, status: x.expires_on < n ? "Expired" : "Live" })) };
}
export async function addNotice(inst: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(2).max(160), audience: z.enum(["Student", "Staff", "Parent"]), posted_by: z.string().trim().min(2).max(60), expires_on: date }).strict().parse(input);
  if (i.expires_on < today()) throw new HttpError(400, "The expiry date has already passed.");
  return check(await supabaseAdmin.from("comm_notices").insert({ institution_id: inst, ...i }).select("id").single());
}

// ═════════════ templates and the message log ═════════════
const CHANNELS = ["Email", "SMS", "WhatsApp", "In-App"] as const;
const DEFAULTS: [string, string, string, string][] = [
  ["Fee reminder", "WhatsApp", "{student}, {class}", "Dear parent, fees for {student} ({class}) are due. Please pay at the earliest."],
  ["Absent today", "Email", "{parent}, {date}, {time}", "Dear {parent}, your child was marked absent on {date} at {time}."],
  ["Exam schedule", "SMS", "{student}, {amount}, {due_date}", "{student} has {amount} due by {due_date}."],
  ["PTM invite", "WhatsApp", "{student}, {date}", "The parent–teacher meeting for {student} is on {date}."],
  ["Bus delay", "Email", "{student}, {class}", "The bus for {student} ({class}) is running late today."],
  ["Birthday wishes", "SMS", "{parent}, {date}, {time}", "Dear {parent}, best wishes on {date} at {time} from the school."],
  ["Holiday notice", "WhatsApp", "{student}, {amount}, {due_date}", "Holiday notice for {student}: the school reopens on {due_date}."],
  ["Result published", "Email", "{student}, {class}", "The result for {student} ({class}) is now available in the parent app."],
];
async function seedTemplates(inst: string) {
  if ((check(await supabaseAdmin.from("comm_templates").select("id").eq("institution_id", inst).limit(1)) as unknown[]).length) return;
  check(await supabaseAdmin.from("comm_templates").insert(DEFAULTS.map(([name, channel, variables, body]) => ({ institution_id: inst, name, channel, variables, body }))).select("id"));
}
export async function templates(inst: string) {
  await seedTemplates(inst); const ms = today().slice(0, 7);
  const [t, m] = await Promise.all([supabaseAdmin.from("comm_templates").select("id, name, channel, variables, body, status").eq("institution_id", inst).order("name"), supabaseAdmin.from("comm_messages").select("template_id").eq("institution_id", inst).gte("send_on", `${ms}-01`).not("template_id", "is", null)]);
  const M = check(m) as { template_id: string }[];
  return { items: (check(t) as { id: string; name: string; channel: string; variables: string; body: string; status: string }[]).map((x) => ({ ...x, used: M.filter((y) => y.template_id === x.id).length })) };
}
export async function templateStatus(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["submit", "approve", "withdraw"]) }).strict().parse(input);
  const to = action === "submit" ? ["Pending approval", "Draft"] : action === "approve" ? ["Approved", "Pending approval"] : ["Draft", "Pending approval"];
  const r = check(await supabaseAdmin.from("comm_templates").update({ status: to[0] }).eq("id", id).eq("institution_id", inst).eq("status", to[1]).select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That template is not in the right state."); return { ok: true };
}
export async function composeOptions(inst: string) {
  const [t, r] = await Promise.all([templates(inst), roster(inst)]); const cl = new Map<string, string>(); for (const s of r.items) if (s.status === "Enrolled" || s.enrol_status === "Enrolled") cl.set(s.grade_id as string, s.class_name);
  return { classes: [...cl.entries()].map(([id, name]) => ({ id, name })), templates: t.items.filter((x) => x.status === "Approved").map((x) => ({ id: x.id, name: x.name, channel: x.channel, body: x.body })) };
}
export async function messages(inst: string, channel: string) {
  const c = z.enum(CHANNELS).parse(channel);
  return { items: check(await supabaseAdmin.from("comm_messages").select("id, ref, channel, title, subject, message, audience, class_label, recipients, send_on, status, copy_to_me").eq("institution_id", inst).eq("channel", c).order("created_at", { ascending: false }).limit(2000)) as { id: string; ref: string; channel: string; title: string; subject: string; message: string; audience: string; class_label: string; recipients: number; send_on: string; status: string; copy_to_me: boolean }[] };
}
export async function sendMessage(inst: string, input: unknown) {
  const i = z.object({ channel: z.enum(CHANNELS), subject: z.string().trim().max(160).optional(), audience: z.enum(["All parents", "All students", "All staff"]), grade_id: uid.nullable().optional(), template_id: uid.nullable().optional(), message: z.string().trim().min(1, "Write the message.").max(1000), schedule_for: date.nullable().optional(), copy_to_me: z.boolean().optional() }).strict().parse(input);
  if (i.channel === "Email" && !i.subject) throw new HttpError(400, "Enter the subject.");
  if (i.channel === "SMS" && i.message.length > 160) throw new HttpError(400, "An SMS is 160 characters at most.");
  if (i.schedule_for && i.schedule_for < today()) throw new HttpError(400, "Pick today or a later date.");
  let name = ""; if (i.template_id) { const t = check(await supabaseAdmin.from("comm_templates").select("name, status, channel").eq("id", i.template_id).eq("institution_id", inst).maybeSingle()) as { name: string; status: string; channel: string } | null; if (!t) throw new HttpError(404, "Template not found."); if (t.status !== "Approved") throw new HttpError(409, "That template is not approved yet."); name = t.name; }
  let recipients = 0; let label = "All classes";
  if (i.audience === "All staff") recipients = (check(await supabaseAdmin.from("hr_staff").select("profile_id").eq("institution_id", inst).limit(5000)) as unknown[]).length;
  else { const r = (await roster(inst)).items.filter((s) => s.status === "Enrolled" || s.enrol_status === "Enrolled"); const m = i.grade_id ? r.filter((s) => s.grade_id === i.grade_id) : r; if (i.grade_id && m[0]) label = m[0].class_name; recipients = m.length; }
  if (!recipients) throw new HttpError(409, "There is nobody to send this to.");
  return check(await supabaseAdmin.from("comm_messages").insert({ institution_id: inst, channel: i.channel, title: name || i.subject || i.message.slice(0, 40), subject: i.subject ?? "", message: i.message, template_id: i.template_id ?? null, audience: i.audience, class_label: label, recipients, send_on: i.schedule_for ?? today(), status: i.schedule_for && i.schedule_for > today() ? "Scheduled" : "Pending", copy_to_me: !!i.copy_to_me }).select("id, ref, recipients").single());
}
