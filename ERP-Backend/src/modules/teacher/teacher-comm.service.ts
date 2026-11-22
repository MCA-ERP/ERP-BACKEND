import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { istDate, mySections, one, secLabel, sectionMap, whoAmI } from "./teacher.service";
import { pupils, requireSection } from "./teacher-classes.service";
import { mySubjectSections, notifyParents } from "./teacher-work.service";

/** School notices, parent-teacher meeting slots, chat, photo gallery and the class diary. Everything is this teacher's own. */
const uid = z.string().uuid();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const hhmm = (t: string) => t.slice(0, 5);

// ═════════════ school notices ═════════════
export async function circulars(inst: string, me: string) {
  const [rows, acks] = await Promise.all([
    supabaseAdmin.from("comm_circulars").select("id, code, title, audience, issued_by, circ_date, body").eq("institution_id", inst).eq("status", "Published").order("circ_date", { ascending: false }).limit(300),
    supabaseAdmin.from("comm_circular_acks").select("circular_id").eq("profile_id", me).limit(2000),
  ]);
  const A = new Set(((check(acks) ?? []) as { circular_id: string }[]).map((a) => a.circular_id));
  return { items: ((check(rows) ?? []) as { id: string; code: string; title: string; audience: string; issued_by: string; circ_date: string; body: string }[]).map((r) => ({ ...r, acknowledged: A.has(r.id) })) };
}
export async function acknowledge(inst: string, me: string, id: string) {
  if (!check(await supabaseAdmin.from("comm_circulars").select("id").eq("id", uid.parse(id)).eq("institution_id", inst).eq("status", "Published").maybeSingle())) throw new HttpError(404, "Circular not found.");
  check(await supabaseAdmin.from("comm_circular_acks").upsert({ circular_id: id, profile_id: me }, { onConflict: "circular_id,profile_id" }).select("circular_id"));
  return { ok: true };
}
export async function announcements(inst: string) {
  const today = istDate();
  const rows = (check(await supabaseAdmin.from("comm_announcements").select("id, title, audience, channels, send_on, status").eq("institution_id", inst).eq("status", "Scheduled").order("send_on", { ascending: false }).limit(300)) ?? []) as { id: string; title: string; audience: string; channels: string; send_on: string; status: string }[];
  return { items: rows.map((r) => ({ ...r, state: r.send_on > today ? "Scheduled" : "Published" })) };
}

// ═════════════ parent-teacher meeting ═════════════
async function nextMeeting(inst: string) {
  return check(await supabaseAdmin.from("calendar_events").select("id, title, event_date").eq("institution_id", inst).eq("kind", "PTM").eq("published", true).gte("event_date", istDate()).order("event_date").limit(1)) as { id: string; title: string; event_date: string }[];
}
const addMin = (t: string, n: number) => { const m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + n; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };

async function mySession(inst: string, me: string) {
  const ev = (await nextMeeting(inst))[0];
  if (!ev) return null;
  let s = check(await supabaseAdmin.from("ptm_sessions").select("id, meet_date, starts, ends, slot_minutes, room").eq("teacher_id", me).eq("meet_date", ev.event_date).maybeSingle()) as { id: string; meet_date: string; starts: string; ends: string; slot_minutes: number; room: string } | null;
  if (!s) {
    const m = await mySections(inst, me);
    const sm = await sectionMap(inst, m.classTeacherOf.slice(0, 1));
    const room = sm.get(m.classTeacherOf[0] ?? "")?.room ?? "";
    s = check(await supabaseAdmin.from("ptm_sessions").insert({ institution_id: inst, teacher_id: me, meet_date: ev.event_date, room: room ? `Room ${room}` : "" }).select("id, meet_date, starts, ends, slot_minutes, room").single()) as typeof s;
    const rows: { session_id: string; slot_time: string }[] = [];
    for (let t = hhmm(s!.starts); t < hhmm(s!.ends); t = addMin(t, s!.slot_minutes)) rows.push({ session_id: s!.id, slot_time: t });
    check(await supabaseAdmin.from("ptm_slots").insert(rows).select("id"));
  }
  return { ev, s: s! };
}

