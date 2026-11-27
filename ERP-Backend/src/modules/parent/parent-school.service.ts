import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { addStudentLeave } from "../school/attendance3.service";
import { requestCert } from "../school/health2.service";
import { addRequest } from "../school/parent-extra.service";
import { one } from "../teacher/teacher.service";
import { childOf, family, forFamily, hhmm, today, type Child } from "./parent-core";

/** Requests, messages to teachers, parent-teacher meetings, notices, events, gallery, bus, health, library and mess. */
const uid = z.string().uuid("Invalid id.");
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const txt = (n: number) => z.string().trim().max(n);
type Named = { name: string } | { name: string }[] | null;
type Person = { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
const who = (p: Person) => { const x = one(p); return x ? `${x.first_name} ${x.last_name}`.trim() : ""; };

// ═════════════ requests ═════════════
export const REQUEST_TYPES = ["leave", "certificate", "transport", "mess", "medical", "correction"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
/** The plan module a kind of request needs, besides the parent app itself. */
export const REQUEST_MODULES: Record<RequestType, string[]> = { leave: ["attendance"], certificate: ["certificates"], transport: ["transport"], mess: ["cafeteria", "hostel"], medical: ["health_welfare"], correction: [] };

export async function requests(inst: string, me: string, mods: string[], studentId?: unknown) {
  const { fam, child } = await childOf(inst, me, studentId);
  const have = (t: RequestType) => !REQUEST_MODULES[t].length || REQUEST_MODULES[t].some((m) => mods.includes(m));
  const none = Promise.resolve({ data: [], error: null });
  const [leave, cert, par, mess, med, routes] = await Promise.all([
    have("leave") ? supabaseAdmin.from("student_leaves").select("id, code, leave_type, from_date, to_date, days, applied_on, status").eq("institution_id", inst).eq("student_id", child.id).order("applied_on", { ascending: false }).limit(100) : none,
    have("certificate") ? supabaseAdmin.from("certificates").select("id, code, kind, purpose, requested_on, status").eq("institution_id", inst).eq("student_id", child.id).order("requested_on", { ascending: false }).limit(100) : none,
    supabaseAdmin.from("parent_requests").select("id, code, kind, req_type, details, student_id, raised_on, status").eq("institution_id", inst).in("guardian_id", fam.guardianIds).order("raised_on", { ascending: false }).limit(200),
    have("mess") ? supabaseAdmin.from("mess_requests").select("id, code, meals, diet, requested_on, status").eq("institution_id", inst).eq("student_id", child.id).order("requested_on", { ascending: false }).limit(50) : none,
    have("medical") ? supabaseAdmin.from("parent_health_updates").select("id, code, kind, details, sent_on, status").eq("institution_id", inst).eq("student_id", child.id).order("sent_on", { ascending: false }).limit(50) : none,
    have("transport") ? supabaseAdmin.from("tr_stops").select("name, ord, status, tr_routes:route_id(name, status)").eq("institution_id", inst).order("ord").limit(2000) : none,
  ]);
  type Row = { id: string; code: string; type: string; details: string; date: string; status: string };
  const items: Row[] = [
    ...((check(leave) ?? []) as { id: string; code: string; leave_type: string; from_date: string; to_date: string; days: number; applied_on: string; status: string }[]).map((r) => ({ id: r.id, code: r.code, type: "Leave", details: `${r.leave_type} · ${r.from_date}${r.to_date === r.from_date ? "" : ` to ${r.to_date}`} · ${r.days} day${r.days === 1 ? "" : "s"}`, date: r.applied_on, status: r.status })),
    ...((check(cert) ?? []) as { id: string; code: string; kind: string; purpose: string; requested_on: string; status: string }[]).map((r) => ({ id: r.id, code: r.code, type: `${r.kind} certificate`, details: r.purpose ?? "", date: r.requested_on, status: r.status })),
    ...((check(par) ?? []) as { id: string; code: string; kind: string; req_type: string | null; details: string; student_id: string | null; raised_on: string; status: string }[]).filter((r) => !r.student_id || r.student_id === child.id).map((r) => ({ id: r.id, code: r.code, type: r.req_type || (r.kind === "mobile" ? "Mobile number change" : r.kind === "correction" ? "Correction" : r.kind === "leave" ? "Leave" : "Request"), details: r.details, date: r.raised_on, status: r.status === "Sent" ? "Pending" : r.status })),
    ...((check(mess) ?? []) as { id: string; code: string; meals: string; diet: string; requested_on: string; status: string }[]).map((r) => ({ id: r.id, code: r.code, type: "Mess", details: `${r.meals} · ${r.diet}`, date: r.requested_on, status: r.status })),
    ...((check(med) ?? []) as { id: string; code: string; kind: string; details: string; sent_on: string; status: string }[]).map((r) => ({ id: r.id, code: r.code, type: r.kind, details: r.details, date: r.sent_on, status: r.status })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const stops = ((check(routes) ?? []) as unknown as { name: string; status: string; tr_routes: { name: string; status: string } | { name: string; status: string }[] | null }[]).filter((s) => s.status === "Active" && one(s.tr_routes)?.status === "Active").map((s) => `${one(s.tr_routes)!.name} · ${s.name}`);
  return { types: REQUEST_TYPES.filter(have), items, stops };
}

const bodies = {
  leave: z.object({ leave_type: z.enum(["Sick leave", "Family function", "Travel", "Other"]), from_date: iso, to_date: iso }),
  certificate: z.object({ kind: z.enum(["Bonafide", "Study", "Conduct", "Character", "Transfer"]), purpose: txt(120).min(2, "Enter the purpose.") }),
  transport: z.object({ details: txt(200).min(3, "Choose the route and stop you need.") }),
  mess: z.object({ meals: z.enum(["Lunch", "Lunch + snacks"]), diet: z.enum(["Veg", "Non-veg", "Jain"]), start_on: iso }),
  medical: z.object({ kind: z.enum(["Vaccination card", "Medical note"]), details: txt(300).min(3, "Write the details."), attachment: txt(120).regex(/^$|\.(pdf|jpe?g|png)$/i, "Attach a PDF, JPG or PNG file.").optional() }),
  correction: z.object({ details: txt(400).min(3, "Say what needs correcting.") }),
};

export async function raise(inst: string, me: string, mods: string[], input: unknown) {
  const head = z.object({ type: z.enum(REQUEST_TYPES), student_id: uid }).passthrough().parse(input);
  const { type, student_id, ...rest } = head;
  if (REQUEST_MODULES[type].length && !REQUEST_MODULES[type].some((m) => mods.includes(m))) throw new HttpError(403, "Your school's plan does not include this feature.");
  const { fam, child } = await childOf(inst, me, student_id);
  const g = fam.guardian;
  if (type === "leave") {
    const i = bodies.leave.strict().parse(rest);
    if (i.from_date < new Date(Date.parse(today()) - 14 * 86400000).toISOString().slice(0, 10)) throw new HttpError(400, "Leave can be applied for the last two weeks or a future date.");
    return addStudentLeave(inst, { student_id: child.id, ...i }, me);
  }
  if (type === "certificate") {
    const i = bodies.certificate.strict().parse(rest);
    const open = (check(await supabaseAdmin.from("certificates").select("id").eq("institution_id", inst).eq("student_id", child.id).eq("kind", i.kind).eq("status", "Pending").limit(1)) ?? []) as unknown[];
    if (open.length) throw new HttpError(409, "That certificate is already requested.");
    return requestCert(inst, { kind: i.kind, student_id: child.id, purpose: i.purpose });
  }
  if (type === "transport") return addRequest(inst, { kind: "app", guardian_id: g.id, student_id: child.id, req_type: "Transport change", details: bodies.transport.strict().parse(rest).details }, me);
  if (type === "correction") return addRequest(inst, { kind: "correction", guardian_id: g.id, student_id: child.id, req_type: "Correction", details: bodies.correction.strict().parse(rest).details }, me);
  if (type === "mess") {
    const i = bodies.mess.strict().parse(rest);
    const open = (check(await supabaseAdmin.from("mess_requests").select("id").eq("institution_id", inst).eq("student_id", child.id).eq("status", "Pending").limit(1)) ?? []) as unknown[];
    if (open.length) throw new HttpError(409, "A mess request is already waiting.");
    return check(await supabaseAdmin.from("mess_requests").insert({ institution_id: inst, student_id: child.id, ...i, parent_name: g.full_name.slice(0, 80) }).select("id, code").single());
  }
  const i = bodies.medical.strict().parse(rest);
  return check(await supabaseAdmin.from("parent_health_updates").insert({ institution_id: inst, student_id: child.id, parent_name: g.full_name.slice(0, 80), kind: i.kind, details: i.details, attachment: i.attachment ?? "" }).select("id, code").single());
}

// ═════════════ teachers and messages ═════════════
/** The class teacher and subject teachers of one child's class. */
export async function teachersOf(inst: string, child: Child) {
  if (!child.section_id) return [] as { id: string; name: string; role: string }[];
  const [tt, ts] = await Promise.all([
    supabaseAdmin.from("tt_slots").select("teacher_id, subjects:subject_id(name)").eq("institution_id", inst).eq("section_id", child.section_id).not("teacher_id", "is", null).limit(500),
    supabaseAdmin.from("teacher_subjects").select("teacher_id, subjects:subject_id(name)").eq("institution_id", inst).eq("section_id", child.section_id).limit(200),
  ]);
  const roles = new Map<string, Set<string>>();
  if (child.class_teacher_id) roles.set(child.class_teacher_id, new Set(["Class teacher"]));
  for (const r of [...((check(tt) ?? []) as unknown as { teacher_id: string; subjects: Named }[]), ...((check(ts) ?? []) as unknown as { teacher_id: string; subjects: Named }[])]) {
    const s = roles.get(r.teacher_id) ?? new Set<string>(); const n = one(r.subjects)?.name; if (n) s.add(n); roles.set(r.teacher_id, s);
  }
  if (!roles.size) return [];
  const people = (check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name").eq("institution_id", inst).in("id", [...roles.keys()])) ?? []) as { id: string; first_name: string; last_name: string }[];
  return people.map((p) => ({ id: p.id, name: `${p.first_name} ${p.last_name}`.trim(), role: [...(roles.get(p.id) ?? [])].join(", ") })).sort((a, b) => Number(b.role.startsWith("Class teacher")) - Number(a.role.startsWith("Class teacher")) || a.name.localeCompare(b.name));
}

type Msg = { id: string; code: string; subject: string; body: string | null; direction: "in" | "out"; status: string; sent_on: string; created_at: string; student_id: string | null; to_teacher_id: string | null; reply_to: string | null; teacher: Person; sender: Person };
export async function messages(inst: string, me: string, studentId?: unknown) {
  const { fam, child } = await childOf(inst, me, studentId);
  const [teachers, rows] = await Promise.all([
    teachersOf(inst, child),
    supabaseAdmin.from("parent_messages").select("id, code, subject, body, direction, status, sent_on, created_at, student_id, to_teacher_id, reply_to, teacher:to_teacher_id(first_name, last_name), sender:created_by(first_name, last_name)").eq("institution_id", inst).in("guardian_id", fam.guardianIds).eq("kind", "message").order("created_at", { ascending: false }).limit(300),
  ]);
  const items = ((check(rows) ?? []) as unknown as Msg[]).filter((m) => !m.student_id || m.student_id === child.id).map((m) => ({ id: m.id, code: m.code, direction: m.direction, subject: m.subject, body: m.body ?? "", date: m.sent_on, with: m.direction === "in" ? who(m.teacher) || "School" : who(m.sender) || "School office", unread: m.direction === "out" && m.status === "Delivered", status: m.status }));
  return { teachers, items };
}

export async function sendMessage(inst: string, me: string, input: unknown) {
  const i = z.object({ student_id: uid, teacher_id: uid.optional(), reply_to: uid.optional(), subject: txt(200).min(2, "Enter a subject.").optional(), body: txt(2000).min(2, "Write the message.") }).strict().parse(input);
  const { fam, child } = await childOf(inst, me, i.student_id);
  let teacher = i.teacher_id ?? null; let subject = i.subject ?? ""; let guardian = fam.guardian.id; let student = child.id;
  if (i.reply_to) {
    // only a message the school sent to this family can be answered
    const m = check(await supabaseAdmin.from("parent_messages").select("id, subject, guardian_id, student_id, created_by").eq("id", i.reply_to).eq("institution_id", inst).in("guardian_id", fam.guardianIds).eq("direction", "out").maybeSingle()) as { id: string; subject: string; guardian_id: string; student_id: string | null; created_by: string | null } | null;
    if (!m) throw new HttpError(404, "Message not found.");
    if (m.student_id && !fam.children.some((c) => c.id === m.student_id)) throw new HttpError(404, "Message not found.");
    teacher = m.created_by; subject = `Re: ${m.subject}`.slice(0, 200); guardian = m.guardian_id; student = m.student_id ?? child.id;
    check(await supabaseAdmin.from("parent_messages").update({ status: "Replied" }).eq("id", m.id).eq("institution_id", inst).eq("direction", "out").select("id"));
  } else {
    if (!teacher) throw new HttpError(400, "Choose the teacher.");
    if (!subject) throw new HttpError(400, "Enter a subject.");
    if (!(await teachersOf(inst, child)).some((t) => t.id === teacher)) throw new HttpError(404, "That teacher does not teach this class.");
  }
  const since = new Date(Date.now() - 3600000).toISOString();
  const recent = (check(await supabaseAdmin.from("parent_messages").select("id").eq("institution_id", inst).in("guardian_id", fam.guardianIds).eq("direction", "in").gte("created_at", since).limit(20)) ?? []) as unknown[];
  if (recent.length >= 20) throw new HttpError(429, "That is a lot of messages in one hour. Please try again later.");
  return check(await supabaseAdmin.from("parent_messages").insert({ institution_id: inst, kind: "message", direction: "in", guardian_id: guardian, student_id: student, to_teacher_id: teacher, subject, body: i.body, status: "Delivered", channel: "App", reply_to: i.reply_to ?? null }).select("id, code").single());
}

export async function readMessage(inst: string, me: string, id: string) {
  const fam = await family(inst, me);
  check(await supabaseAdmin.from("parent_messages").update({ status: "Read" }).eq("id", uid.parse(id)).eq("institution_id", inst).in("guardian_id", fam.guardianIds).eq("direction", "out").eq("status", "Delivered").select("id"));
  return { ok: true };
}

// ═════════════ parent-teacher meeting ═════════════
type Slot = { id: string; session_id: string; slot_time: string; status: string; student_id: string | null; guardian_id: string | null; topic: string };
async function sessionsFor(inst: string, child: Child) {
  const teachers = await teachersOf(inst, child);
  if (!teachers.length) return { teachers, sessions: [] as { id: string; teacher_id: string; meet_date: string; room: string }[] };
  const sessions = (check(await supabaseAdmin.from("ptm_sessions").select("id, teacher_id, meet_date, room").eq("institution_id", inst).in("teacher_id", teachers.map((t) => t.id)).gte("meet_date", today()).order("meet_date").limit(100)) ?? []) as { id: string; teacher_id: string; meet_date: string; room: string }[];
  return { teachers, sessions };
}
export async function ptm(inst: string, me: string, studentId?: unknown) {
  const { fam, child } = await childOf(inst, me, studentId);
  const { teachers, sessions } = await sessionsFor(inst, child);
  const slots = (sessions.length ? check(await supabaseAdmin.from("ptm_slots").select("id, session_id, slot_time, status, student_id, guardian_id, topic").in("session_id", sessions.map((s) => s.id)).order("slot_time").limit(3000)) : []) as Slot[];
  return {
    items: sessions.map((s) => {
      const t = teachers.find((x) => x.id === s.teacher_id)!;
      const all = slots.filter((x) => x.session_id === s.id);
      const mine = all.find((x) => x.student_id === child.id && x.guardian_id && fam.guardianIds.includes(x.guardian_id));
      // other families' bookings are never described: a slot is simply free or not
      return { session_id: s.id, date: s.meet_date, room: s.room, teacher: t.name, role: t.role, booked: mine ? { id: mine.id, time: hhmm(mine.slot_time), topic: mine.topic, met: mine.status === "Met" } : null, free: all.filter((x) => x.status === "Free").map((x) => ({ id: x.id, time: hhmm(x.slot_time) })) };
    }),
  };
}
async function slotFor(inst: string, child: Child, slotId: string) {
  const slot = check(await supabaseAdmin.from("ptm_slots").select("id, session_id, status, student_id, guardian_id").eq("id", uid.parse(slotId)).maybeSingle()) as Slot | null;
  const { sessions } = await sessionsFor(inst, child);
  if (!slot || !sessions.some((s) => s.id === slot.session_id)) throw new HttpError(404, "Slot not found.");
  return slot;
}
export async function bookSlot(inst: string, me: string, input: unknown) {
  const i = z.object({ student_id: uid, slot_id: uid, topic: txt(200).optional() }).strict().parse(input);
  const { fam, child } = await childOf(inst, me, i.student_id);
  const slot = await slotFor(inst, child, i.slot_id);
  const have = (check(await supabaseAdmin.from("ptm_slots").select("id").eq("session_id", slot.session_id).eq("student_id", child.id).in("status", ["Booked", "Met"]).limit(1)) ?? []) as unknown[];
  if (have.length) throw new HttpError(409, "You already have a slot with this teacher. Cancel it to choose another.");
  // only a slot that is still free is taken, so two families cannot book the same one
  const done = (check(await supabaseAdmin.from("ptm_slots").update({ status: "Booked", student_id: child.id, guardian_id: fam.guardian.id, topic: i.topic ?? "" }).eq("id", slot.id).eq("session_id", slot.session_id).eq("status", "Free").select("id")) ?? []) as unknown[];
  if (!done.length) throw new HttpError(409, "That slot has just been taken. Choose another.");
  return { ok: true };
}
export async function cancelSlot(inst: string, me: string, studentId: unknown, slotId: string) {
  const { fam, child } = await childOf(inst, me, studentId);
  const slot = await slotFor(inst, child, slotId);
  const done = (check(await supabaseAdmin.from("ptm_slots").update({ status: "Free", student_id: null, guardian_id: null, topic: "" }).eq("id", slot.id).eq("session_id", slot.session_id).eq("student_id", child.id).in("guardian_id", fam.guardianIds).eq("status", "Booked").select("id")) ?? []) as unknown[];
  if (!done.length) throw new HttpError(404, "That booking is not yours to cancel.");
  return { ok: true };
}

// ═════════════ notices and class diary ═════════════
/** Circulars, announcements and parent notices that are meant for this family. */
export async function announcements(inst: string, children: Child[]) {
  const ids = children.map((c) => c.id);
  const bus = ids.length ? ((check(await supabaseAdmin.from("tr_allocations").select("student_id").eq("institution_id", inst).in("student_id", ids).limit(1)) ?? []) as unknown[]).length > 0 : false;
  const [circ, ann, notices] = await Promise.all([
    supabaseAdmin.from("comm_circulars").select("id, title, audience, issued_by, circ_date, body").eq("institution_id", inst).eq("status", "Published").in("audience", ["All parents", "Everyone", ...(bus ? ["Transport users"] : [])]).order("circ_date", { ascending: false }).limit(60),
    supabaseAdmin.from("comm_announcements").select("id, title, audience, send_on").eq("institution_id", inst).eq("status", "Scheduled").lte("send_on", today()).in("audience", ["Everyone", "Parents"]).order("send_on", { ascending: false }).limit(60),
    supabaseAdmin.from("comm_notices").select("id, title, posted_by, posted_on, expires_on").eq("institution_id", inst).eq("audience", "Parent").gte("expires_on", today()).order("posted_on", { ascending: false }).limit(60),
  ]);
  return [
    ...((check(circ) ?? []) as { id: string; title: string; issued_by: string; circ_date: string; body: string }[]).map((r) => ({ id: r.id, kind: "Circular", title: r.title, text: r.body ?? "", by: r.issued_by, date: r.circ_date })),
    ...((check(ann) ?? []) as { id: string; title: string; send_on: string }[]).map((r) => ({ id: r.id, kind: "Announcement", title: r.title, text: "", by: "School office", date: r.send_on })),
    ...((check(notices) ?? []) as { id: string; title: string; posted_by: string; posted_on: string }[]).map((r) => ({ id: r.id, kind: "Notice", title: r.title, text: "", by: r.posted_by, date: r.posted_on })),
  ].sort((a, b) => b.date.localeCompare(a.date));
}
type Diary = { id: string; entry: string; by_name: string; diary_date: string; kind: string; ask_ack: boolean; attachment_name: string | null; student_id: string | null };
async function diaryRows(inst: string, child: Child) {
  const [byClass, own] = await Promise.all([
    child.section_id ? supabaseAdmin.from("comm_diary").select("id, entry, by_name, diary_date, kind, ask_ack, attachment_name, student_id").eq("institution_id", inst).eq("section_id", child.section_id).is("student_id", null).order("diary_date", { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("comm_diary").select("id, entry, by_name, diary_date, kind, ask_ack, attachment_name, student_id").eq("institution_id", inst).eq("student_id", child.id).order("diary_date", { ascending: false }).limit(100),
  ]);
  return [...((check(byClass) ?? []) as Diary[]), ...((check(own) ?? []) as Diary[])].sort((a, b) => b.diary_date.localeCompare(a.diary_date));
}
export async function notices(inst: string, me: string, studentId?: unknown) {
  const { fam, child } = await childOf(inst, me, studentId);
  const [items, diary] = await Promise.all([announcements(inst, fam.children), diaryRows(inst, child)]);
  const seen = (diary.length ? check(await supabaseAdmin.from("comm_diary_seen").select("diary_id").in("diary_id", diary.map((d) => d.id)).in("guardian_id", fam.guardianIds)) : []) as { diary_id: string }[];
  return { items, diary: diary.map((d) => ({ id: d.id, date: d.diary_date, kind: d.kind, entry: d.entry, by: d.by_name, attachment: d.attachment_name ?? "", ask_ack: d.ask_ack, seen: seen.some((s) => s.diary_id === d.id) })) };
}
export async function seeDiary(inst: string, me: string, studentId: unknown, id: string) {
  const { fam, child } = await childOf(inst, me, studentId);
  if (!(await diaryRows(inst, child)).some((d) => d.id === uid.parse(id))) throw new HttpError(404, "Diary entry not found.");
  check(await supabaseAdmin.from("comm_diary_seen").upsert({ diary_id: id, guardian_id: fam.guardian.id }, { onConflict: "diary_id,guardian_id" }).select("diary_id"));
  return { ok: true };
}

// ═════════════ events and gallery ═════════════
export async function events(inst: string, me: string, mods: string[]) {
  const fam = await family(inst, me);
  const from = new Date(Date.parse(today()) - 180 * 86400000).toISOString().slice(0, 10);
  const [ev, al] = await Promise.all([
    supabaseAdmin.from("calendar_events").select("id, title, event_date, end_date, kind, audience, note").eq("institution_id", inst).eq("published", true).in("kind", ["Event", "Sports"]).gte("event_date", from).order("event_date").limit(500),
    mods.includes("photo_gallery") ? supabaseAdmin.from("gallery_albums").select("id, title, event, album_date, audience, photo_count, caption").eq("institution_id", inst).eq("status", "Published").order("album_date", { ascending: false }).limit(200) : Promise.resolve({ data: [], error: null }),
  ]);
  const labels = fam.children.map((c) => c.class_label.toLowerCase());
  return {
    events: ((check(ev) ?? []) as { id: string; title: string; event_date: string; end_date: string | null; kind: string; audience: string; note: string | null }[]).filter((e) => forFamily(e.audience, fam.children)),
    gallery: mods.includes("photo_gallery"),
    albums: ((check(al) ?? []) as { id: string; title: string; event: string; album_date: string; audience: string; photo_count: number; caption: string }[]).filter((a) => a.audience === "Whole school" || labels.includes(a.audience.toLowerCase())),
  };
}

// ═════════════ school bus ═════════════
export async function transport(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  const al = check(await supabaseAdmin.from("tr_allocations").select("route_id, stop_id, from_on, status").eq("institution_id", inst).eq("student_id", child.id).maybeSingle()) as { route_id: string | null; stop_id: string | null; from_on: string; status: string } | null;
  if (!al?.route_id) return { allocated: false as const };
  const route = check(await supabaseAdmin.from("tr_routes").select("id, name, area, first_pickup, at_school, departure").eq("id", al.route_id).eq("institution_id", inst).maybeSingle()) as { id: string; name: string; area: string; first_pickup: string | null; at_school: string | null; departure: string | null } | null;
  if (!route) return { allocated: false as const };
  const [stops, vehicle, attendant, settings, trips, board] = await Promise.all([
    supabaseAdmin.from("tr_stops").select("id, name, ord, pickup, drop_time, status").eq("institution_id", inst).eq("route_id", route.id).order("ord"),
    supabaseAdmin.from("tr_vehicles").select("id, reg_no, vtype, seats, fleet_name").eq("institution_id", inst).eq("route", route.name).eq("status", "Active").limit(1).maybeSingle(),
    supabaseAdmin.from("tr_attendants").select("name, mobile, first_aid").eq("institution_id", inst).eq("route_id", route.id).eq("status", "Active").limit(1).maybeSingle(),
    supabaseAdmin.from("tr_settings").select("share_numbers, share_location").eq("institution_id", inst).maybeSingle(),
    supabaseAdmin.from("tr_trips").select("ttype, started_at, ended_at, arrived, status, delay_min").eq("institution_id", inst).eq("route_id", route.id).eq("trip_on", today()),
    supabaseAdmin.from("tr_boardings").select("trip_on, ttype, status").eq("institution_id", inst).eq("student_id", child.id).order("trip_on", { ascending: false }).limit(20),
  ]);
  // a school without these settings yet shares as the Transport portal's default does
  const share = (settings.data as { share_numbers: boolean; share_location: boolean } | null) ?? { share_numbers: true, share_location: true };
  const v = check(vehicle) as { id: string; reg_no: string; vtype: string; seats: number; fleet_name: string } | null;
  const driver = v ? check(await supabaseAdmin.from("tr_drivers").select("name, mobile, police").eq("institution_id", inst).eq("vehicle_id", v.id).eq("status", "Active").limit(1).maybeSingle()) as { name: string; mobile: string | null; police: string } | null : null;
  const att = check(attendant) as { name: string; mobile: string | null; first_aid: boolean | null } | null;
  const S = (check(stops) ?? []) as { id: string; name: string; ord: number; pickup: string | null; drop_time: string | null; status: string }[];
  const mine = S.find((s) => s.id === al.stop_id);
  return {
    allocated: true as const, status: al.status, since: al.from_on,
    route: { name: route.name, area: route.area, at_school: hhmm(route.at_school), departure: hhmm(route.departure) },
    stop: mine ? { name: mine.name, pickup: hhmm(mine.pickup), drop: hhmm(mine.drop_time) } : null,
    stops: S.filter((s) => s.status === "Active").map((s) => ({ name: s.name, pickup: hhmm(s.pickup), drop: hhmm(s.drop_time), mine: s.id === al.stop_id })),
    vehicle: v ? { name: v.fleet_name, reg_no: v.reg_no, type: v.vtype } : null,
    driver: driver ? { name: driver.name, mobile: share.share_numbers ? driver.mobile : null, police: driver.police } : null,
    attendant: att ? { name: att.name, mobile: share.share_numbers ? att.mobile : null, first_aid: att.first_aid } : null,
    share_location: share.share_location,
    trips: share.share_location ? ((check(trips) ?? []) as { ttype: string; started_at: string | null; ended_at: string | null; arrived: unknown; status: string; delay_min: number | null }[]).map((t) => ({ type: t.ttype, status: t.status, started: hhmm(t.started_at), ended: hhmm(t.ended_at), delay: t.delay_min ?? 0, stops_done: Array.isArray(t.arrived) ? t.arrived.length : 0 })) : [],
    boardings: ((check(board) ?? []) as { trip_on: string; ttype: string; status: string }[]).map((b) => ({ date: b.trip_on, type: b.ttype, status: b.status })),
  };
}

// ═════════════ health ═════════════
export async function health(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  const [rec, vac, scr, med, upd] = await Promise.all([
    supabaseAdmin.from("student_health").select("blood_group, allergies, conditions, contact1_name, contact1_mobile, contact2_name, contact2_mobile").eq("institution_id", inst).eq("student_id", child.id).maybeSingle(),
    supabaseAdmin.from("student_vaccines").select("vaccine, status").eq("institution_id", inst).eq("student_id", child.id).order("vaccine"),
    supabaseAdmin.from("health_screenings").select("id, screened_on, height_cm, weight_kg, vision, checkup, status").eq("institution_id", inst).eq("student_id", child.id).order("screened_on", { ascending: false }).limit(20),
    supabaseAdmin.from("medication_records").select("id, medicine, dose_when, until, consent, status").eq("institution_id", inst).eq("student_id", child.id).order("until", { ascending: false }).limit(20),
    supabaseAdmin.from("parent_health_updates").select("id, code, kind, details, sent_on, status").eq("institution_id", inst).eq("student_id", child.id).order("sent_on", { ascending: false }).limit(20),
  ]);
  return {
    record: check(rec) as { blood_group: string; allergies: string; conditions: string; contact1_name: string; contact1_mobile: string; contact2_name: string; contact2_mobile: string } | null,
    blood_group: child.blood_group,
    vaccines: (check(vac) ?? []) as { vaccine: string; status: string }[],
    screenings: (check(scr) ?? []) as { id: string; screened_on: string; height_cm: number | null; weight_kg: number | null; vision: string; checkup: string; status: string }[],
    medicines: (check(med) ?? []) as { id: string; medicine: string; dose_when: string; until: string; consent: boolean; status: string }[],
    updates: (check(upd) ?? []) as { id: string; code: string; kind: string; details: string; sent_on: string; status: string }[],
  };
}

// ═════════════ library ═════════════
type Book = { title: string; author: string } | { title: string; author: string }[] | null;
export async function libraryData(inst: string, child: Child) {
  const member = check(await supabaseAdmin.from("lib_members").select("id, code, valid_until, status").eq("institution_id", inst).eq("student_id", child.id).maybeSingle()) as { id: string; code: string; valid_until: string; status: string } | null;
  if (!member) return { member: null, issues: [], reservations: [], fines: [] };
  const [iss, res, fines] = await Promise.all([
    supabaseAdmin.from("lib_issues").select("id, issued_on, due_on, returned_on, renewals, status, lib_copies:copy_id(accession_no, lib_books:book_id(title, author))").eq("institution_id", inst).eq("member_id", member.id).order("issued_on", { ascending: false }).limit(100),
    supabaseAdmin.from("lib_reservations").select("id, code, reserved_on, status, lib_books:book_id(title, author)").eq("institution_id", inst).eq("member_id", member.id).order("reserved_on", { ascending: false }).limit(50),
    supabaseAdmin.from("lib_fines").select("id, code, reason, amount, fined_on, status").eq("institution_id", inst).eq("member_id", member.id).order("fined_on", { ascending: false }).limit(50),
  ]);
  return {
    member: { code: member.code, valid_until: member.valid_until, status: member.status },
    issues: ((check(iss) ?? []) as unknown as { id: string; issued_on: string; due_on: string; returned_on: string | null; renewals: number; status: string; lib_copies: { accession_no: string; lib_books: Book } | { accession_no: string; lib_books: Book }[] | null }[]).map((r) => { const c = one(r.lib_copies); const b = one(c?.lib_books ?? null); return { id: r.id, title: b?.title ?? "", author: b?.author ?? "", accession: c?.accession_no ?? "", issued_on: r.issued_on, due_on: r.due_on, returned_on: r.returned_on ?? "", status: r.status === "Issued" && r.due_on < today() ? "Overdue" : r.status }; }),
    reservations: ((check(res) ?? []) as unknown as { id: string; code: string; reserved_on: string; status: string; lib_books: Book }[]).map((r) => ({ id: r.id, code: r.code, title: one(r.lib_books)?.title ?? "", date: r.reserved_on, status: r.status })),
    fines: (check(fines) ?? []) as { id: string; code: string; reason: string; amount: number; fined_on: string; status: string }[],
  };
}
export async function library(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  return libraryData(inst, child);
}

// ═════════════ mess ═════════════
export async function mess(inst: string, me: string, studentId?: unknown) {
  const { child } = await childOf(inst, me, studentId);
  const [plan, menu, reqs] = await Promise.all([
    supabaseAdmin.from("mess_day_students").select("meals, diet, since, per_month, allergy, opted").eq("institution_id", inst).eq("student_id", child.id).maybeSingle(),
    supabaseAdmin.from("hostel_menu").select("day, breakfast, lunch, snacks, dinner").eq("institution_id", inst).order("day"),
    supabaseAdmin.from("mess_requests").select("id, code, meals, diet, start_on, requested_on, status").eq("institution_id", inst).eq("student_id", child.id).order("requested_on", { ascending: false }).limit(20),
  ]);
  const p = check(plan) as { meals: string; diet: string; since: string; per_month: number | null; allergy: string; opted: boolean } | null;
  return { plan: p?.opted ? p : null, menu: (check(menu) ?? []) as { day: number; breakfast: string; lunch: string; snacks: string; dinner: string }[], requests: (check(reqs) ?? []) as { id: string; code: string; meals: string; diet: string; start_on: string | null; requested_on: string; status: string }[] };
}
