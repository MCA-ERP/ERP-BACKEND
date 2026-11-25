import { randomUUID } from "crypto";
import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { newOr, saved, NEEDS_121 } from "../school/tr-columns";
import { allocations, routes, stops } from "../school/transport.service";
import { runOrder } from "../school/tr2.service";
import { dueIso, feeSettings, yearStart } from "../school/fees.service";
import { roster } from "../school/student-mgmt.service";
import { directory } from "../school/hr.service";
import { raiseTicket } from "../teacher/teacher.service";
import { schoolTextChannels, sendSchoolText } from "../messaging/messaging.service";
import { crew, liveBoard } from "./transport-ops.service";
import { fleet } from "./transport-portal.service";

/**
 * Step 8 and the fees: updates to parents, what parents are shown, and the transport part of each rider's fee, which is
 * billed and collected in Fee & Finance.
 */
const uid = z.string().uuid();
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const istHm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// ═════════════ guardians ═════════════
interface Kin { student_id: string; guardian_id: string; relation: string; guardians: { full_name: string; phone: string | null } | { full_name: string; phone: string | null }[] | null }
/** One parent for each child: the father where there is one. */
async function parentsOf(inst: string, studentIds: string[]) {
  const links: Kin[] = [];
  for (let a = 0; a < studentIds.length; a += 200) links.push(...(check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, relation, guardians:guardian_id!inner(institution_id, full_name, phone)").eq("guardians.institution_id", inst).in("student_id", studentIds.slice(a, a + 200))) as unknown as Kin[]));
  const out = new Map<string, { guardian_id: string; name: string; phone: string; relation: string }>();
  for (const s of studentIds) {
    const k = links.filter((x) => x.student_id === s); const p = k.find((x) => x.relation === "Father") ?? k[0];
    if (p) out.set(s, { guardian_id: p.guardian_id, name: one(p.guardians)?.full_name ?? "", phone: one(p.guardians)?.phone ?? "", relation: p.relation });
  }
  return out;
}
async function riders(inst: string, routeId?: string | null) {
  let q = supabaseAdmin.from("tr_allocations").select("student_id, route_id").eq("institution_id", inst);
  if (routeId) q = q.eq("route_id", routeId);
  return (check(await q.limit(20000)) as { student_id: string; route_id: string | null }[]);
}

// ═════════════ send an update ═════════════
export const UPDATE_TYPES = ["Delay", "Holiday", "Route change", "Substitute bus", "General"] as const;
const CHANNEL_LABEL = { portal: "App", sms: "SMS", whatsapp: "WhatsApp" } as const;
const TEMPLATE = "transport_update";

/** Which of SMS and WhatsApp can really be sent for this school, and why not. */
async function channelState(mods: string[]) {
  const ready = await schoolTextChannels(TEMPLATE);
  const why = (c: "sms" | "whatsapp", module: string) => (!mods.includes(module) ? "Not in your school's plan" : !ready.includes(c) ? "Not connected yet: the platform team adds the provider and template" : "");
  return { sms: why("sms", "sms_whatsapp"), whatsapp: why("whatsapp", "whatsapp") };
}

export async function updateOptions(inst: string, mods: string[]) {
  const [r, f, al, state] = await Promise.all([routes(inst), fleet(inst), riders(inst), channelState(mods)]);
  const parents = await parentsOf(inst, al.map((x) => x.student_id));
  const count = (id?: string) => al.filter((a) => (!id || a.route_id === id) && parents.has(a.student_id)).length;
  return {
    types: UPDATE_TYPES, channels: state, families: count(),
    routes: r.items.filter((x) => x.status === "Active").map((x) => ({ id: x.id, name: x.name, families: count(x.id), vehicle: f.items.find((v) => v.route === x.name && v.status === "Active")?.name ?? "" })),
  };
}

export async function sendUpdate(inst: string, me: string, mods: string[], input: unknown) {
  const i = z.object({ route_id: uid.nullable(), type: z.enum(UPDATE_TYPES), message: z.string().trim().min(3, "Write the message.").max(500), channels: z.array(z.enum(["portal", "sms", "whatsapp"])).min(1, "Choose how to send it.").max(3) }).strict().parse(input);
  const route = i.route_id ? (await routes(inst)).items.find((r) => r.id === i.route_id) : null;
  if (i.route_id && !route) throw new HttpError(404, "Route not found.");
  const channels = [...new Set(i.channels)];
  const texts = channels.filter((c): c is "sms" | "whatsapp" => c !== "portal");
  const state = await channelState(mods);
  const blocked = texts.find((c) => state[c]);
  if (blocked) throw new HttpError(409, `${CHANNEL_LABEL[blocked]}: ${state[blocked]}.`);
  const kids = (await riders(inst, i.route_id)).map((x) => x.student_id);
  if (!kids.length) throw new HttpError(409, "No students are allocated there yet.");
  const parents = await parentsOf(inst, kids);
  if (!parents.size) throw new HttpError(409, "None of those students has a parent on record.");
  // the send record is what shows how each update went out; without it only the parent portal can be used
  const log = await supabaseAdmin.from("tr_updates").select("id").eq("institution_id", inst).limit(1);
  if (log.error && texts.length) throw new HttpError(409, NEEDS_121);
  const id = randomUUID();
  if (!log.error) saved(await supabaseAdmin.from("tr_updates").insert({ id, institution_id: inst, route_id: i.route_id, audience: route ? `${route.name} parents` : "All transport parents", utype: i.type, message: i.message, channels: channels.map((c) => CHANNEL_LABEL[c]).join(" · "), families: parents.size, created_by: me }).select("id"));
  if (channels.includes("portal")) {
    const rows = [...parents].map(([student_id, p]) => ({ institution_id: inst, kind: "notification", guardian_id: p.guardian_id, student_id, subject: `Bus update: ${i.type}`, body: i.message, channel: "App", created_by: me }));
    for (let a = 0; a < rows.length; a += 500) check(await supabaseAdmin.from("parent_messages").insert(rows.slice(a, a + 500)).select("id"));
  }
  let queued = 0;
  if (texts.length) {
    const phones = [...new Set([...parents.values()].map((p) => p.phone).filter(Boolean))];
    queued = await sendSchoolText({ key: TEMPLATE, institutionId: inst, channels: texts, phones, variables: { message: i.message }, relatedId: id, createdBy: me });
  }
  return { families: parents.size, without_parent: kids.length - parents.size, queued };
}

export async function sentUpdates(inst: string) {
  const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const [log, msgs, alerts, st, al] = await Promise.all([
    supabaseAdmin.from("tr_updates").select("id, audience, utype, message, channels, families, created_at").eq("institution_id", inst).order("created_at", { ascending: false }).limit(500),
    supabaseAdmin.from("parent_messages").select("created_at, sent_on, subject, body, status, student_id").eq("institution_id", inst).eq("direction", "out").gte("sent_on", since).or("subject.ilike.Bus update%,subject.eq.Bus delay").order("created_at", { ascending: false }).limit(20000),
    supabaseAdmin.from("tr_alerts").select("id, trip_id, stop_id, stop_name, at, trip:trip_id(route_id, ttype)").eq("institution_id", inst).gte("at", `${today()}T00:00:00+05:30`).order("at", { ascending: false }).limit(500),
    stops(inst), allocations(inst),
  ]);
  const U = (log.error ? [] : log.data) as { id: string; audience: string; utype: string; message: string; channels: string; families: number; created_at: string }[];
  const texts = U.filter((u) => /SMS|WhatsApp/.test(u.channels)).map((u) => u.id);
  const outcome = texts.length ? (check(await supabaseAdmin.from("message_log").select("related_id, status").eq("institution_id", inst).in("related_id", texts.slice(0, 200)).limit(20000)) as { related_id: string; status: string }[]) : [];
  const items = U.map((u) => {
    const mine = outcome.filter((o) => o.related_id === u.id);
    const status = mine.some((o) => o.status === "failed") ? "Partly sent" : mine.some((o) => o.status === "queued") ? "Sending" : "Sent";
    return { id: u.id, sent_at: u.created_at, to: u.audience, type: u.utype, message: u.message, by: u.channels, families: u.families, status };
  });
  // delays reported on a trip, and anything sent before updates were recorded, come from the parent messages themselves
  const routeOf = new Map(al.items.map((x) => [x.student_id, x.route]));
  const loose = ((check(msgs) ?? []) as { created_at: string; sent_on: string; subject: string; body: string | null; student_id: string | null }[]).filter((m) => log.error || !m.subject.startsWith("Bus update:"));
  const groups = new Map<string, { first: string; type: string; message: string; students: Set<string>; n: number }>();
  for (const m of loose) {
    const k = `${m.sent_on}|${m.subject}|${m.body ?? ""}`;
    const g = groups.get(k) ?? { first: m.created_at, type: m.subject === "Bus delay" ? "Delay" : m.subject.replace(/^Bus update:?\s*/, "") || "General", message: m.body ?? "", students: new Set<string>(), n: 0 };
    g.n++; if (m.student_id) g.students.add(m.student_id); groups.set(k, g);
  }
  for (const [id, g] of groups) {
    const on = new Set([...g.students].map((s) => routeOf.get(s) ?? ""));
    items.push({ id, sent_at: g.first, to: on.size === 1 && [...on][0] ? `${[...on][0]} parents` : "All transport parents", type: g.type, message: g.message, by: "App", families: g.n, status: "Sent" });
  }
  const A = (check(alerts) ?? []) as unknown as { id: string; stop_id: string | null; stop_name: string; at: string; trip: { route_id: string; ttype: string } | { route_id: string; ttype: string }[] | null }[];
  const driver = A.map((a) => {
    const t = one(a.trip); const order = t ? runOrder(st.items.filter((s) => s.route_id === t.route_id), t.ttype) : [];
    const k = order.findIndex((s) => s.id === a.stop_id); const next = k >= 0 ? order[k + 1] : undefined;
    const due = next ? (t!.ttype === "Morning" ? next.pickup : next.drop) : "";
    return { id: a.id, time: istHm(a.at), stop: a.stop_name, message: `Bus at ${a.stop_name}${next ? ` · next: ${next.name}${due ? `, due ${due}` : ""}` : ""}` };
  });
  return { driver, items: items.sort((a, b) => b.sent_at.localeCompare(a.sent_at)) };
}

// ═════════════ what parents see ═════════════
export interface Sharing { share_numbers: boolean; share_location: boolean; alert_5min: boolean; alert_late: boolean }
const SHARE_ALL: Sharing = { share_numbers: true, share_location: true, alert_5min: true, alert_late: true };
export async function sharing(inst: string) {
  const r = await newOr<Sharing>(
    () => supabaseAdmin.from("tr_settings").select("share_numbers, share_location, alert_5min, alert_late").eq("institution_id", inst),
    () => supabaseAdmin.from("tr_settings").select("institution_id").eq("institution_id", inst).limit(0),
  );
  return { saved_here: r.upgraded, ...SHARE_ALL, ...(r.upgraded ? r.rows[0] ?? {} : {}) };
}
export async function saveSharing(inst: string, input: unknown) {
  const i = z.object({ share_numbers: z.boolean(), share_location: z.boolean(), alert_5min: z.boolean(), alert_late: z.boolean() }).strict().parse(input);
  saved(await supabaseAdmin.from("tr_settings").upsert({ institution_id: inst, ...i }, { onConflict: "institution_id" }).select("institution_id"));
  return sharing(inst);
}

/** The Transport page as one child's parent sees it, with only what the school shares. */
export async function parentPreview(inst: string, studentId?: string) {
  const [share, al, st] = await Promise.all([sharing(inst), allocations(inst), stops(inst)]);
  const list = [...al.items].sort((a, b) => a.student.localeCompare(b.student));
  const a = list.find((x) => x.student_id === studentId) ?? list[0];
  const students = list.map((x) => ({ id: x.student_id, label: [x.student, x.class_label].filter(Boolean).join(" · ") }));
  if (!a) return { sharing: share, students, page: null };
  const [board, c, parents] = await Promise.all([liveBoard(inst), crew(inst), parentsOf(inst, [a.student_id])]);
  const run = board.routes.find((r) => r.id === a.route_id);
  const stop = st.items.find((s) => s.id === a.stop_id);
  const driver = c.drivers.find((d) => d.status === "Active" && d.route === run?.route);
  const attendant = c.attendants.find((d) => d.status === "Active" && d.route === run?.route);
  const p = parents.get(a.student_id);
  return {
    sharing: share, students,
    page: {
      student_id: a.student_id, parent: p?.name ?? "",
      route: run?.route ?? a.route, vehicle: run?.vehicle ?? "", reg_no: run?.reg_no ?? "",
      stop: stop?.name ?? "", pickup: stop?.pickup ?? "", drop: stop?.drop ?? "",
      today: run?.state ?? "Not started", late: run?.running ? run.late : 0,
      driver: driver ? { name: driver.name, mobile: share.share_numbers ? driver.mobile : null, police: driver.police } : null,
      attendant: attendant ? { name: attendant.name, mobile: share.share_numbers ? attendant.mobile : null, first_aid: attendant.first_aid } : null,
      run: share.share_location && run ? run : null,
    },
  };
}

// ═════════════ transport fees ═════════════
export type TermState = "Paid" | "Overdue" | "Part paid" | "Due" | "Not due" | "";
/** The year's transport fee in terms, split by the school's term percentages (the last term takes the rounding). */
export function termFees(annual: number, percents: number[], due: string[], paid: number[], now: string) {
  const n = percents.length;
  return percents.map((pct, t) => {
    const amount = t === n - 1 ? annual - percents.slice(0, n - 1).reduce((a, p) => a + Math.round((annual * p) / 100), 0) : Math.round((annual * pct) / 100);
    const got = Math.min(amount, paid[t] ?? 0);
    const billed = !!due[t] && due[t] <= now;
    const state: TermState = amount <= 0 ? "" : got >= amount ? "Paid" : due[t] < now ? "Overdue" : got > 0 ? "Part paid" : billed ? "Due" : "Not due";
    return { amount, paid: got, billed, state };
  });
}

export async function feeBook(inst: string) {
  const [al, r, plans, opt, set, start] = await Promise.all([
    allocations(inst), routes(inst),
    supabaseAdmin.from("student_fee_plans").select("student_id, transport_id").eq("institution_id", inst).limit(20000),
    supabaseAdmin.from("fee_optional").select("id, amount_year, kind, status").eq("institution_id", inst),
    feeSettings(inst), yearStart(inst),
  ]);
  const ids = al.items.map((x) => x.student_id);
  const paidRows: { line_key: string; amount: number; fee_payments: { student_id: string } | { student_id: string }[] }[] = [];
  const reminders: { student_id: string; sent_on: string }[] = [];
  for (let a = 0; a < ids.length; a += 200) {
    const part = ids.slice(a, a + 200);
    const [p, m] = await Promise.all([
      supabaseAdmin.from("fee_payment_lines").select("line_key, amount, fee_payments:payment_id!inner(student_id, status, institution_id)").eq("fee_payments.institution_id", inst).eq("fee_payments.status", "Paid").like("line_key", "%:transport").in("fee_payments.student_id", part).limit(20000),
      supabaseAdmin.from("fee_reminders").select("student_id, sent_on").eq("institution_id", inst).in("student_id", part).limit(20000),
    ]);
    paidRows.push(...(check(p) as unknown as typeof paidRows)); reminders.push(...(check(m) as typeof reminders));
  }
  const due = dueIso(set.due_dates, start); const now = today(); const percents = set.terms;
  const P = new Map((check(plans) as { student_id: string; transport_id: string | null }[]).map((x) => [x.student_id, x.transport_id]));
  const O = check(opt) as { id: string; amount_year: number; kind: string; status: string }[];
  const price = new Map(O.map((x) => [x.id, x.amount_year]));
  const current = O.find((x) => x.kind === "Transport" && x.status === "Active")?.amount_year ?? 0;
  const paid = new Map<string, number[]>();
  for (const row of paidRows) { const sid = one(row.fee_payments)!.student_id; const t = Number(row.line_key.match(/^T(\d+):/)?.[1] ?? 0) - 1; if (t < 0) continue; const list = paid.get(sid) ?? []; list[t] = (list[t] ?? 0) + row.amount; paid.set(sid, list); }
  const last = new Map<string, string>(); for (const x of reminders) if ((last.get(x.student_id) ?? "") < x.sent_on) last.set(x.student_id, x.sent_on);
  const students = al.items.map((x) => {
    const plan = P.get(x.student_id); const annual = plan ? price.get(plan) ?? 0 : 0;
    const terms = termFees(annual, percents, due, paid.get(x.student_id) ?? [], now);
    const sum = (f: (t: (typeof terms)[number]) => number) => terms.filter((t) => t.billed).reduce((n, t) => n + f(t), 0);
    return { id: x.student_id, name: x.student, class_label: x.class_label, route_id: x.route_id ?? "", route: x.route, stop: x.stop === "—" ? "" : x.stop, terms, billed: sum((t) => t.amount), collected: sum((t) => t.paid), pending: sum((t) => t.amount - t.paid), reminded_on: last.get(x.student_id) ?? null };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const perTerm = termFees(current, percents, due, [], now)[0]?.amount ?? 0;
  const billedTerms = due.map((d, t) => (d && d <= now ? t + 1 : 0)).filter(Boolean);
  const total = (k: "billed" | "collected" | "pending") => students.reduce((n, s) => n + s[k], 0);
  const y = Number(start.slice(0, 4));
  return {
    year: `${y}–${String(y + 1).slice(2)}`, per_term: perTerm, term_count: percents.length, billed_terms: billedTerms,
    riders: students.length, billed: total("billed"), collected: total("collected"), pending: total("pending"), pending_students: students.filter((s) => s.pending > 0).length,
    routes: r.items.filter((x) => x.status === "Active").map((x) => { const mine = students.filter((s) => s.route_id === x.id); const add = (k: "billed" | "collected" | "pending") => mine.reduce((n, s) => n + s[k], 0); return { id: x.id, name: x.name, area: x.area, riders: mine.length, per_term: perTerm, billed: add("billed"), collected: add("collected"), pending: add("pending") }; }),
    students,
  };
}

export async function feeRule(inst: string) {
  const [book, dir] = await Promise.all([feeBook(inst), directory(inst)]);
  const accountant = dir.items.find((s) => /^accountant$/i.test(s.role) && s.status === "Active");
  return { ...book, accountant: accountant?.name ?? "" };
}

/** A reminder in the parent app for each rider with transport fee pending; once a day at most. It is logged with Fee & Finance's reminders. */
export async function remindFees(inst: string, me: string, input: unknown) {
  const { student_ids } = z.object({ student_ids: z.array(uid).min(1, "Choose who to remind.").max(2000) }).strict().parse(input);
  const book = await feeBook(inst); const want = new Set(student_ids);
  const due = book.students.filter((s) => want.has(s.id) && s.pending > 0);
  const fresh = due.filter((s) => s.reminded_on !== today());
  const parents = await parentsOf(inst, fresh.map((s) => s.id));
  const send = fresh.filter((s) => parents.has(s.id));
  for (let a = 0; a < send.length; a += 500) {
    const part = send.slice(a, a + 500);
    check(await supabaseAdmin.from("parent_messages").insert(part.map((s) => ({ institution_id: inst, kind: "notification", guardian_id: parents.get(s.id)!.guardian_id, student_id: s.id, subject: "Fee reminder", body: `Transport fee of ${rupees(s.pending)} for ${s.name} (${s.class_label}) is pending. Please pay at the earliest.`, channel: "App", created_by: me }))).select("id"));
    check(await supabaseAdmin.from("fee_reminders").insert(part.map((s) => ({ institution_id: inst, student_id: s.id, sent_on: today(), amount: s.pending, created_by: me }))).select("id"));
  }
  return { reminded: send.length, already: due.length - fresh.length, no_parent: fresh.length - send.length };
}

/** A change to the fee is asked of Fee & Finance: a help desk request, and a task on each accountant's list. */
export async function askFinance(inst: string, me: string, input: unknown) {
  const { change } = z.object({ change: z.string().trim().min(3, "Say what should change.").max(400) }).strict().parse(input);
  const [book, dir] = await Promise.all([feeBook(inst), directory(inst)]);
  const t = await raiseTicket(inst, me, { category: "Other staff requests", subject: "Change the transport fee", details: `Now: ${book.per_term ? `${rupees(book.per_term)} a term` : "not set"}\n\nRequested change: ${change}` }, "Staff");
  check(await supabaseAdmin.from("hd_tickets").update({ assigned_name: "Accounts office" }).eq("id", t.id).eq("institution_id", inst).select("id"));
  const accountants = dir.items.filter((s) => /^accountant$/i.test(s.role) && s.status === "Active");
  if (accountants.length) check(await supabaseAdmin.from("acc_tasks").upsert(accountants.map((a) => ({ institution_id: inst, owner_id: a.id, title: `Transport fee change asked (${t.code})`, detail: change, source_key: `transport-fee:${t.id}` })), { onConflict: "institution_id,owner_id,source_key" }).select("id"));
  return { code: t.code, told: accountants.length };
}