export async function ptmSlots(inst: string, me: string) {
  const r = await mySession(inst, me);
  if (!r) return { session: null, slots: [] as unknown[], booked: 0, free: 0, blocked: 0 };
  const slots = (check(await supabaseAdmin.from("ptm_slots").select("id, slot_time, status, topic, student_id, guardian_id, students:student_id(first_name, last_name), guardians:guardian_id(full_name)").eq("session_id", r.s.id).order("slot_time")) ?? []) as unknown as { id: string; slot_time: string; status: string; topic: string; students: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null; guardians: { full_name: string } | { full_name: string }[] | null; student_id: string | null }[];
  const sm = new Map<string, string>();
  const ids = slots.map((s) => s.student_id).filter(Boolean) as string[];
  if (ids.length) { const m = await mySections(inst, me); const k = await pupils(inst, m.ids); const secs = await sectionMap(inst, m.ids); for (const x of k) sm.set(x.id, secLabel(secs.get(x.section_id) ?? null)); }
  const out = slots.map((s) => { const st = one(s.students); return { id: s.id, time: hhmm(s.slot_time), status: s.status, student: st ? `${st.first_name} ${st.last_name}`.trim() : "", class_label: s.student_id ? sm.get(s.student_id) ?? "" : "", parent: one(s.guardians)?.full_name ?? "", topic: s.topic }; });
  const c = (s: string) => out.filter((x) => x.status === s || (s === "Booked" && x.status === "Met")).length;
  return { session: { date: r.s.meet_date, starts: hhmm(r.s.starts), ends: hhmm(r.s.ends), minutes: r.s.slot_minutes, room: r.s.room, title: r.ev.title }, slots: out, booked: c("Booked"), free: c("Free"), blocked: c("Blocked") };
}

export async function toggleSlot(inst: string, me: string, id: string) {
  const s = check(await supabaseAdmin.from("ptm_slots").select("id, status, session_id, ptm_sessions:session_id(teacher_id, institution_id)").eq("id", uid.parse(id)).maybeSingle()) as unknown as { id: string; status: string; ptm_sessions: { teacher_id: string; institution_id: string } | { teacher_id: string; institution_id: string }[] | null } | null;
  const own = one(s?.ptm_sessions ?? null);
  if (!s || !own || own.teacher_id !== me || own.institution_id !== inst) throw new HttpError(404, "Slot not found.");
  if (s.status !== "Free" && s.status !== "Blocked") throw new HttpError(409, "A booked slot cannot be changed here.");
  check(await supabaseAdmin.from("ptm_slots").update({ status: s.status === "Free" ? "Blocked" : "Free" }).eq("id", id).select("id"));
  return { ok: true };
}
export async function markMet(inst: string, me: string, id: string) {
  const s = check(await supabaseAdmin.from("ptm_slots").select("id, status, ptm_sessions:session_id(teacher_id, institution_id)").eq("id", uid.parse(id)).maybeSingle()) as unknown as { id: string; status: string; ptm_sessions: { teacher_id: string; institution_id: string } | { teacher_id: string; institution_id: string }[] | null } | null;
  const own = one(s?.ptm_sessions ?? null);
  if (!s || !own || own.teacher_id !== me || own.institution_id !== inst) throw new HttpError(404, "Booking not found.");
  if (s.status !== "Booked") throw new HttpError(409, "Only a booked slot can be marked met.");
  check(await supabaseAdmin.from("ptm_slots").update({ status: "Met" }).eq("id", id).select("id"));
  return { ok: true };
}

// ═════════════ chat ═════════════
async function ensureThreads(inst: string, me: string) {
  const [m, { list, sm }] = await Promise.all([mySections(inst, me), mySubjectSections(inst, me)]);
  const have = (check(await supabaseAdmin.from("chat_threads").select("id, title, section_id, kind, chat_members!inner(profile_id)").eq("institution_id", inst).eq("chat_members.profile_id", me).limit(200)) ?? []) as unknown as { id: string; title: string; section_id: string | null }[];
  const want: { title: string; subtitle: string; section_id: string }[] = [];
  for (const id of m.classTeacherOf) want.push({ title: `${secLabel(sm.get(id) ?? null)} parents`, subtitle: "Class group", section_id: id });
  for (const s of list) want.push({ title: `${s.label} · ${s.subject}`, subtitle: "Subject group", section_id: s.id });
  for (const w of want) {
    if (have.some((h) => h.title === w.title && h.section_id === w.section_id)) continue;
    const t = check(await supabaseAdmin.from("chat_threads").insert({ institution_id: inst, kind: "group", title: w.title, subtitle: w.subtitle, section_id: w.section_id, created_by: me }).select("id").single()) as { id: string };
    check(await supabaseAdmin.from("chat_members").insert({ thread_id: t.id, profile_id: me }).select("id"));
  }
}

