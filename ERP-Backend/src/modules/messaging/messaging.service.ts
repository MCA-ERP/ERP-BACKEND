import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { emailConfigured, sendEmail } from "../../lib/mailer";
import { normalizePhone, sendSms, smsConfigured } from "../../lib/sms";
import { placeholderOrder, sendWhatsApp, whatsappConfigured } from "../../lib/whatsapp";
import { parsePage, safeSearch } from "../../lib/query";
import { getSetting } from "../admin/settings.service";

export type Channel = "email" | "sms" | "whatsapp";

export function messagingStatus() {
  return {
    email: { configured: emailConfigured(), host: process.env.SMTP_HOST ?? null },
    sms: { configured: smsConfigured() },
    whatsapp: { configured: whatsappConfigured() },
  };
}

const configured = (c: Channel) => (c === "email" ? emailConfigured() : c === "sms" ? smsConfigured() : whatsappConfigured());
const notConfiguredMessage = (c: Channel) => (c === "email" ? "Email is not configured." : c === "sms" ? "SMS is not configured." : "WhatsApp is not connected.");

/** Public address of this API, used for the tiny image that records an email open. */
const trackingUrl = (id: string) => {
  const base = (process.env.API_PUBLIC_URL || "").replace(/\/$/, "");
  return base ? `${base}/api/v1/public/t/${id}.gif` : null;
};

export const appUrl = () =>
  (process.env.APP_URL || (process.env.CORS_ORIGIN || "").split(",")[0].trim() || "http://localhost:3000").replace(/\/$/, "");

// ─────────────────────────────────────────────
//  Templates
// ─────────────────────────────────────────────
/** Replaces {{name}} with the variable's value; unknown names become empty. */
export function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, name: string) => vars[name] ?? "");
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain text to a simple, safe HTML email (paragraphs, links made clickable). */
export function toHtml(text: string): string {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`)
    .join("");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111827">${body}</div>`;
}

interface TemplateRow {
  id: string;
  key: string | null;
  channel: Channel;
  subject: string | null;
  body: string;
  provider_template_id: string | null;
}

async function templatesFor(key: string): Promise<TemplateRow[]> {
  return check(
    await supabaseAdmin.from("message_templates").select("id, key, channel, subject, body, provider_template_id").eq("key", key).eq("is_active", true).in("channel", ["email", "sms", "whatsapp"])
  ) as TemplateRow[];
}

// ─────────────────────────────────────────────
//  Recipients
// ─────────────────────────────────────────────
interface Recipient {
  name: string;
  email?: string;
  phone?: string;
}

/** Everyone at a school who should hear from the platform: its contact and its administrators. */
export async function schoolRecipients(institutionId: string): Promise<{ school: { id: string; name: string; code: string }; emails: Recipient[]; phones: Recipient[] }> {
  const [school, admins] = await Promise.all([
    supabaseAdmin.from("institutions").select("id, name, code, contact_name, contact_email, contact_phone").eq("id", institutionId).maybeSingle(),
    supabaseAdmin
      .from("user_profiles")
      .select("first_name, email, phone, roles:role_id!inner(name)")
      .eq("institution_id", institutionId)
      .eq("status", "active")
      .eq("roles.name", "InstitutionAdmin"),
  ]);
  const s = check(school) as { id: string; name: string; code: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null } | null;
  if (!s) throw new HttpError(404, "School not found.");

  const emails = new Map<string, Recipient>();
  const phones = new Map<string, Recipient>();
  const add = (name: string, email?: string | null, phone?: string | null) => {
    const e = email?.trim().toLowerCase();
    if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !emails.has(e)) emails.set(e, { name, email: e });
    const p = phone ? normalizePhone(phone) : null;
    if (p && !phones.has(p)) phones.set(p, { name, phone: p });
  };
  for (const a of check(admins) as unknown as { first_name: string; email: string; phone: string | null }[]) add(a.first_name, a.email, a.phone);
  add(s.contact_name?.split(" ")[0] || "there", s.contact_email, s.contact_phone);

  return { school: { id: s.id, name: s.name, code: s.code }, emails: [...emails.values()], phones: [...phones.values()] };
}

