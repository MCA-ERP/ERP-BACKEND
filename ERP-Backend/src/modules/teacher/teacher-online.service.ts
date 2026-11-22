import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { hm, istDate, mySections, one, secLabel, sectionMap } from "./teacher.service";
import { pupils, requireSection } from "./teacher-classes.service";
import { mySubjectSections, notifyParents, subjectIn } from "./teacher-work.service";

/** Online classes and online tests, and the teacher's parent messages. Everything is limited to this teacher's own sections and rows. */
const uid = z.string().uuid();
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Choose a time.");
export const PLATFORMS = ["Google Meet", "Zoom", "Microsoft Teams", "Jitsi Meet"] as const;
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// ═════════════ online classes ═════════════
type OC = { id: string; name: string; section_id: string; session_date: string; session_time: string; link: string; status: string; duration_min: number; platform: string; record: boolean; notify: boolean; recording_name: string | null; recording_views: number };
const OSEL = "id, name, section_id, session_date, session_time, link, status, duration_min, platform, record, notify, recording_name, recording_views";

export async function onlineClasses(inst: string, me: string) {
  const [rows, { list, sm }] = await Promise.all([supabaseAdmin.from("online_classes").select(OSEL).eq("institution_id", inst).eq("teacher_id", me).order("session_date").order("session_time").limit(500), mySubjectSections(inst, me)]);
  const today = istDate(); const now = mins(hm(new Date().toISOString()));
  const all = ((check(rows) ?? []) as OC[]).map((r) => {
    const start = mins(r.session_time.slice(0, 5)); const ended = r.session_date < today || (r.session_date === today && now >= start + r.duration_min);
    const live = r.status === "Scheduled" && r.session_date === today && now >= start && now < start + r.duration_min;
    return { id: r.id, topic: r.name, section_id: r.section_id, class_label: secLabel(sm.get(r.section_id) ?? null), date: r.session_date, time: r.session_time.slice(0, 5), duration: r.duration_min, platform: r.platform, link: r.link, record: r.record, status: r.status, live, ended, recording: r.recording_name ?? "", views: r.recording_views };
  });
  return {
    sections: list.map((s) => ({ id: s.id, label: s.label })), platforms: PLATFORMS,
    upcoming: all.filter((c) => c.status === "Scheduled" && !c.ended).map((c) => ({ ...c, state: c.live ? "Live now" : "Upcoming" })),
    recordings: all.filter((c) => c.status !== "Cancelled" && c.ended).sort((a, b) => (a.date < b.date ? 1 : -1)),
  };
}