export async function chatThreads(inst: string, me: string) {
  await ensureThreads(inst, me);
  const th = (check(await supabaseAdmin.from("chat_threads").select("id, title, subtitle, chat_members!inner(profile_id)").eq("institution_id", inst).eq("chat_members.profile_id", me).order("created_at").limit(200)) ?? []) as unknown as { id: string; title: string; subtitle: string }[];
  const last = th.length ? (check(await supabaseAdmin.from("chat_messages").select("thread_id, body, file_name, created_at").eq("institution_id", inst).in("thread_id", th.map((t) => t.id)).order("created_at", { ascending: false }).limit(2000)) ?? []) as { thread_id: string; body: string; file_name: string | null; created_at: string }[] : [];
  return { items: th.map((t) => { const l = last.find((x) => x.thread_id === t.id); return { id: t.id, title: t.title, subtitle: t.subtitle, last: l ? l.body || (l.file_name ? `📎 ${l.file_name}` : "") : "", last_at: l?.created_at ?? null }; }).sort((a, b) => ((a.last_at ?? "") < (b.last_at ?? "") ? 1 : -1)) };
}

async function member(me: string, threadId: string, inst: string) {
  const t = check(await supabaseAdmin.from("chat_threads").select("id, title, subtitle, chat_members!inner(profile_id)").eq("id", uid.parse(threadId)).eq("institution_id", inst).eq("chat_members.profile_id", me).maybeSingle()) as unknown as { id: string; title: string; subtitle: string } | null;
  if (!t) throw new HttpError(404, "Chat not found.");
  return t;
}

export async function chatMessages(inst: string, me: string, threadId: string) {
  const t = await member(me, threadId, inst);
  const rows = (check(await supabaseAdmin.from("chat_messages").select("id, body, file_name, created_at, sender_profile_id, sender_guardian_id, who:sender_profile_id(first_name, last_name), guardians:sender_guardian_id(full_name)").eq("thread_id", threadId).eq("institution_id", inst).order("created_at").limit(500)) ?? []) as unknown as { id: string; body: string; file_name: string | null; created_at: string; sender_profile_id: string | null; who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null; guardians: { full_name: string } | { full_name: string }[] | null }[];
  return { thread: { id: t.id, title: t.title, subtitle: t.subtitle }, messages: rows.map((r) => { const w = one(r.who); return { id: r.id, mine: r.sender_profile_id === me, from: w ? `${w.first_name} ${w.last_name}`.trim() : one(r.guardians)?.full_name ?? "", body: r.body, file_name: r.file_name ?? "", at: r.created_at }; }) };
}

export async function sendChat(inst: string, me: string, threadId: string, input: unknown) {
  const i = z.object({ body: z.string().trim().max(2000).optional(), file_name: z.string().trim().max(160).optional() }).strict().parse(input);
  if (!i.body && !i.file_name) throw new HttpError(400, "Write a message or attach a file.");
  await member(me, threadId, inst);
  return check(await supabaseAdmin.from("chat_messages").insert({ institution_id: inst, thread_id: threadId, sender_profile_id: me, body: i.body ?? "", file_name: i.file_name || null }).select("id").single());
}

