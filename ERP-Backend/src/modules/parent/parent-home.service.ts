import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { safeSearch } from "../../lib/query";
import { categories } from "../school/front-office.service";
import { houses } from "../school/act.service";
import { andList, childOf, family, forFamily, hhmm, inr, today, type Child, type Family } from "./parent-core";
import { feeStatus, feeSummary } from "./parent-fees.service";
import { attendanceData, homeworkData, pendingWork, results } from "./parent-learning.service";
import { announcements, libraryData } from "./parent-school.service";

/** The sidebar, bell and search, the dashboard tabs, house points, the school calendar and the help desk. */
const has = (mods: string[], ...codes: string[]) => codes.some((c) => mods.includes(c));

// ═════════════ who is signed in ═════════════
export async function me(inst: string, profile: string, mods: string[], agent = "") {
  const fam = await family(inst, profile);
  // the School Admin's "app sign-ins" page reads these
  await supabaseAdmin.from("guardians").update({ last_login_at: new Date().toISOString(), last_device: /android/i.test(agent) ? "Android" : /iphone|ipad/i.test(agent) ? "iPhone" : "Web" }).eq("institution_id", inst).in("id", fam.guardianIds);
  const notes = await notifications(inst, profile, mods, fam);
  // one count for each child with an overdue term (the notices carry the child in their key)
  const overdue = new Set(notes.items.filter((n) => n.icon === "fee").map((n) => n.key.split(":")[1]));
  const names = fam.children.map((c) => c.first_name);
  return {
    parent: { name: fam.guardian.full_name, parent_id: fam.guardian.parent_code ?? "" },
    line: names.length ? `Parent of ${andList(names)}` : "Parent",
    children: fam.children.map((c) => ({ id: c.id, name: c.name, first_name: c.first_name, class_label: c.class_label, roll_no: c.roll_no, class_teacher: c.class_teacher })),
    badges: { unread: notes.unread, fees: overdue.size },
    today: today(),
  };
}