// ─────────────────────────────────────────────
//  Queue and send
// ─────────────────────────────────────────────
interface QueueInput {
  channel: Channel;
  to: string;
  subject?: string | null;
  body: string;
  payload?: { template_id: string; variables: Record<string, string>; order?: string[] };
  institutionId?: string | null;
  relatedType?: string;
  relatedId?: string;
  dedupeKey?: string;
  createdBy?: string | null;
}

/** Records a message as queued. Returns its id, or null when this dedupe key was already used. */
async function enqueue(input: QueueInput): Promise<string | null> {
  const res = await supabaseAdmin
    .from("message_log")
    .insert({
      channel: input.channel,
      to_address: input.to,
      subject: input.subject ?? null,
      body: input.body,
      payload: input.payload ?? null,
      institution_id: input.institutionId ?? null,
      related_type: input.relatedType ?? null,
      related_id: input.relatedId ?? null,
      dedupe_key: input.dedupeKey ?? null,
      created_by: input.createdBy ?? null,
    })
    .select("id")
    .single();
  if (res.error) {
    if (res.error.code === "23505") return null;
    throw new HttpError(500, res.error.message);
  }
  return res.data.id as string;
}

async function deliverOne(id: string): Promise<void> {
  const { data: row } = await supabaseAdmin.from("message_log").select("*").eq("id", id).eq("status", "queued").maybeSingle();
  if (!row) return;
  try {
    let providerId = "";
    if (row.channel === "email") {
      const [fromName, fromAddress, replyTo] = await Promise.all([getSetting<string>("notify.email_from_name", ""), getSetting<string>("notify.email_from_address", ""), getSetting<string>("notify.reply_to", "")]);
      let html = toHtml(row.body);
      const pixel = row.related_type === "announcement" && (await getSetting<boolean>("communication.track_email_opens", true)) ? trackingUrl(row.id) : null;
      if (pixel) html += `<img src="${pixel}" width="1" height="1" alt="" style="display:none">`;
      providerId = await sendEmail({ to: row.to_address, subject: row.subject ?? "(no subject)", text: row.body, html, fromName: fromName || undefined, fromAddress: fromAddress || undefined, replyTo: replyTo || undefined });
    } else if (row.channel === "whatsapp") {
      const v: Record<string, string> = row.payload?.variables ?? {};
      providerId = await sendWhatsApp({ to: row.to_address, templateName: row.payload?.template_id ?? "", params: (row.payload?.order ?? placeholderOrder(row.body)).map((n: string) => v[n] ?? "") });
    } else {
      providerId = await sendSms({ to: row.to_address, templateId: row.payload?.template_id ?? "", variables: row.payload?.variables ?? {} });
    }
    await supabaseAdmin.from("message_log").update({ status: "sent", provider_message_id: providerId.slice(0, 200), error: null, sent_at: new Date().toISOString(), attempts: row.attempts + 1 }).eq("id", id);
  } catch (err) {
    await supabaseAdmin
      .from("message_log")
      .update({ status: "failed", error: (err instanceof Error ? err.message : "Sending failed.").slice(0, 500), attempts: row.attempts + 1 })
      .eq("id", id);
  }
}

/** Sends queued messages a few at a time, so a big announcement does not open hundreds of connections. */
export async function deliverQueued(ids: string[], concurrency = 5): Promise<void> {
  const pending = [...ids];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      for (let id = pending.shift(); id; id = pending.shift()) await deliverOne(id);
    })
  );
}

/** Runs delivery in the background; callers never wait for the mail or SMS provider. */
function deliverInBackground(ids: string[]) {
  if (!ids.length) return;
  void deliverQueued(ids).catch((err) => console.error("Message delivery failed:", err instanceof Error ? err.message : err));
}