export async function sharedFiles(inst: string, me: string) {
  const th = (check(await supabaseAdmin.from("chat_threads").select("id, title, chat_members!inner(profile_id)").eq("institution_id", inst).eq("chat_members.profile_id", me).limit(200)) ?? []) as unknown as { id: string; title: string }[];
  if (!th.length) return { items: [] };
  const rows = (check(await supabaseAdmin.from("chat_messages").select("id, thread_id, file_name, created_at, who:sender_profile_id(first_name, last_name), guardians:sender_guardian_id(full_name)").eq("institution_id", inst).in("thread_id", th.map((t) => t.id)).not("file_name", "is", null).order("created_at", { ascending: false }).limit(300)) ?? []) as unknown as { id: string; thread_id: string; file_name: string; created_at: string; who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null; guardians: { full_name: string } | { full_name: string }[] | null }[];
  return { items: rows.map((r) => { const w = one(r.who); return { id: r.id, file: r.file_name, by: w ? `${w.first_name} ${w.last_name}`.trim() : one(r.guardians)?.full_name ?? "", in: th.find((t) => t.id === r.thread_id)?.title ?? "", at: r.created_at }; }) };
}

// ═════════════ photo gallery ═════════════
export async function albums(inst: string, me: string) {
  const [rows, ev, m] = await Promise.all([
    supabaseAdmin.from("gallery_albums").select("id, title, event, album_date, audience, photo_count, caption, uploaded_by, uploaded_by_id, status").eq("institution_id", inst).order("album_date", { ascending: false }).limit(200),
    supabaseAdmin.from("event_mgmt").select("title").eq("institution_id", inst).order("event_date", { ascending: false }).limit(30),
    mySections(inst, me),
  ]);
  const sm = await sectionMap(inst, m.ids);
  const all = (check(rows) ?? []) as { id: string; title: string; event: string; album_date: string; audience: string; photo_count: number; caption: string; uploaded_by: string; uploaded_by_id: string | null; status: string }[];
  return {
    items: all.filter((a) => a.status === "Published" || a.uploaded_by_id === me).map((a) => ({ id: a.id, title: a.title, event: a.event, date: a.album_date, audience: a.audience, photos: a.photo_count, caption: a.caption, by: a.uploaded_by, mine: a.uploaded_by_id === me, status: a.status })),
    events: [...new Set([...(check(ev) ?? []).map((e: { title: string }) => e.title), "Class activity"])].map((e) => e.slice(0, 40)),
    audiences: m.ids.map((id) => secLabel(sm.get(id) ?? null)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };
}

export async function uploadAlbum(inst: string, me: string, input: unknown) {
  const i = z.object({ title: z.string().trim().min(3, "Enter the album title.").max(160), event: z.string().trim().min(1).max(40), date: iso, audience: z.string().trim().min(1).max(40), photos: z.number().int().min(1, "Choose at least one photo.").max(200), caption: z.string().trim().max(200).optional(), blur: z.boolean(), download: z.boolean(), notify: z.boolean() }).strict().parse(input);
  const m = await mySections(inst, me); const sm = await sectionMap(inst, m.ids);
  if (!m.ids.some((id) => secLabel(sm.get(id) ?? null) === i.audience)) throw new HttpError(403, "Choose one of your own classes.");
  const who = await whoAmI(inst, me);
  return check(await supabaseAdmin.from("gallery_albums").insert({ institution_id: inst, title: i.title, event: i.event, album_date: i.date, audience: i.audience, photo_count: i.photos, caption: i.caption ?? "", blur_no_consent: i.blur, allow_download: i.download, notify_parents: i.notify, uploaded_by: who.name.slice(0, 80), uploaded_by_id: me, status: "Pending approval" }).select("id").single());
}

// ═════════════ class diary ═════════════
export async function diary(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [sm, tpl, rows, kids] = await Promise.all([
    sectionMap(inst, m.ids),
    supabaseAdmin.from("comm_diary_templates").select("id, name, body").eq("institution_id", inst).order("name"),
    supabaseAdmin.from("comm_diary").select("id, section_id, class_label, entry, diary_date, status, ask_ack, attachment_name, kind, student_id").eq("institution_id", inst).eq("created_by", me).eq("kind", "Class diary").order("diary_date", { ascending: false }).order("id").limit(300),
    pupils(inst, m.ids),
  ]);
  const R = (check(rows) ?? []) as { id: string; section_id: string | null; class_label: string; entry: string; diary_date: string; status: string; ask_ack: boolean; attachment_name: string | null }[];
  const seen = R.length ? (check(await supabaseAdmin.from("comm_diary_seen").select("diary_id").in("diary_id", R.map((r) => r.id)).limit(50000)) ?? []) as { diary_id: string }[] : [];
  return {
    sections: m.ids.map((id) => ({ id, label: secLabel(sm.get(id) ?? null), is_mine: m.classTeacherOf.includes(id), students: kids.filter((k) => k.section_id === id).length })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    templates: ((check(tpl) ?? []) as { id: string; name: string; body: string }[]),
    items: R.map((r) => { const total = kids.filter((k) => k.section_id === r.section_id).length; const n = seen.filter((s) => s.diary_id === r.id).length; return { id: r.id, date: r.diary_date, class_label: r.class_label, entry: r.entry, seen: n, total, status: r.status === "Acknowledged" || (total > 0 && n >= total) ? "Acknowledged" : "Sent", attachment: r.attachment_name ?? "", ask_ack: r.ask_ack }; }),
  };
}

export async function addDiary(inst: string, me: string, input: unknown) {
  const i = z.object({ section_id: uid, date: iso, entry: z.string().trim().min(3, "Write the entry.").max(500), ask_ack: z.boolean(), attachment_name: z.string().trim().max(160).optional() }).strict().parse(input);
  await requireSection(inst, me, i.section_id);
  const sm = await sectionMap(inst, [i.section_id]); const who = await whoAmI(inst, me);
  if (i.date > istDate()) throw new HttpError(400, "A diary entry cannot be dated in the future.");
  const row = check(await supabaseAdmin.from("comm_diary").insert({ institution_id: inst, class_label: secLabel(sm.get(i.section_id) ?? null), kind: "Class diary", entry: i.entry, by_name: who.name.slice(0, 80), diary_date: i.date, status: "Sent", section_id: i.section_id, created_by: me, ask_ack: i.ask_ack, attachment_name: i.attachment_name || null }).select("id").single());
  await notifyParents(inst, me, (await pupils(inst, [i.section_id])).map((k) => k.id), `Class diary · ${secLabel(sm.get(i.section_id) ?? null)}`, i.entry);
  return row;
}

export async function remarks(inst: string, me: string) {
  const m = await mySections(inst, me);
  const [kids, sm, rows] = await Promise.all([pupils(inst, m.ids), sectionMap(inst, m.ids), supabaseAdmin.from("comm_diary").select("id, student_id, entry, diary_date, class_label").eq("institution_id", inst).eq("created_by", me).eq("kind", "Teacher remark").order("diary_date", { ascending: false }).limit(300)]);
  const K = new Map(kids.map((k) => [k.id, k]));
  return { students: kids.map((k) => ({ id: k.id, label: `${k.roll_no}. ${k.name} · ${secLabel(sm.get(k.section_id) ?? null)}`, section_id: k.section_id })), items: ((check(rows) ?? []) as { id: string; student_id: string | null; entry: string; diary_date: string; class_label: string }[]).map((r) => ({ id: r.id, date: r.diary_date, student: r.student_id ? K.get(r.student_id)?.name ?? "" : "", class_label: r.class_label, entry: r.entry })) };
}

export async function addRemark(inst: string, me: string, input: unknown) {
  const i = z.object({ student_id: uid, entry: z.string().trim().min(3, "Write the remark.").max(500) }).strict().parse(input);
  const m = await mySections(inst, me);
  const k = (await pupils(inst, m.ids)).find((x) => x.id === i.student_id);
  if (!k) throw new HttpError(403, "That student is not in one of your classes.");
  const sm = await sectionMap(inst, [k.section_id]); const who = await whoAmI(inst, me);
  const row = check(await supabaseAdmin.from("comm_diary").insert({ institution_id: inst, class_label: secLabel(sm.get(k.section_id) ?? null), kind: "Teacher remark", entry: i.entry, by_name: who.name.slice(0, 80), status: "Sent", section_id: k.section_id, student_id: k.id, created_by: me, ask_ack: false }).select("id").single());
  await notifyParents(inst, me, [k.id], `Remark about ${k.name}`, i.entry);
  return row;
}