// ═════════════ notifications ═════════════
type Note = { key: string; icon: "fee" | "message" | "notice"; title: string; text: string; at: string; href: string; unread: boolean };
export async function notifications(inst: string, profile: string, mods: string[], known?: Family) {
  const fam = known ?? (await family(inst, profile));
  const [rows, reads, due] = await Promise.all([
    supabaseAdmin.from("parent_messages").select("id, kind, subject, body, status, created_at, student_id").eq("institution_id", inst).in("guardian_id", fam.guardianIds).eq("direction", "out").in("kind", ["message", "notification"]).order("created_at", { ascending: false }).limit(100),
    supabaseAdmin.from("staff_notification_reads").select("key").eq("profile_id", profile).limit(2000),
    has(mods, "fees") ? Promise.all(fam.children.map(async (c) => ({ c, f: await feeSummary(inst, c) }))) : Promise.resolve([]),
  ]);
  const seen = new Set(((check(reads) ?? []) as { key: string }[]).map((r) => r.key));
  const fees: Note[] = due.flatMap(({ c, f }) => f.overdue_terms.map((t) => { const key = `fee:${c.id}:${t.term}`; return { key, icon: "fee" as const, title: `${c.first_name}'s ${t.name} fee is overdue`, text: `${inr(t.due)}${t.late ? ` incl. ${inr(t.late)} late fee` : ""} · was due ${new Date(`${t.due_date}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })}`, at: new Date().toISOString(), href: "/parent/fees/fee-status", unread: !seen.has(key) }; }));
  const msgs: Note[] = ((check(rows) ?? []) as { id: string; kind: string; subject: string; body: string | null; status: string; created_at: string; student_id: string | null }[]).map((r) => ({ key: r.id, icon: r.kind === "message" ? "message" as const : "notice" as const, title: r.subject, text: (r.body ?? "").slice(0, 200), at: r.created_at, href: noteHref(r.kind, r.subject), unread: r.status === "Delivered" }));
  const items = [...fees, ...msgs];
  return { items, unread: items.filter((i) => i.unread).length };
}
/** The page a notice is about, so opening it goes straight there. */
export function noteHref(kind: string, subject: string) {
  const s = subject.toLowerCase();
  if (kind === "message") return "/parent/communication/messages";
  if (/fee|receipt|invoice|concession/.test(s)) return "/parent/fees/fee-status";
  if (/bus|transport|route/.test(s)) return "/parent/transport/school-bus";
  if (/report card|result/.test(s)) return "/parent/academics/academic-records";
  if (/date sheet|exam/.test(s)) return "/parent/academics/academic-records?tab=exam-schedule";
  if (/homework|assignment/.test(s)) return "/parent/homework/homework";
  if (/diary|remark/.test(s)) return "/parent/communication/notices?tab=class-diary";
  if (/absent|attendance|leave/.test(s)) return "/parent/attendance/attendance-record";
  return "/parent/dashboard/my-dashboard?tab=notifications";
}
export async function markRead(inst: string, profile: string, mods: string[], input: unknown) {
  const { keys } = z.object({ keys: z.array(z.string().max(120)).max(200).optional() }).strict().parse(input ?? {});
  const fam = await family(inst, profile);
  const mine = (await notifications(inst, profile, mods, fam)).items;
  // only this family's own notices can be marked
  const chosen = mine.filter((n) => n.unread && (!keys || keys.includes(n.key)));
  const ids = chosen.filter((n) => !n.key.startsWith("fee:")).map((n) => n.key);
  const other = chosen.filter((n) => n.key.startsWith("fee:")).map((n) => n.key);
  if (ids.length) check(await supabaseAdmin.from("parent_messages").update({ status: "Read" }).eq("institution_id", inst).in("guardian_id", fam.guardianIds).in("id", ids).eq("status", "Delivered").select("id"));
  if (other.length) check(await supabaseAdmin.from("staff_notification_reads").upsert(other.map((key) => ({ profile_id: profile, key })), { onConflict: "profile_id,key" }).select("key"));
  return { ok: true };
}

// ═════════════ search ═════════════
export async function search(inst: string, profile: string, mods: string[], raw: unknown) {
  const q = safeSearch(raw).toLowerCase();
  if (q.length < 2) return { hits: [] };
  const fam = await family(inst, profile);
  const found = await Promise.all(fam.children.map(async (c) => {
    const [hw, lib] = await Promise.all([has(mods, "homework") ? homeworkData(inst, c) : null, has(mods, "library") ? libraryData(inst, c) : null]);
    return [
      ...(hw ? [...hw.homework, ...hw.assignments].filter((h) => `${h.title} ${h.subject}`.toLowerCase().includes(q)).slice(0, 5).map((h) => ({ type: "Homework", id: h.id, title: h.title, subtitle: `${c.first_name} · ${h.subject} · ${h.status}`, href: "/parent/homework/homework" })) : []),
      ...(lib ? lib.issues.filter((b) => `${b.title} ${b.author}`.toLowerCase().includes(q)).slice(0, 5).map((b) => ({ type: "Books", id: b.id, title: b.title, subtitle: `${c.first_name} · ${b.status}`, href: "/parent/library/library" })) : []),
    ];
  }));
  return { hits: found.flat().slice(0, 15) };
}

// ═════════════ dashboard ═════════════
async function upcomingEvents(inst: string, children: Child[]) {
  const rows = (check(await supabaseAdmin.from("calendar_events").select("id, title, event_date, end_date, kind, audience, note").eq("institution_id", inst).eq("published", true).gte("event_date", today()).order("event_date").limit(200)) ?? []) as { id: string; title: string; event_date: string; end_date: string | null; kind: string; audience: string; note: string | null }[];
  return rows.filter((e) => e.kind !== "Staff" && forFamily(e.audience, children)).map((e) => ({ ...e, days: Math.round((Date.parse(e.event_date) - Date.parse(today())) / 86400000) }));
}

export const TABS = ["overview", "attendance", "performance", "fees", "announcements", "events"] as const;
export async function dashboard(inst: string, profile: string, mods: string[], tab: (typeof TABS)[number], studentId?: unknown) {
  if (tab === "fees") return has(mods, "fees") ? feeStatus(inst, profile) : { off: "Fees" };
  if (tab === "announcements") { const fam = await family(inst, profile); return { items: await announcements(inst, fam.children), month: today().slice(0, 7) }; }
  if (tab === "events") { const fam = await family(inst, profile); return { items: await upcomingEvents(inst, fam.children) }; }
  const { fam, child } = await childOf(inst, profile, studentId);
  if (tab === "attendance") return has(mods, "attendance") ? attendanceData(inst, child) : { off: "Attendance" };
  if (tab === "performance") { if (!has(mods, "exams")) return { off: "Examinations" }; const r = await results(inst, child); return { tests: r.tests, subjects: r.subjects.map((s) => ({ name: s.name, average: s.average })) }; }

  const [att, res, fee, hw, bus, mess, house, ann, ev] = await Promise.all([
    has(mods, "attendance") ? attendanceData(inst, child) : null,
    has(mods, "exams") ? results(inst, child) : null,
    has(mods, "fees") ? feeSummary(inst, child) : null,
    has(mods, "homework") ? homeworkData(inst, child) : null,
    has(mods, "transport") ? supabaseAdmin.from("tr_allocations").select("tr_routes:route_id(name), tr_stops:stop_id(name, pickup)").eq("institution_id", inst).eq("student_id", child.id).maybeSingle() : null,
    has(mods, "cafeteria", "hostel") ? supabaseAdmin.from("mess_day_students").select("meals, diet, opted").eq("institution_id", inst).eq("student_id", child.id).maybeSingle() : null,
    Promise.resolve(child.house),
    announcements(inst, fam.children),
    upcomingEvents(inst, fam.children),
  ]);
  const b = bus ? (check(bus) as unknown as { tr_routes: { name: string } | null; tr_stops: { name: string; pickup: string | null } | null } | null) : null;
  const m = mess ? (check(mess) as { meals: string; diet: string; opted: boolean } | null) : null;
  const latest = res?.tests[res.tests.length - 1] ?? null;
  const others = fam.children.filter((c) => c.id !== child.id);
  return {
    parent_first: fam.guardian.full_name.replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/i, "").split(" ")[0],
    child: { id: child.id, name: child.name, first_name: child.first_name, class_label: child.class_label, roll_no: child.roll_no, registration_no: child.registration_no, date_of_birth: child.date_of_birth, gender: child.gender, class_teacher: child.class_teacher, house, blood_group: child.blood_group, bus: b?.tr_routes ? [b.tr_routes.name, b.tr_stops?.name, b.tr_stops?.pickup ? `pickup ${hhmm(b.tr_stops.pickup)}` : ""].filter(Boolean).join(" · ") : null, bus_on: !!bus, mess: mess ? { opted: !!m?.opted, text: m?.opted ? `${m.meals} · ${m.diet}` : "" } : null },
    next_child: others.length ? { id: others[0].id, first_name: others[0].first_name } : null,
    tiles: {
      attendance: att ? { pct: att.year.pct, absent: att.year.absent, leave: att.year.leave } : null,
      result: res ? (latest ? { pct: latest.pct, name: latest.name, grade: latest.grade } : { pct: null, name: "", grade: "" }) : null,
      fees: fee ? { has_plan: fee.has_plan, overdue: fee.overdue, next: fee.next } : null,
      homework: hw ? { pending: pendingWork(hw) } : null,
    },
    announcements: ann.slice(0, 4),
    events: ev.slice(0, 4),
  };
}

// ═════════════ house points ═════════════
export async function housePoints(inst: string, profile: string, studentId?: unknown) {
  const { child } = await childOf(inst, profile, studentId);
  const h = await houses(inst);
  const mine = (check(await supabaseAdmin.from("act_house_points").select("house_id, points").eq("institution_id", inst).eq("student_id", child.id).limit(2000)) ?? []) as { house_id: string; points: number }[];
  const year = check(await supabaseAdmin.from("academic_years").select("name").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { name: string } | null;
  const own = h.standings.find((x) => x.name.toLowerCase() === child.house.toLowerCase()) ?? h.standings.find((x) => x.id === mine[0]?.house_id) ?? null;
  return {
    year: year?.name ?? "",
    standings: h.standings.map((x) => ({ id: x.id, name: x.name, points: x.points })),
    child: { first_name: child.first_name, house: own?.name ?? child.house, points: mine.reduce((n, p) => n + p.points, 0) },
    recent: (h.recent as unknown as { id: string; awarded_on: string; student_label: string; house_id: string; points: number; reason: string; awarded_by: string }[]).map((r) => ({ id: r.id, date: r.awarded_on, student: r.student_label, house: h.standings.find((x) => x.id === r.house_id)?.name ?? "", points: r.points, reason: r.reason, by: r.awarded_by })),
  };
}

// ═════════════ calendar ═════════════
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
export async function calendar(inst: string, profile: string, from: string, to: string) {
  isoDay.parse(from); isoDay.parse(to);
  if (to < from || Date.parse(to) - Date.parse(from) > 400 * 86400000) throw new HttpError(400, "Choose a shorter range.");
  const fam = await family(inst, profile);
  const rows = (check(await supabaseAdmin.from("calendar_events").select("id, title, event_date, end_date, kind, audience, note").eq("institution_id", inst).eq("published", true).lte("event_date", to).order("event_date").limit(2000)) ?? []) as { id: string; title: string; event_date: string; end_date: string | null; kind: string; audience: string; note: string | null }[];
  return { items: rows.filter((x) => (x.end_date ?? x.event_date) >= from && x.kind !== "Staff" && forFamily(x.audience, fam.children)) };
}

// ═════════════ help desk ═════════════
export async function helpCategories(inst: string) {
  return { items: (await categories(inst)).filter((c) => c.raised_by === "Parents").map((c) => ({ name: c.name, handled_by: c.handled_by, reply_hours: c.reply_hours })) };
}
export async function raiseTicket(inst: string, profile: string, input: unknown) {
  const i = z.object({ student_id: z.string().uuid("Choose the child."), category: z.string().trim().min(1).max(80), subject: z.string().trim().min(3, "Write the subject.").max(250), details: z.string().trim().min(3, "Tell us what happened.").max(3800), priority: z.enum(["High", "Normal", "Low"]).default("Normal"), attachment_name: z.string().trim().max(160).regex(/\.(pdf|jpe?g|png)$/i, "Attach a PDF, JPG or PNG file.").optional() }).strict().parse(input);
  const { fam, child } = await childOf(inst, profile, i.student_id);
  const cat = (await categories(inst)).find((c) => c.name === i.category && c.raised_by === "Parents");
  if (!cat) throw new HttpError(400, "Choose one of the listed topics.");
  const open = (check(await supabaseAdmin.from("hd_tickets").select("id").eq("institution_id", inst).eq("created_by", profile).neq("status", "Resolved").limit(20)) ?? []) as unknown[];
  if (open.length >= 20) throw new HttpError(429, "You have many requests still open. Please wait for a reply.");
  const row = check(await supabaseAdmin.from("hd_tickets").insert({ institution_id: inst, subject: i.subject, category: i.category, raised_by_name: fam.guardian.full_name.slice(0, 150), raised_by_kind: "Parent", priority: i.priority, assigned_name: cat.handled_by, created_by: profile, details: `For ${child.name} (${child.class_label || child.registration_no})\n\n${i.details}`, attachment_name: i.attachment_name ?? null }).select("id, code").single()) as { id: string; code: string };
  return { id: row.id, code: row.code, handled_by: cat.handled_by, reply_hours: cat.reply_hours };
}
