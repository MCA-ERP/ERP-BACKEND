import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { listMessages, sendAnnouncementMessages } from "../messaging/messaging.service";

export type Audience =
  | { type: "all" }
  | { type: "plans"; plans: string[] }
  | { type: "schools"; school_ids: string[] }
  | { type: "segment"; segment: "active" | "trial" | "renewals_due" };

export const SEGMENTS = ["active", "trial", "renewals_due"] as const;
export const KINDS = ["announcement", "banner", "alert", "popup"] as const;

export const CHANNELS = ["in_app", "email", "sms", "whatsapp"] as const;
/** Every channel can be delivered once its provider is connected. */
const DELIVERABLE = new Set(["in_app", "email", "sms", "whatsapp"]);

const LIVE = ["Trial", "Active", "Overdue"];

// ── announcements ───────────────────────────────────────────
export async function listAnnouncements() {
  const rows = check(
    await supabaseAdmin
      .from("announcements")
      .select("id, title, body, audience, channels, kind, status, scheduled_for, ends_at, ended_at, sent_at, created_at, announcement_deliveries(count)")
      .order("created_at", { ascending: false })
      .limit(200)
  ) as any[];
  const sentIds = rows.filter((r) => r.status === "sent" && r.channels.includes("in_app")).map((r) => r.id);
  const reads = new Map<string, number>();
  if (sentIds.length) {
    const d = check(
      await supabaseAdmin.from("announcement_deliveries").select("announcement_id").in("announcement_id", sentIds).not("read_at", "is", null).limit(20000)
    ) as { announcement_id: string }[];
    for (const r of d) reads.set(r.announcement_id, (reads.get(r.announcement_id) ?? 0) + 1);
  }
  return rows.map((r) => ({ ...r, delivered: r.announcement_deliveries?.[0]?.count ?? 0, read_by: reads.get(r.id) ?? 0, announcement_deliveries: undefined }));
}

export interface AnnouncementInput {
  title: string;
  body: string;
  audience: Audience;
  channels: string[];
  kind?: (typeof KINDS)[number];
  scheduled_for?: string | null;
  ends_at?: string | null;
}

function checkDates(input: { scheduled_for?: string | null; ends_at?: string | null }) {
  if (input.scheduled_for && new Date(input.scheduled_for).getTime() < Date.now() + 30_000) throw new HttpError(400, "Choose a send time in the future.");
  if (input.ends_at) {
    const start = input.scheduled_for ? new Date(input.scheduled_for).getTime() : Date.now();
    if (new Date(input.ends_at).getTime() <= start) throw new HttpError(400, "The end date must be after the start.");
  }
}

export async function createAnnouncement(input: AnnouncementInput, actorProfileId?: string) {
  checkDates(input);
  if ((input.kind ?? "announcement") !== "announcement" && input.channels.some((c) => c !== "in_app")) {
    throw new HttpError(400, "Banners, alerts and pop-ups appear in the school portal only.");
  }
  return check(
    await supabaseAdmin
      .from("announcements")
      .insert({ ...input, status: input.scheduled_for ? "scheduled" : "draft", created_by: actorProfileId ?? null })
      .select()
      .single()
  );
}

export async function updateAnnouncement(id: string, patch: Partial<AnnouncementInput>) {
  const existing = check(await supabaseAdmin.from("announcements").select("status").eq("id", id).maybeSingle()) as { status: string } | null;
  if (!existing) throw new HttpError(404, "Announcement not found.");
  if (existing.status === "sent") throw new HttpError(409, "A sent announcement cannot be edited.");
  checkDates(patch);
  const update: Record<string, unknown> = { ...patch };
  if (patch.scheduled_for !== undefined) update.status = patch.scheduled_for ? "scheduled" : "draft";
  return check(await supabaseAdmin.from("announcements").update(update).eq("id", id).select().single());
}

/** Takes a scheduled announcement back to a draft. */
export async function unscheduleAnnouncement(id: string) {
  const row = check(
    await supabaseAdmin.from("announcements").update({ status: "draft", scheduled_for: null }).eq("id", id).eq("status", "scheduled").select().maybeSingle()
  );
  if (!row) throw new HttpError(409, "Only a scheduled announcement can be unscheduled.");
  return row;
}

/** Ends a banner, alert or pop-up now: schools stop seeing it. */
export async function endAnnouncement(id: string) {
  const row = check(
    await supabaseAdmin.from("announcements").update({ ended_at: new Date().toISOString() }).eq("id", id).eq("status", "sent").is("ended_at", null).select().maybeSingle()
  );
  if (!row) throw new HttpError(409, "Only a live announcement can be ended.");
  return row;
}