export async function scheduleClass(inst: string, me: string, input: unknown) {
  const i = z.object({ section_id: uid, topic: z.string().trim().min(2, "Enter the topic.").max(200), date: iso, time: hhmm, duration: z.number().int().min(5).max(300), platform: z.enum(PLATFORMS), link: z.string().trim().max(300).optional(), notify: z.boolean(), record: z.boolean() }).strict().parse(input);
  await subjectIn(inst, me, i.section_id);
  if (i.date < istDate()) throw new HttpError(400, "That date has already passed.");
  if (i.date === istDate() && mins(i.time) + i.duration <= mins(hm(new Date().toISOString()))) throw new HttpError(400, "That time has already passed today.");
  let link = i.link ?? "";
  if (link && !/^https:\/\//i.test(link)) throw new HttpError(400, "The meeting link must start with https://");
  if (!link) {
    if (i.platform !== "Jitsi Meet") throw new HttpError(400, `Paste your ${i.platform} meeting link. Only Jitsi Meet links are created for you.`);
    link = `https://meet.jit.si/mca-${randomBytes(6).toString("hex")}`;
  }
  const row = check(await supabaseAdmin.from("online_classes").insert({ institution_id: inst, name: i.topic, section_id: i.section_id, teacher_id: me, session_date: i.date, session_time: i.time, link, duration_min: i.duration, platform: i.platform, record: i.record, notify: i.notify }).select("id").single()) as { id: string };
  if (i.notify) await notifyParents(inst, me, (await pupils(inst, [i.section_id])).map((k) => k.id), `Online class: ${i.topic}`, `${i.topic} on ${i.date} at ${i.time} (${i.duration} min, ${i.platform}). Join from Online Classes in the app.`);
  return { id: row.id, link };
}

export async function cancelClass(inst: string, me: string, id: string) {
  const r = check(await supabaseAdmin.from("online_classes").update({ status: "Cancelled" }).eq("id", uid.parse(id)).eq("institution_id", inst).eq("teacher_id", me).eq("status", "Scheduled").select("id, section_id, name")) as { id: string; section_id: string; name: string }[];
  if (!r.length) throw new HttpError(404, "That class is not scheduled.");
  await notifyParents(inst, me, (await pupils(inst, [r[0].section_id])).map((k) => k.id), `Online class cancelled: ${r[0].name}`, `The online class "${r[0].name}" has been cancelled.`);
  return { ok: true };
}

export async function uploadRecording(inst: string, me: string, id: string, input: unknown) {
  const { file_name } = z.object({ file_name: z.string().trim().min(1).max(160) }).strict().parse(input);
  if (!/\.(mp4|webm|mkv)$/i.test(file_name)) throw new HttpError(400, "Choose a video file (MP4).");
  const r = check(await supabaseAdmin.from("online_classes").update({ recording_name: file_name, status: "Completed" }).eq("id", uid.parse(id)).eq("institution_id", inst).eq("teacher_id", me).neq("status", "Cancelled").select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Class not found.");
  return { ok: true };
}

// ═════════════ online tests ═════════════
type OT = { id: string; code: string; name: string; section_id: string; subject_id: string; questions: number; minutes: number; status: string; opens_on: string | null };
const TSEL = "id, code, name, section_id, subject_id, questions, minutes, status, opens_on";
const testState = (t: OT, today: string) => (t.status === "Draft" ? "Draft" : t.status === "Closed" || (t.opens_on && t.opens_on < today) ? "Completed" : t.opens_on && t.opens_on > today ? "Scheduled" : "Live");

export async function onlineTests(inst: string, me: string) {
  const [rows, { list, sm }] = await Promise.all([supabaseAdmin.from("online_tests").select(TSEL).eq("institution_id", inst).eq("created_by", me).order("created_at", { ascending: false }).limit(200), mySubjectSections(inst, me)]);
  const T = (check(rows) ?? []) as OT[];
  const att = T.length ? (check(await supabaseAdmin.from("online_test_attempts").select("test_id, score_pct").eq("institution_id", inst).in("test_id", T.map((t) => t.id)).limit(50000)) ?? []) as { test_id: string; score_pct: number }[] : [];
  const kids = await pupils(inst, [...new Set(T.map((t) => t.section_id))]);
  const today = istDate();
  return {
    sections: list.map((s) => ({ id: s.id, label: s.label })),
    items: T.map((t) => { const a = att.filter((x) => x.test_id === t.id); const total = kids.filter((k) => k.section_id === t.section_id).length; return { id: t.id, code: t.code, name: t.name, section_id: t.section_id, class_label: secLabel(sm.get(t.section_id) ?? null), date: t.opens_on, questions: t.questions, minutes: t.minutes, submitted: a.length, total, average: a.length ? Math.round(a.reduce((s, x) => s + Number(x.score_pct), 0) / a.length) : null, state: testState(t, today) }; }),
  };
}

export async function createTest(inst: string, me: string, input: unknown) {
  const q = z.object({ question: z.string().trim().min(3, "Type the question.").max(1000), a: z.string().trim().min(1, "Fill option A.").max(300), b: z.string().trim().min(1, "Fill option B.").max(300), c: z.string().trim().max(300), d: z.string().trim().max(300), correct: z.enum(["A", "B", "C", "D"]) }).strict();
  const i = z.object({ section_id: uid, name: z.string().trim().min(2, "Enter the test name.").max(200), opens_on: iso, minutes: z.number().int().min(5).max(300), questions: z.array(q).min(1).max(100) }).strict().parse(input);
  const s = await subjectIn(inst, me, i.section_id);
  if (i.opens_on < istDate()) throw new HttpError(400, "A test cannot open in the past.");
  for (const x of i.questions) { const opt = { A: x.a, B: x.b, C: x.c, D: x.d }; if (!opt[x.correct]) throw new HttpError(400, `Question "${x.question.slice(0, 30)}": the correct answer is an empty option.`); }
  const t = check(await supabaseAdmin.from("online_tests").insert({ institution_id: inst, name: i.name, section_id: i.section_id, subject_id: s.subject_id, questions: i.questions.length, minutes: i.minutes, status: "Open", opens_on: i.opens_on, created_by: me }).select("id, code").single()) as { id: string; code: string };
  check(await supabaseAdmin.from("online_test_questions").insert(i.questions.map((x, n) => ({ institution_id: inst, test_id: t.id, position: n + 1, question: x.question, option_a: x.a, option_b: x.b, option_c: x.c, option_d: x.d, correct: x.correct }))).select("id"));
  await notifyParents(inst, me, (await pupils(inst, [i.section_id])).map((k) => k.id), `Online test: ${i.name}`, `${i.name} opens on ${i.opens_on}: ${i.questions.length} questions, ${i.minutes} minutes.`);
  return t;
}

export async function updateTest(inst: string, me: string, id: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2).max(200).optional(), opens_on: iso.optional(), minutes: z.number().int().min(5).max(300).optional() }).strict().parse(input);
  const t = check(await supabaseAdmin.from("online_tests").select(TSEL).eq("id", uid.parse(id)).eq("institution_id", inst).eq("created_by", me).maybeSingle()) as OT | null;
  if (!t) throw new HttpError(404, "Test not found.");
  if (testState(t, istDate()) !== "Scheduled") throw new HttpError(409, "Only a test that has not opened yet can be edited.");
  if (i.opens_on && i.opens_on < istDate()) throw new HttpError(400, "A test cannot open in the past.");
  if (!Object.keys(i).length) throw new HttpError(400, "Nothing to change.");
  check(await supabaseAdmin.from("online_tests").update({ ...(i.name ? { name: i.name } : {}), ...(i.opens_on ? { opens_on: i.opens_on } : {}), ...(i.minutes ? { minutes: i.minutes } : {}) }).eq("id", id).eq("institution_id", inst).eq("created_by", me).select("id"));
  return { ok: true };
}