// ─────────────────────────────────────────────
//  Notifications built from templates
// ─────────────────────────────────────────────
interface NotifyOptions {
  /** Send only to this address instead of the school's recipients (e.g. a new administrator). */
  onlyEmail?: { email: string; name: string };
  relatedType?: string;
  relatedId?: string;
  /** Reminders pass a key so running the job twice never sends twice. */
  dedupe?: string;
  /** Limit to some channels. */
  channels?: Channel[];
  extraVars?: Record<string, string>;
}

/**
 * Sends a system message (welcome, invoice, reminder...) to a school by the template's key, on every
 * channel that has a template and a configured provider. Missing providers are skipped quietly.
 */
export async function notifySchool(key: string, institutionId: string, vars: Record<string, string>, opts: NotifyOptions = {}): Promise<{ queued: number }> {
  const [templates, recipients, platformName] = await Promise.all([templatesFor(key), schoolRecipients(institutionId), getSetting<string>("general.platform_name", "My Class Assist")]);
  const base = { platform_name: platformName, school_name: recipients.school.name, link: `${appUrl()}/school`, ...vars };
  const ids: string[] = [];

  for (const t of templates) {
    if (opts.channels && !opts.channels.includes(t.channel)) continue;
    if (!configured(t.channel)) continue;

    if (t.channel === "email") {
      const targets = opts.onlyEmail ? [{ name: opts.onlyEmail.name, email: opts.onlyEmail.email }] : recipients.emails;
      for (const r of targets) {
        const v = { ...base, admin_name: r.name, ...opts.extraVars };
        const id = await enqueue({
          channel: "email", to: r.email!, subject: render(t.subject ?? "", v), body: render(t.body, v), institutionId,
          relatedType: opts.relatedType ?? "notification", relatedId: opts.relatedId ?? key,
          dedupeKey: opts.dedupe ? `${opts.dedupe}:email:${r.email}` : undefined,
        });
        if (id) ids.push(id);
      }
    } else if (!opts.onlyEmail && t.provider_template_id) {
      for (const r of recipients.phones) {
        const v = { ...base, admin_name: r.name, ...opts.extraVars };
        const id = await enqueue({
          channel: t.channel, to: r.phone!, body: render(t.body, v), payload: { template_id: t.provider_template_id, variables: v, order: t.channel === "whatsapp" ? placeholderOrder(t.body) : undefined },
          institutionId, relatedType: opts.relatedType ?? "notification", relatedId: opts.relatedId ?? key,
          dedupeKey: opts.dedupe ? `${opts.dedupe}:${t.channel}:${r.phone}` : undefined,
        });
        if (id) ids.push(id);
      }
    }
  }
  deliverInBackground(ids);
  return { queued: ids.length };
}

/** Same as notifySchool but never throws: a notification must not break the action that triggered it. */
export function notifySchoolSafely(key: string, institutionId: string, vars: Record<string, string>, opts: NotifyOptions = {}): void {
  void notifySchool(key, institutionId, vars, opts).catch((err) => console.error(`Notification '${key}' failed:`, err instanceof Error ? err.message : err));
}