export async function deleteAnnouncement(id: string) {
  const existing = check(await supabaseAdmin.from("announcements").select("status").eq("id", id).maybeSingle()) as { status: string } | null;
  if (!existing) throw new HttpError(404, "Announcement not found.");
  if (existing.status === "sent") throw new HttpError(409, "A sent announcement cannot be deleted.");
  check(await supabaseAdmin.from("announcements").delete().eq("id", id).select("id"));
  return { success: true };
}

/** Sent announcements with how each channel did: the "campaigns" view. */
export async function listCampaigns() {
  const rows = check(
    await supabaseAdmin
      .from("announcements")
      .select("id, title, channels, kind, audience, sent_at, announcement_deliveries(count)")
      .eq("status", "sent")
      .order("sent_at", { ascending: false })
      .limit(100)
  ) as any[];
  const ids = rows.map((r) => r.id);
  const stats = new Map<string, Record<string, number>>();
  if (ids.length) {
    const logs = check(
      await supabaseAdmin.from("message_log").select("related_id, channel, status, opened_at").eq("related_type", "announcement").in("related_id", ids).limit(50000)
    ) as { related_id: string; channel: string; status: string; opened_at: string | null }[];
    for (const l of logs) {
      const m = stats.get(l.related_id) ?? {};
      const keys = [l.channel + "_total", l.channel + "_" + l.status];
      if (l.opened_at) keys.push(l.channel + "_opened");
      for (const k of keys) m[k] = (m[k] ?? 0) + 1;
      stats.set(l.related_id, m);
    }
  }
  return rows.map((r) => ({
    id: r.id, title: r.title, channels: r.channels, kind: r.kind, audience: r.audience, sent_at: r.sent_at,
    schools: r.announcement_deliveries?.[0]?.count ?? 0,
    stats: stats.get(r.id) ?? {},
  }));
}

async function targetSchools(audience: Audience): Promise<string[]> {
  if (audience.type === "schools") {
    if (!audience.school_ids.length) return [];
    const rows = check(
      await supabaseAdmin.from("institutions").select("id").in("id", audience.school_ids).in("status", LIVE)
    ) as { id: string }[];
    return rows.map((r) => r.id);
  }
  if (audience.type === "plans") {
    if (!audience.plans.length) return [];
    const rows = check(
      await supabaseAdmin
        .from("platform_school_overview")
        .select("id")
        .in("plan_code", audience.plans)
        .in("status", LIVE)
    ) as { id: string }[];
    return rows.map((r) => r.id);
  }
  if (audience.type === "segment") {
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    let q = supabaseAdmin.from("platform_school_overview").select("id");
    if (audience.segment === "active") q = q.in("status", ["Active", "Overdue"]);
    else if (audience.segment === "trial") q = q.eq("status", "Trial");
    else q = q.eq("status", "Active").gte("renews_on", today).lte("renews_on", in30);
    return (check(await q) as { id: string }[]).map((r) => r.id);
  }
  const rows = check(await supabaseAdmin.from("institutions").select("id").in("status", LIVE).is("deleted_at", null)) as { id: string }[];
  return rows.map((r) => r.id);
}

export async function sendAnnouncement(id: string, actorProfileId?: string) {
  const a = check(await supabaseAdmin.from("announcements").select("*").eq("id", id).maybeSingle()) as
    | { status: string; audience: Audience; channels: string[]; title: string; body: string; kind: string }
    | null;
  if (!a) throw new HttpError(404, "Announcement not found.");
  if (a.status === "sent") throw new HttpError(409, "This announcement has already been sent.");
  if (!a.channels.some((c) => DELIVERABLE.has(c))) {
    throw new HttpError(400, "Choose at least one channel.");
  }

  const schools = await targetSchools(a.audience);
  if (!schools.length) throw new HttpError(400, "No live schools match this audience.");

  // email and SMS first: this refuses (before anything is marked sent) if a provider is not set up
  const messages = await sendAnnouncementMessages({ id, title: a.title, body: a.body, channels: a.channels }, schools, actorProfileId);

  if (a.channels.includes("in_app")) check(
    await supabaseAdmin
      .from("announcement_deliveries")
      .upsert(schools.map((institution_id) => ({ announcement_id: id, institution_id })), { onConflict: "announcement_id,institution_id", ignoreDuplicates: true })
      .select("institution_id")
  );
  const updated = check(
    await supabaseAdmin.from("announcements").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id).select().single()
  );
  return { announcement: updated, delivered: schools.length, email: messages.email, sms: messages.sms, whatsapp: messages.whatsapp, skippedChannels: a.channels.filter((c) => !DELIVERABLE.has(c)) };
}