export async function testResults(inst: string, me: string, id: string) {
  const t = check(await supabaseAdmin.from("online_tests").select(TSEL).eq("id", uid.parse(id)).eq("institution_id", inst).eq("created_by", me).maybeSingle()) as OT | null;
  if (!t) throw new HttpError(404, "Test not found.");
  const [kids, att] = await Promise.all([pupils(inst, [t.section_id]), supabaseAdmin.from("online_test_attempts").select("student_id, score_pct, submitted_at").eq("institution_id", inst).eq("test_id", id)]);
  const A = new Map(((check(att) ?? []) as { student_id: string; score_pct: number }[]).map((a) => [a.student_id, a]));
  const rows = kids.map((k) => ({ student_id: k.id, roll_no: k.roll_no, name: k.name, score: A.has(k.id) ? Number(A.get(k.id)!.score_pct) : null }));
  const done = rows.filter((r) => r.score !== null) as { score: number }[];
  return { id: t.id, code: t.code, name: t.name, questions: t.questions, submitted: done.length, total: rows.length, average: done.length ? Math.round(done.reduce((s, r) => s + r.score, 0) / done.length) : null, highest: done.length ? Math.max(...done.map((r) => r.score)) : null, students: rows };
}

// ═════════════ parent messages ═════════════
type PM = { id: string; code: string; subject: string; body: string | null; sent_on: string; status: string; student_id: string | null; guardian_id: string; direction: string; reply_to: string | null; channel: string; batch_id: string | null; to_teacher_id: string | null; created_at: string; guardians: { full_name: string } | { full_name: string }[] | null };
const PSEL = "id, code, subject, body, sent_on, status, student_id, guardian_id, direction, reply_to, channel, batch_id, to_teacher_id, created_at, guardians:guardian_id(full_name)";

async function myStudents(inst: string, me: string) {
  const m = await mySections(inst, me);
  const kids = await pupils(inst, m.ids);
  const sm = await sectionMap(inst, m.ids);
  return { kids, label: (sid: string) => secLabel(sm.get(sid) ?? null), classIds: m.classTeacherOf, all: m.ids, sm };
}
const uiStatus = (s: string) => (s === "Delivered" ? "Unread" : s);

