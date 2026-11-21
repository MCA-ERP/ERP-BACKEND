import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** Communication, part 2: school diary, parent conversations, reports, chatbot, photo gallery, chat moderation.
 *  Diary entries, parent conversations, chatbot conversations and chat reports are written by the Teacher / Parent apps
 *  and the assistant, which are not connected yet; this side lists and manages them. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

// ═════════════ school diary ═════════════
const DIARY_DEFAULTS: [string, string][] = [["Bring materials", "Bring {item} tomorrow for {activity}."], ["Test or quiz notice", "{subject} quiz on {day}: {topics}."], ["Sign and return", "{document} sent home today. Please sign and return."], ["Homework not done", "{name} did not complete homework {count} times this week. Please check the diary daily."], ["Appreciation", "Excellent work by {name} in {activity}."], ["Reminder", "{notice} from {date}."], ["Consent form", "Consent form for {trip} due by {date}."]];
export async function diary(inst: string) {
  if (!(check(await supabaseAdmin.from("comm_diary_templates").select("id").eq("institution_id", inst).limit(1)) as unknown[]).length) check(await supabaseAdmin.from("comm_diary_templates").insert(DIARY_DEFAULTS.map(([name, body]) => ({ institution_id: inst, name, body }))).select("id"));
  const [d, t] = await Promise.all([supabaseAdmin.from("comm_diary").select("id, class_label, kind, entry, by_name, diary_date, status, template_id").eq("institution_id", inst).order("diary_date", { ascending: false }).limit(3000), supabaseAdmin.from("comm_diary_templates").select("id, name, body").eq("institution_id", inst).order("name")]);
  const D = check(d) as { id: string; class_label: string; kind: string; entry: string; by_name: string; diary_date: string; status: string; template_id: string | null }[];
  return { items: D, templates: (check(t) as { id: string; name: string; body: string }[]).map((x) => ({ ...x, used: D.filter((y) => y.template_id === x.id).length })) };
}
export async function addDiary(inst: string, input: unknown) {
  const i = z.object({ class_label: z.string().trim().min(1).max(40), kind: z.enum(["Class diary", "Teacher remark"]), entry: z.string().trim().min(2).max(500), by_name: z.string().trim().min(2).max(80), template_id: uid.nullable().optional() }).strict().parse(input);
  return check(await supabaseAdmin.from("comm_diary").insert({ institution_id: inst, ...i, template_id: i.template_id ?? null, diary_date: today() }).select("id").single());
}
export async function ackDiary(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("comm_diary").update({ status: "Acknowledged" }).eq("id", id).eq("institution_id", inst).eq("status", "Sent").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "Already acknowledged."); return { ok: true };
}
const tpl = z.object({ name: z.string().trim().min(2, "Enter the template name.").max(80), body: z.string().trim().min(2, "Enter the wording.").max(300) }).strict();
export async function addDiaryTemplate(inst: string, input: unknown) {
  const i = tpl.parse(input); if ((check(await supabaseAdmin.from("comm_diary_templates").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[]).length) throw new HttpError(409, "That template exists.");
  return check(await supabaseAdmin.from("comm_diary_templates").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function editDiaryTemplate(inst: string, id: string, input: unknown) {
  const i = tpl.parse(input); const r = check(await supabaseAdmin.from("comm_diary_templates").update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ parent conversations ═════════════
export async function conversations(inst: string) {
  return { items: check(await supabaseAdmin.from("comm_conversations").select("id, parent_name, student_name, teacher_name, last_message, kind, status, created_at").eq("institution_id", inst).order("created_at", { ascending: false }).limit(3000)) as { id: string; parent_name: string; student_name: string; teacher_name: string; last_message: string; kind: string; status: string; created_at: string }[] };
}

// ═════════════ communication reports ═════════════
export async function allMessages(inst: string) {
  return { items: check(await supabaseAdmin.from("comm_messages").select("id, ref, channel, title, message, audience, class_label, recipients, send_on, status").eq("institution_id", inst).order("created_at", { ascending: false }).limit(3000)) as { id: string; ref: string; channel: string; title: string; message: string; audience: string; class_label: string; recipients: number; send_on: string; status: string }[] };
}

// ═════════════ chatbot ═════════════
const FAQ_DEFAULTS: [string, string][] = [["Leave", "How do I apply for leave?"], ["Uniform", "Where can I buy uniforms and books?"], ["Transport", "How do I change my child's bus stop?"], ["Certificates", "How do I get a transfer certificate?"], ["Timings", "What are the school timings?"], ["Fees", "How can I pay fees?"], ["Admissions", "How do I apply for admission?"]];
export async function chatbot(inst: string) {
  if (!(check(await supabaseAdmin.from("chatbot_faqs").select("id").eq("institution_id", inst).limit(1)) as unknown[]).length) check(await supabaseAdmin.from("chatbot_faqs").insert(FAQ_DEFAULTS.map(([topic, question]) => ({ institution_id: inst, topic, question }))).select("id"));
  const wk = new Date(Date.now() - 7 * 86400000).toISOString();
  const [c, u, f] = await Promise.all([supabaseAdmin.from("chatbot_conversations").select("id, channel, who, preview, messages, outcome, rating, topic, language, handed_to, enquiry, reply_seconds, created_at").eq("institution_id", inst).order("created_at", { ascending: false }).limit(5000), supabaseAdmin.from("chatbot_unanswered").select("id, question, times_asked, channel, sent_to").eq("institution_id", inst).eq("answered", false).order("times_asked", { ascending: false }), supabaseAdmin.from("chatbot_faqs").select("id, topic, question, answer, enabled, used").eq("institution_id", inst).order("topic")]);
  const C = check(c) as { id: string; channel: string; who: string; preview: string; messages: number; outcome: string; rating: string | null; topic: string; language: string; handed_to: string | null; enquiry: boolean; reply_seconds: number | null; created_at: string }[]; const W = C.filter((x) => x.created_at >= wk);
  const tally = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]) as [string, number][]; };
  const rated = C.filter((x) => x.rating); const rs = C.filter((x) => x.reply_seconds !== null); const hrs = tally(C.map((x) => String(new Date(x.created_at).getHours())));
  const langs = tally(C.map((x) => x.language));
  return {
    conversations: C.slice(0, 50), unanswered: check(u) as { id: string; question: string; times_asked: number; channel: string; sent_to: string }[], faqs: check(f) as { id: string; topic: string; question: string; answer: string; enabled: boolean; used: number }[],
    week: W.length, week_whatsapp: W.filter((x) => x.channel === "WhatsApp").length, week_website: W.filter((x) => x.channel === "Website").length, no_staff: W.length ? Math.round((W.filter((x) => !x.handed_to).length / W.length) * 100) : null, handed: W.filter((x) => x.handed_to).length, enquiries: W.filter((x) => x.enquiry).length,
    helpful: rated.length ? Math.round((rated.filter((x) => x.rating === "Helpful").length / rated.length) * 100) : null, ratings: rated.length, avg_reply: rs.length ? Math.round(rs.reduce((n, x) => n + (x.reply_seconds ?? 0), 0) / rs.length) : null,
    busiest: hrs[0] ? Number(hrs[0][0]) : null, languages: langs.map(([l, n]) => [l, Math.round((n / C.length) * 100)] as [string, number]), topics: tally(W.map((x) => x.topic)).slice(0, 6), handed_to: tally(W.map((x) => x.handed_to ?? "")).slice(0, 6),
  };
}
export async function answerUnanswered(inst: string, id: string, input: unknown) {
  const { answer, topic } = z.object({ answer: z.string().trim().min(2, "Write the answer.").max(1000), topic: z.string().trim().max(40).optional() }).strict().parse(input);
  const q = check(await supabaseAdmin.from("chatbot_unanswered").select("id, question").eq("id", id).eq("institution_id", inst).eq("answered", false).maybeSingle()) as { id: string; question: string } | null; if (!q) throw new HttpError(404, "Not found.");
  const ex = check(await supabaseAdmin.from("chatbot_faqs").select("id").eq("institution_id", inst).eq("question", q.question).maybeSingle()) as { id: string } | null;
  if (ex) check(await supabaseAdmin.from("chatbot_faqs").update({ answer, enabled: true }).eq("id", ex.id).eq("institution_id", inst).select("id")); else check(await supabaseAdmin.from("chatbot_faqs").insert({ institution_id: inst, topic: topic || "General", question: q.question, answer, enabled: true }).select("id"));
  check(await supabaseAdmin.from("chatbot_unanswered").update({ answered: true }).eq("id", id).eq("institution_id", inst).select("id")); return { ok: true };
}
export async function editFaq(inst: string, id: string, input: unknown) {
  const i = z.object({ answer: z.string().trim().max(1000).optional(), enabled: z.boolean().optional() }).strict().parse(input);
  if (i.enabled && i.answer !== undefined && !i.answer) throw new HttpError(400, "Write an answer before turning it on.");
  if (i.enabled) { const cur = check(await supabaseAdmin.from("chatbot_faqs").select("answer").eq("id", id).eq("institution_id", inst).maybeSingle()) as { answer: string } | null; if (!cur) throw new HttpError(404, "Not found."); if (!(i.answer ?? cur.answer)) throw new HttpError(400, "Write an answer before turning it on."); }
  const r = check(await supabaseAdmin.from("chatbot_faqs").update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ photo gallery ═════════════
export const EVENTS = ["Children's Day carnival", "Annual Day", "Sports Day", "Diwali celebrations", "Field trip", "Class activity", "Other"];
export async function albums(inst: string) {
  const [a, c] = await Promise.all([supabaseAdmin.from("gallery_albums").select("id, title, event, album_date, audience, photo_count, caption, uploaded_by, status").eq("institution_id", inst).order("album_date", { ascending: false }).limit(2000), supabaseAdmin.from("gallery_consent").select("id").eq("institution_id", inst).eq("status", "Waiting for parent")]);
  const A = check(a) as { id: string; title: string; event: string; album_date: string; audience: string; photo_count: number; caption: string; uploaded_by: string; status: string }[]; const yr = today().slice(0, 4);
  return { events: EVENTS, items: A, year_albums: A.filter((x) => x.status === "Published" && x.album_date.startsWith(yr)).length, photos: A.filter((x) => x.status === "Published").reduce((n, x) => n + x.photo_count, 0), waiting: A.filter((x) => x.status === "Pending approval").length, no_consent: (check(c) as unknown[]).length };
}
export async function addAlbum(inst: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(2, "Enter the album title.").max(160), event: z.enum(EVENTS as [string, ...string[]]), album_date: date, audience: z.string().trim().min(1).max(40), photo_count: z.number().int().min(1, "Choose at least one photo.").max(200, "An album holds up to 200 photos."), caption: z.string().trim().max(200).optional(), blur_no_consent: z.boolean(), allow_download: z.boolean(), notify_parents: z.boolean(), uploaded_by: z.string().trim().max(80).optional() }).strict().parse(input);
  return check(await supabaseAdmin.from("gallery_albums").insert({ institution_id: inst, ...i, caption: i.caption ?? "", uploaded_by: i.uploaded_by ?? "", status: "Published" }).select("id").single());
}
export async function decideAlbum(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["publish", "send_back"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("gallery_albums").update({ status: action === "publish" ? "Published" : "Sent back" }).eq("id", id).eq("institution_id", inst).eq("status", "Pending approval").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That was already decided."); return { ok: true };
}
export async function consent(inst: string) {
  return { items: check(await supabaseAdmin.from("gallery_consent").select("id, student_name, class_label, parent_name, reason, recorded_on, status").eq("institution_id", inst).eq("status", "Waiting for parent").order("recorded_on", { ascending: false }).limit(3000)) as { id: string; student_name: string; class_label: string; parent_name: string; reason: string; recorded_on: string; status: string }[] };
}
export async function consentReceived(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("gallery_consent").update({ status: "Received" }).eq("id", id).eq("institution_id", inst).eq("status", "Waiting for parent").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "Already updated."); return { ok: true };
}

// ═════════════ chat moderation ═════════════
export async function chatReports(inst: string) {
  return { items: check(await supabaseAdmin.from("chat_reports").select("id, code, chat, reported_by, reason, reported_on, decision, decision_note").eq("institution_id", inst).order("reported_on", { ascending: false }).order("code", { ascending: false }).limit(3000)) as { id: string; code: string; chat: string; reported_by: string; reason: string; reported_on: string; decision: string; decision_note: string | null }[] };
}
export async function decideChatReport(inst: string, id: string, input: unknown) {
  const i = z.object({ action: z.enum(["keep", "remove"]), note: z.string().trim().max(200).optional() }).strict().parse(input);
  if (i.action === "remove" && !i.note) throw new HttpError(400, "Say why the message is removed; the sender is told.");
  const r = check(await supabaseAdmin.from("chat_reports").update({ decision: i.action === "keep" ? "Kept" : "Removed", decision_note: i.note ?? null }).eq("id", id).eq("institution_id", inst).eq("decision", "Open").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That was already decided."); return { ok: true };
}
const RULES = z.object({ opens_at: z.string().regex(/^\d{2}:\d{2}$/), closes_at: z.string().regex(/^\d{2}:\d{2}$/), parents_can_message: z.string().trim().min(1).max(40), keep_history: z.string().trim().min(1).max(20), blocked_words: z.string().max(2000), groups_announcement_only: z.boolean(), students_groups_only: z.boolean(), show_read_ticks: z.boolean() }).strict();
export async function chatRules(inst: string) {
  const r = check(await supabaseAdmin.from("chat_rules").select("opens_at, closes_at, parents_can_message, keep_history, blocked_words, groups_announcement_only, students_groups_only, show_read_ticks").eq("institution_id", inst).maybeSingle());
  return r ?? { opens_at: "08:00", closes_at: "18:00", parents_can_message: "Class teacher and subject teachers", keep_history: "The academic year", blocked_words: "", groups_announcement_only: true, students_groups_only: true, show_read_ticks: true };
}
export async function saveChatRules(inst: string, input: unknown) {
  const i = RULES.parse(input); if (i.closes_at <= i.opens_at) throw new HttpError(400, "Chats must close after they open.");
  check(await supabaseAdmin.from("chat_rules").upsert({ institution_id: inst, ...i }).select("institution_id")); return { ok: true };
}

export async function chatActivity(inst: string) {
  const ms = `${today().slice(0, 7)}-01`; const r = check(await supabaseAdmin.from("chat_reports").select("decision").eq("institution_id", inst).gte("reported_on", ms)) as { decision: string }[];
  return { messages: null as number | null, active_parents: null as number | null, reply_hours: null as number | null, reported: r.length, open: r.filter((x) => x.decision === "Open").length, groups: [] as [string, number][], files: [] as [string, number][] };
}