/** What a school sees in its portal: anything sent that has not ended or expired. */
export async function listSchoolAnnouncements(institutionId: string) {
  const rows = check(
    await supabaseAdmin
      .from("announcement_deliveries")
      .select("delivered_at, read_at, announcements:announcement_id(id, title, body, kind, sent_at, ends_at, ended_at)")
      .eq("institution_id", institutionId)
      .order("delivered_at", { ascending: false })
      .limit(50)
  ) as unknown as { delivered_at: string; read_at: string | null; announcements: { id: string; title: string; body: string; kind: string; sent_at: string; ends_at: string | null; ended_at: string | null } | null }[];
  const now = Date.now();
  return rows
    .filter((r) => r.announcements && !r.announcements.ended_at && (!r.announcements.ends_at || new Date(r.announcements.ends_at).getTime() > now))
    .slice(0, 20)
    .map((r) => ({ ...r.announcements!, ended_at: undefined, delivered_at: r.delivered_at, read: !!r.read_at }));
}

export async function markAnnouncementRead(institutionId: string, announcementId: string) {
  check(
    await supabaseAdmin
      .from("announcement_deliveries")
      .update({ read_at: new Date().toISOString() })
      .eq("institution_id", institutionId)
      .eq("announcement_id", announcementId)
      .is("read_at", null)
      .select("announcement_id")
  );
  return { success: true };
}

/** Sends every scheduled announcement that is due. Safe to run on several servers: sends are de-duplicated. */
export async function sendDueAnnouncements(): Promise<number> {
  const due = check(
    await supabaseAdmin.from("announcements").select("id").eq("status", "scheduled").lte("scheduled_for", new Date().toISOString()).limit(20)
  ) as { id: string }[];
  let sent = 0;
  for (const { id } of due) {
    try {
      await sendAnnouncement(id);
      sent++;
    } catch (err) {
      // do not retry forever: hand it back to the team as a draft
      console.error("Scheduled announcement " + id + " could not be sent:", err instanceof Error ? err.message : err);
      await supabaseAdmin.from("announcements").update({ status: "draft", scheduled_for: null }).eq("id", id);
    }
  }
  return sent;
}

// ── templates ───────────────────────────────────────────────
export async function listTemplates() {
  return check(await supabaseAdmin.from("message_templates").select("*").order("name"));
}

export async function saveTemplate(input: { id?: string; name: string; channel: string; subject?: string | null; body: string; provider_template_id?: string | null; is_active?: boolean }) {
  const { id, ...fields } = input;
  const q = id
    ? supabaseAdmin.from("message_templates").update(fields).eq("id", id)
    : supabaseAdmin.from("message_templates").insert(fields);
  const row = check(await q.select().maybeSingle());
  if (!row) throw new HttpError(404, "Template not found.");
  return row;
}

export async function deleteTemplate(id: string) {
  const t = check(await supabaseAdmin.from("message_templates").select("key").eq("id", id).maybeSingle()) as { key: string | null } | null;
  if (t?.key) throw new HttpError(409, "System templates are used by the platform and cannot be deleted. Edit the text instead.");
  check(await supabaseAdmin.from("message_templates").delete().eq("id", id).select("id"));
  return { success: true };
}

export async function setTemplateActive(id: string, isActive: boolean) {
  const row = check(await supabaseAdmin.from("message_templates").update({ is_active: isActive }).eq("id", id).select().maybeSingle());
  if (!row) throw new HttpError(404, "Template not found.");
  return row;
}

// ── history ─────────────────────────────────────────────────
/**
 * One place for everything that went out: email, SMS and WhatsApp messages (Sent / Failed / Pending), plus the
 * announcements shown inside the school portal and the ones still waiting for their send time.
 */
export async function listHistory(query: Record<string, unknown>) {
  const messages = await listMessages(query);
  const inApp = check(
    await supabaseAdmin
      .from("announcements")
      .select("id, title, kind, status, scheduled_for, sent_at, channels, announcement_deliveries(count)")
      .in("status", ["sent", "scheduled"])
      .contains("channels", ["in_app"])
      .order("created_at", { ascending: false })
      .limit(50)
  ) as any[];
  return {
    ...messages,
    inApp: inApp.map((r) => ({
      id: r.id, title: r.title, kind: r.kind, status: r.status === "sent" ? "sent" : "queued", when: r.status === "sent" ? r.sent_at : r.scheduled_for,
      schools: r.announcement_deliveries?.[0]?.count ?? 0,
    })),
  };
}