// ─────────────────────────────────────────────
//  Announcements
// ─────────────────────────────────────────────
export async function sendAnnouncementMessages(
  announcement: { id: string; title: string; body: string; channels: string[] },
  schoolIds: string[],
  actorProfileId?: string
): Promise<{ queued: number; email: number; sms: number; whatsapp: number }> {
  const wantEmail = announcement.channels.includes("email");
  const wantSms = announcement.channels.includes("sms");
  const wantWa = announcement.channels.includes("whatsapp");
  if (!wantEmail && !wantSms && !wantWa) return { queued: 0, email: 0, sms: 0, whatsapp: 0 };

  const problems: string[] = [];
  if (wantEmail && !emailConfigured()) problems.push("Email is not configured");
  if (wantSms && !smsConfigured()) problems.push("SMS is not configured");
  const announcementTemplates = wantSms || wantWa ? await templatesFor("announcement") : [];
  const smsTemplate = announcementTemplates.find((t) => t.channel === "sms");
  const waTemplate = announcementTemplates.find((t) => t.channel === "whatsapp");
  if (wantWa && !whatsappConfigured()) problems.push("WhatsApp is not connected");
  if (wantWa && whatsappConfigured() && !waTemplate?.provider_template_id) problems.push("Set the Meta template name on the 'Announcement (WhatsApp)' template under WhatsApp → Templates");
  if (wantSms && smsConfigured() && !smsTemplate?.provider_template_id) {
    problems.push("Set the MSG91 template id on the 'Announcement (SMS)' template under Templates");
  }
  if (problems.length) throw new HttpError(400, `${problems.join(". ")}.`);

  const platformName = await getSetting<string>("general.platform_name", "My Class Assist");
  const ids: string[] = [];
  let email = 0;
  let sms = 0;
  let whatsapp = 0;

  for (const schoolId of schoolIds) {
    const r = await schoolRecipients(schoolId);
    if (wantEmail) {
      for (const rec of r.emails) {
        const id = await enqueue({
          channel: "email", to: rec.email!, subject: announcement.title, body: `Hello ${rec.name},\n\n${announcement.body}\n\n${platformName}`,
          institutionId: schoolId, relatedType: "announcement", relatedId: announcement.id, dedupeKey: `announcement:${announcement.id}:email:${rec.email}`, createdBy: actorProfileId,
        });
        if (id) { ids.push(id); email++; }
      }
    }
    if (wantSms && smsTemplate?.provider_template_id) {
      for (const rec of r.phones) {
        const variables = { platform_name: platformName, school_name: r.school.name, admin_name: rec.name, message: announcement.title };
        const id = await enqueue({
          channel: "sms", to: rec.phone!, body: render(smsTemplate.body, variables), payload: { template_id: smsTemplate.provider_template_id, variables },
          institutionId: schoolId, relatedType: "announcement", relatedId: announcement.id, dedupeKey: `announcement:${announcement.id}:sms:${rec.phone}`, createdBy: actorProfileId,
        });
        if (id) { ids.push(id); sms++; }
      }
    }
    if (wantWa && waTemplate?.provider_template_id) {
      for (const rec of r.phones) {
        const variables = { platform_name: platformName, school_name: r.school.name, admin_name: rec.name, message: announcement.title };
        const id = await enqueue({
          channel: "whatsapp", to: rec.phone!, body: render(waTemplate.body, variables), payload: { template_id: waTemplate.provider_template_id, variables, order: placeholderOrder(waTemplate.body) },
          institutionId: schoolId, relatedType: "announcement", relatedId: announcement.id, dedupeKey: `announcement:${announcement.id}:whatsapp:${rec.phone}`, createdBy: actorProfileId,
        });
        if (id) { ids.push(id); whatsapp++; }
      }
    }
  }
  deliverInBackground(ids);
  return { queued: ids.length, email, sms, whatsapp };
}

// ─────────────────────────────────────────────
//  Admin tools: test send, log, retry
// ─────────────────────────────────────────────
/** Sends one message right now to an address the administrator typed, and returns the outcome. */
export async function sendTest(input: { channel: Channel; to: string; templateKey?: string }, actorProfileId?: string) {
  if (!configured(input.channel)) throw new HttpError(400, notConfiguredMessage(input.channel));
  const platformName = await getSetting<string>("general.platform_name", "My Class Assist");
  let id: string | null;

  if (input.channel === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to)) throw new HttpError(400, "Enter a valid email address.");
    id = await enqueue({
      channel: "email", to: input.to, subject: `Test message from ${platformName}`,
      body: `This is a test message from ${platformName}. If you can read this, email delivery is working.`,
      relatedType: "test", createdBy: actorProfileId,
    });
  } else {
    const phone = normalizePhone(input.to);
    if (!phone) throw new HttpError(400, "Enter a valid mobile number.");
    const template = (await templatesFor(input.templateKey || (input.channel === "whatsapp" ? "announcement" : "renewal_reminder"))).find((t) => t.channel === input.channel);
    if (!template?.provider_template_id) throw new HttpError(400, input.channel === "whatsapp" ? "That WhatsApp template has no Meta template name yet. Add it under Communication → WhatsApp → Templates." : "That SMS template has no MSG91 template id yet. Add it under Communication → SMS → Templates.");
    const variables = { platform_name: platformName, school_name: "Test School", admin_name: "Test", date: new Date().toLocaleDateString("en-IN"), amount: "₹0", invoice_number: "TEST", message: "Test message", link: appUrl() };
    id = await enqueue({ channel: input.channel, to: phone, body: render(template.body, variables), payload: { template_id: template.provider_template_id, variables, order: input.channel === "whatsapp" ? placeholderOrder(template.body) : undefined }, relatedType: "test", createdBy: actorProfileId });
  }
  if (!id) throw new HttpError(500, "Could not queue the message.");
  await deliverQueued([id]);
  return check(await supabaseAdmin.from("message_log").select("id, channel, to_address, status, error, created_at, sent_at").eq("id", id).single());
}