export async function inbox(inst: string, me: string) {
  const { kids, label, classIds } = await myStudents(inst, me);
  const classKids = new Set(kids.filter((k) => classIds.includes(k.section_id)).map((k) => k.id));
  const rows = (check(await supabaseAdmin.from("parent_messages").select(PSEL).eq("institution_id", inst).eq("direction", "in").eq("kind", "message").is("reply_to", null).order("created_at", { ascending: false }).limit(500)) ?? []) as unknown as PM[];
  const K = new Map(kids.map((k) => [k.id, k]));
  const mine = rows.filter((r) => r.to_teacher_id === me || (r.to_teacher_id === null && r.student_id && classKids.has(r.student_id)));
  return { items: mine.map((r) => { const k = r.student_id ? K.get(r.student_id) : undefined; return { id: r.id, code: r.code, from: one(r.guardians)?.full_name ?? "", student: k ? `${k.name} · ${label(k.section_id)}` : "", subject: r.subject, preview: r.body ?? "", received: r.sent_on, status: uiStatus(r.status) }; }), unread: mine.filter((r) => r.status === "Delivered").length };
}

async function ownInbound(inst: string, me: string, id: string) {
  const { kids, classIds } = await myStudents(inst, me);
  const m = check(await supabaseAdmin.from("parent_messages").select("id, student_id, guardian_id, to_teacher_id, status, subject").eq("id", uid.parse(id)).eq("institution_id", inst).eq("direction", "in").maybeSingle()) as { id: string; student_id: string | null; guardian_id: string; to_teacher_id: string | null; status: string; subject: string } | null;
  const classKids = new Set(kids.filter((k) => classIds.includes(k.section_id)).map((k) => k.id));
  if (!m || !(m.to_teacher_id === me || (m.to_teacher_id === null && m.student_id && classKids.has(m.student_id)))) throw new HttpError(404, "Message not found.");
  return m;
}

export async function markRead(inst: string, me: string, id: string) {
  const m = await ownInbound(inst, me, id);
  if (m.status === "Delivered") check(await supabaseAdmin.from("parent_messages").update({ status: "Read" }).eq("id", id).eq("institution_id", inst).eq("direction", "in").select("id"));
  return { ok: true };
}

export async function replyTo(inst: string, me: string, id: string, input: unknown) {
  const { body } = z.object({ body: z.string().trim().min(2, "Write your reply.").max(2000) }).strict().parse(input);
  const m = await ownInbound(inst, me, id);
  check(await supabaseAdmin.from("parent_messages").insert({ institution_id: inst, kind: "message", guardian_id: m.guardian_id, student_id: m.student_id, subject: `Re: ${m.subject}`.slice(0, 200), body, status: "Delivered", created_by: me, direction: "out", reply_to: id, channel: "App" }).select("id"));
  check(await supabaseAdmin.from("parent_messages").update({ status: "Replied" }).eq("id", id).eq("institution_id", inst).eq("direction", "in").select("id"));
  return { ok: true };
}

/** Parents' replies to messages this teacher sent. */
export async function replies(inst: string, me: string) {
  const { kids, label } = await myStudents(inst, me);
  const K = new Map(kids.map((k) => [k.id, k]));
  const out = (check(await supabaseAdmin.from("parent_messages").select("id, subject").eq("institution_id", inst).eq("direction", "out").eq("created_by", me).limit(3000)) ?? []) as { id: string; subject: string }[];
  if (!out.length) return { items: [] as unknown[] };
  const S = new Map(out.map((o) => [o.id, o.subject]));
  const rows = (check(await supabaseAdmin.from("parent_messages").select(PSEL).eq("institution_id", inst).eq("direction", "in").in("reply_to", out.map((o) => o.id)).order("created_at", { ascending: false }).limit(300)) ?? []) as unknown as PM[];
  return { items: rows.map((r) => { const k = r.student_id ? K.get(r.student_id) : undefined; return { id: r.id, code: r.code, parent: one(r.guardians)?.full_name ?? "", student: k?.name ?? "", class_label: k ? label(k.section_id) : "", re: S.get(r.reply_to ?? "") ?? "", reply: r.body ?? r.subject, received: r.sent_on, status: uiStatus(r.status) }; }) };
}