export async function listMessages(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("message_log")
    .select("id, channel, to_address, subject, body, status, error, related_type, related_id, attempts, created_at, sent_at, opened_at, open_count, institutions:institution_id(name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (query.channel === "email" || query.channel === "sms" || query.channel === "whatsapp") q = q.eq("channel", String(query.channel));
  if (["queued", "sent", "failed", "cancelled"].includes(String(query.status))) q = q.eq("status", String(query.status));
  if (query.related_type && /^[a-z_]{1,30}$/.test(String(query.related_type))) q = q.eq("related_type", String(query.related_type));
  const search = safeSearch(query.search);
  if (search) q = q.or(`to_address.ilike.%${search}%,subject.ilike.%${search}%`);

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const count = (status: string) => supabaseAdmin.from("message_log").select("*", { count: "exact", head: true }).eq("status", status).gte("created_at", since);
  const [res, sent, failed, queued] = await Promise.all([q, count("sent"), count("failed"), count("queued")]);
  return {
    items: check(res),
    total: res.count ?? 0,
    page: p.page,
    pageSize: p.pageSize,
    last30Days: { sent: sent.count ?? 0, failed: failed.count ?? 0, queued: queued.count ?? 0 },
    providers: messagingStatus(),
  };
}

/** Puts failed messages back in the queue and tries again. */
export async function retryFailed(ids?: string[]) {
  let q = supabaseAdmin.from("message_log").update({ status: "queued", error: null }).eq("status", "failed").lt("attempts", 5);
  if (ids?.length) q = q.in("id", ids);
  const rows = check(await q.select("id, channel")) as { id: string; channel: Channel }[];
  const sendable = rows.filter((r) => configured(r.channel)).map((r) => r.id);
  // anything we cannot send right now goes back to failed rather than waiting forever
  const stuck = rows.filter((r) => !configured(r.channel)).map((r) => r.id);
  if (stuck.length) await supabaseAdmin.from("message_log").update({ status: "failed", error: "The provider is not configured." }).in("id", stuck);
  deliverInBackground(sendable);
  return { retried: sendable.length, skipped: stuck.length };
}

/** Stops queued messages that have not gone out yet. */
export async function cancelQueued(ids?: string[]) {
  let q = supabaseAdmin.from("message_log").update({ status: "cancelled", error: "Cancelled by an administrator." }).eq("status", "queued");
  if (ids?.length) q = q.in("id", ids);
  const rows = check(await q.select("id")) as { id: string }[];
  return { cancelled: rows.length };
}

/** Sends one message again, whatever happened the first time. */
export async function resendMessage(id: string) {
  const row = check(await supabaseAdmin.from("message_log").select("id, channel, status").eq("id", id).maybeSingle()) as { id: string; channel: Channel; status: string } | null;
  if (!row) throw new HttpError(404, "Message not found.");
  if (row.status === "queued") throw new HttpError(409, "This message is already waiting to be sent.");
  if (!configured(row.channel)) throw new HttpError(400, notConfiguredMessage(row.channel));
  check(await supabaseAdmin.from("message_log").update({ status: "queued", error: null, attempts: 0 }).eq("id", id).select("id"));
  deliverInBackground([id]);
  return { success: true };
}