export async function sentMessages(inst: string, me: string) {
  const { kids, label, all, sm } = await myStudents(inst, me);
  const K = new Map(kids.map((k) => [k.id, k]));
  const rows = (check(await supabaseAdmin.from("parent_messages").select(PSEL).eq("institution_id", inst).eq("direction", "out").eq("created_by", me).is("reply_to", null).in("kind", ["message"]).order("created_at", { ascending: false }).limit(1500)) ?? []) as unknown as PM[];
  const seen = new Set<string>(); const items: { id: string; to: string; student: string; class_label: string; subject: string; body: string; sent: string; channel: string; status: string }[] = [];
  for (const r of rows) {
    if (r.batch_id) { if (seen.has(r.batch_id)) continue; seen.add(r.batch_id); const k = r.student_id ? K.get(r.student_id) : undefined; items.push({ id: r.id, to: "All parents", student: "—", class_label: k ? label(k.section_id) : "", subject: r.subject, body: r.body ?? "", sent: r.sent_on, channel: r.channel, status: r.status === "Read" ? "Read" : "Delivered" }); continue; }
    const k = r.student_id ? K.get(r.student_id) : undefined;
    items.push({ id: r.id, to: one(r.guardians)?.full_name ?? "", student: k?.name ?? "—", class_label: k ? label(k.section_id) : "", subject: r.subject, body: r.body ?? "", sent: r.sent_on, channel: r.channel, status: r.status === "Read" || r.status === "Replied" ? "Read" : "Delivered" });
  }
  const g = kids.length ? (check(await supabaseAdmin.from("student_guardians").select("student_id, relation, guardians:guardian_id(id, full_name)").in("student_id", kids.map((k) => k.id)).limit(20000)) ?? []) as unknown as { student_id: string; relation: string; guardians: { id: string; full_name: string } | { id: string; full_name: string }[] | null }[] : [];
  const parents = g.map((x) => ({ x, p: one(x.guardians), k: K.get(x.student_id) })).filter((y) => y.p && y.k).map(({ x, p, k }) => ({ guardian_id: p!.id, student_id: x.student_id, section_id: k!.section_id, label: `${p!.full_name} · ${k!.name}` }));
  return { items, sections: all.map((id) => ({ id, label: secLabel(sm.get(id) ?? null) })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })), parents };
}

export async function sendMessage(inst: string, me: string, input: unknown) {
  const i = z.object({ section_id: uid, to: z.union([z.literal("all"), uid]), channel: z.enum(["App", "App + SMS"]), subject: z.string().trim().min(2, "Enter a subject.").max(200), body: z.string().trim().min(2, "Write the message.").max(2000) }).strict().parse(input);
  if (i.channel === "App + SMS") throw new HttpError(409, "SMS sending is not connected yet. Send it by App.");
  await requireSection(inst, me, i.section_id);
  const kids = await pupils(inst, [i.section_id]);
  const g = kids.length ? (check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, relation").in("student_id", kids.map((k) => k.id)).limit(20000)) ?? []) as { student_id: string; guardian_id: string; relation: string }[] : [];
  const pick = new Map<string, string>();
  for (const x of g) if (!pick.has(x.student_id) || x.relation === "Father") pick.set(x.student_id, x.guardian_id);
  let targets = [...pick.entries()].map(([student_id, guardian_id]) => ({ student_id, guardian_id }));
  if (i.to !== "all") { targets = g.filter((x) => x.guardian_id === i.to).map((x) => ({ student_id: x.student_id, guardian_id: x.guardian_id })); }
  if (!targets.length) throw new HttpError(409, "No parent is on file for that choice.");
  const batch = i.to === "all" ? randomUUID() : null;
  check(await supabaseAdmin.from("parent_messages").insert(targets.map((t) => ({ institution_id: inst, kind: "message", guardian_id: t.guardian_id, student_id: t.student_id, subject: i.subject, body: i.body, status: "Delivered", created_by: me, direction: "out", channel: i.channel, batch_id: batch }))).select("id"));
  return { sent: targets.length };
}

