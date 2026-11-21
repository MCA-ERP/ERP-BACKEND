import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { directory } from "./hr.service";

/** Library circulation: members, issue, return, reservations, fines, settings. Plus inventory items. */
const uid = z.string().uuid();
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

// ═════════════ settings ═════════════
const OPT = { ref_rule: ["Read in library only", "Can be issued"], remind_days: [0, 1, 2, 3, 5], max_fine: ["Up to the book's price", "No limit"], lost_rule: ["Book price + ₹50 processing", "Book price only"] } as const;
const DEF = { lim_low: 1, lim_high: 2, lim_staff: 5, ref_rule: "Read in library only", days_student: 14, days_staff: 30, renewals: 2, remind_days: 2, late_student: 2, late_staff: 5, max_fine: "Up to the book's price", lost_rule: "Book price + ₹50 processing", block_unpaid: true };
export async function settings(inst: string) { const r = check(await supabaseAdmin.from("lib_settings").select("lim_low, lim_high, lim_staff, ref_rule, days_student, days_staff, renewals, remind_days, late_student, late_staff, max_fine, lost_rule, block_unpaid").eq("institution_id", inst).maybeSingle()) as typeof DEF | null; return { options: OPT, ...(r ?? DEF) }; }
export async function saveSettings(inst: string, input: unknown) {
  const n = (max: number) => z.number().int().min(0).max(max);
  const i = z.object({ lim_low: n(50), lim_high: n(50), lim_staff: n(50), ref_rule: z.enum(OPT.ref_rule), days_student: z.number().int().min(1).max(365), days_staff: z.number().int().min(1).max(365), renewals: n(10), remind_days: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(5)]), late_student: n(1000), late_staff: n(1000), max_fine: z.enum(OPT.max_fine), lost_rule: z.enum(OPT.lost_rule), block_unpaid: z.boolean() }).strict().parse(input);
  check(await supabaseAdmin.from("lib_settings").upsert({ institution_id: inst, ...i }, { onConflict: "institution_id" }).select("institution_id")); return settings(inst);
}

// ═════════════ members ═════════════
async function issuesRaw(inst: string) { return check(await supabaseAdmin.from("lib_issues").select("id, copy_id, member_id, issued_on, due_on, returned_on, renewals, status").eq("institution_id", inst).order("issued_on", { ascending: false }).limit(20000)) as { id: string; copy_id: string; member_id: string; issued_on: string; due_on: string; returned_on: string | null; renewals: number; status: string }[]; }
export async function members(inst: string, kind: string) {
  const k = z.enum(["Student", "Staff"]).parse(kind); const set = await settings(inst);
  const [m, ro, st, is, fn] = await Promise.all([supabaseAdmin.from("lib_members").select("id, code, kind, student_id, staff_id, valid_until, status").eq("institution_id", inst).eq("kind", k).order("code"), roster(inst), directory(inst), issuesRaw(inst), supabaseAdmin.from("lib_fines").select("member_id").eq("institution_id", inst).eq("status", "Unpaid")]);
  const R = new Map(ro.items.map((x) => [x.id, x])); const S = new Map(st.items.map((x) => [x.id, x])); const out = is.filter((x) => x.status === "Issued"); const F = new Set((check(fn) as { member_id: string }[]).map((x) => x.member_id));
  const items = (check(m) as { id: string; code: string; kind: string; student_id: string | null; staff_id: string | null; valid_until: string; status: string }[]).map((x) => { const r = x.student_id ? R.get(x.student_id) : null; const s = x.staff_id ? S.get(x.staff_id) : null; return { id: x.id, code: x.code, name: r?.name ?? s?.name ?? "", type: x.kind, group: r?.class_label ?? s?.department ?? "", allowed: allowedFor(x.kind, r?.class_label ?? "", set), out: out.filter((y) => y.member_id === x.id).length, valid_until: x.valid_until, status: x.status, fines: F.has(x.id) }; });
  const have = new Set((check(await supabaseAdmin.from("lib_members").select("student_id, staff_id").eq("institution_id", inst)) as { student_id: string | null; staff_id: string | null }[]).flatMap((x) => [x.student_id, x.staff_id]).filter(Boolean));
  return { items, people: k === "Student" ? ro.items.filter((x) => x.status === "Enrolled" && !have.has(x.id)).map((x) => ({ id: x.id, name: `${x.name} · ${x.class_label}` })) : st.items.filter((x) => !have.has(x.id)).map((x) => ({ id: x.id, name: x.name })) };
}
function allowedFor(kind: string, classLabel: string, set: { lim_low: number; lim_high: number; lim_staff: number }) { if (kind === "Staff") return set.lim_staff; const n = Number((classLabel.match(/\b(\d{1,2})\b/) ?? [])[1]); return n >= 6 ? set.lim_high : set.lim_low; }
const yearEnd = () => { const d = new Date(Date.now() + 5.5 * 3600000); const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(); return `${y}-03-31`; };
export async function addMember(inst: string, input: unknown) {
  const i = z.object({ kind: z.enum(["Student", "Staff"]), ref_id: uid }).strict().parse(input);
  const ok = i.kind === "Student" ? (await roster(inst)).items.some((x) => x.id === i.ref_id) : (await directory(inst)).items.some((x) => x.id === i.ref_id); if (!ok) throw new HttpError(404, "Person not found.");
  const dup = check(await supabaseAdmin.from("lib_members").select("id").eq("institution_id", inst).eq(i.kind === "Student" ? "student_id" : "staff_id", i.ref_id)) as unknown[]; if (dup.length) throw new HttpError(409, "Already a member.");
  return check(await supabaseAdmin.from("lib_members").insert({ institution_id: inst, kind: i.kind, [i.kind === "Student" ? "student_id" : "staff_id"]: i.ref_id, valid_until: yearEnd() }).select("id, code").single());
}
export async function enrolAll(inst: string, kind: string) {
  const k = z.enum(["Student", "Staff"]).parse(kind); const m = await members(inst, k);
  if (!m.people.length) return { added: 0 };
  check(await supabaseAdmin.from("lib_members").insert(m.people.map((p) => ({ institution_id: inst, kind: k, [k === "Student" ? "student_id" : "staff_id"]: p.id, valid_until: yearEnd() }))).select("id"));
  return { added: m.people.length };
}
export async function setMember(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Blocked"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("lib_members").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ issues ═════════════
export async function issues(inst: string, view?: string) {
  const [is, cp, bk, mb, ro, st] = await Promise.all([issuesRaw(inst), supabaseAdmin.from("lib_copies").select("id, book_id, accession_no").eq("institution_id", inst).limit(20000), supabaseAdmin.from("lib_books").select("id, title").eq("institution_id", inst), supabaseAdmin.from("lib_members").select("id, student_id, staff_id, kind").eq("institution_id", inst), roster(inst), directory(inst)]);
  const C = new Map((check(cp) as { id: string; book_id: string; accession_no: string }[]).map((x) => [x.id, x])); const B = new Map((check(bk) as { id: string; title: string }[]).map((x) => [x.id, x.title]));
  const M = new Map((check(mb) as { id: string; student_id: string | null; staff_id: string | null; kind: string }[]).map((x) => [x.id, x])); const R = new Map(ro.items.map((x) => [x.id, x])); const S = new Map(st.items.map((x) => [x.id, x])); const now = today();
  const items = is.map((x) => { const c = C.get(x.copy_id); const m = M.get(x.member_id); const r = m?.student_id ? R.get(m.student_id) : null; const s = m?.staff_id ? S.get(m.staff_id) : null; return { id: x.id, acc_no: c?.accession_no ?? "", book: B.get(c?.book_id ?? "") ?? "", member: r?.name ?? s?.name ?? "", group: r?.class_label ?? s?.designation ?? "", issued_on: x.issued_on, due_on: x.due_on, returned_on: x.returned_on, renewals: x.renewals, status: x.status === "Issued" && x.due_on < now ? "Overdue" : x.status, kind: m?.kind ?? "Student" }; });
  const f = view === "out" ? items.filter((x) => ["Issued", "Overdue"].includes(x.status)) : view === "issued" ? items.filter((x) => x.status === "Issued") : view === "overdue" ? items.filter((x) => x.status === "Overdue") : view === "lost" ? items.filter((x) => x.status === "Lost") : items;
  return { items: f };
}
export async function issueForm(inst: string) {
  const [m, c] = await Promise.all([supabaseAdmin.from("lib_members").select("id, code, status, student_id, staff_id").eq("institution_id", inst).eq("status", "Active"), supabaseAdmin.from("lib_copies").select("id, accession_no, status, book_id, bk:book_id(title)").eq("institution_id", inst).eq("status", "Available").limit(2000)]);
  const mm = [...(await members(inst, "Student")).items, ...(await members(inst, "Staff")).items].filter((x) => x.status === "Active");
  void m; return { members: mm.map((x) => ({ id: x.id, name: `${x.name} · ${x.group}`, code: x.code })), copies: (check(c) as unknown as { id: string; accession_no: string; bk: { title: string } | { title: string }[] | null }[]).map((x) => ({ id: x.id, acc_no: x.accession_no, title: one(x.bk)?.title ?? "" })) };
}
async function bump(bookId: string, d: number) { const b = check(await supabaseAdmin.from("lib_books").select("copies, available").eq("id", bookId).single()) as { copies: number; available: number }; check(await supabaseAdmin.from("lib_books").update({ available: Math.max(0, Math.min(b.copies, b.available + d)) }).eq("id", bookId).select("id")); }
export async function issueBook(inst: string, input: unknown) {
  const i = z.object({ acc_no: z.string().trim().min(1, "Enter the accession number."), member_id: uid, issued_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict().parse(input);
  const copy = check(await supabaseAdmin.from("lib_copies").select("id, book_id, status").eq("institution_id", inst).eq("accession_no", i.acc_no).maybeSingle()) as { id: string; book_id: string; status: string } | null; if (!copy) throw new HttpError(404, "No copy has that accession number.");
  if (copy.status !== "Available") throw new HttpError(409, "That copy is already issued.");
  const all = [...(await members(inst, "Student")).items, ...(await members(inst, "Staff")).items]; const m = all.find((x) => x.id === i.member_id); if (!m) throw new HttpError(404, "Member not found.");
  const set = await settings(inst);
  if (m.status === "Blocked") throw new HttpError(409, "That member is blocked.");
  if (m.valid_until < today()) throw new HttpError(409, "That membership has expired.");
  if (m.out >= m.allowed) throw new HttpError(409, `${m.name} already has ${m.out} of ${m.allowed} books.`);
  if (set.block_unpaid && m.fines) throw new HttpError(409, "Unpaid fines block new issues. Collect them first.");
  const from = i.issued_on ?? today(); const due = addDays(from, m.type === "Staff" ? set.days_staff : set.days_student);
  const r = check(await supabaseAdmin.from("lib_issues").insert({ institution_id: inst, copy_id: copy.id, member_id: i.member_id, issued_on: from, due_on: due }).select("id").single());
  check(await supabaseAdmin.from("lib_copies").update({ status: "Issued" }).eq("id", copy.id).select("id")); await bump(copy.book_id, -1);
  const res = check(await supabaseAdmin.from("lib_reservations").select("id, book_id").eq("institution_id", inst).eq("member_id", i.member_id).eq("book_id", copy.book_id).in("status", ["Waiting", "Ready to collect"])) as { id: string }[];
  for (const x of res) check(await supabaseAdmin.from("lib_reservations").update({ status: "Issued" }).eq("id", x.id).select("id"));
  return { ...(r as unknown as object), due };
}
async function getIssue(inst: string, id: string) {
  const x = check(await supabaseAdmin.from("lib_issues").select("id, copy_id, member_id, due_on, renewals, status, cp:copy_id(book_id, bk:book_id(price))").eq("id", id).eq("institution_id", inst).maybeSingle()) as unknown as { id: string; copy_id: string; member_id: string; due_on: string; renewals: number; status: string; cp: { book_id: string; bk: { price: number } | { price: number }[] | null } | { book_id: string; bk: { price: number } | { price: number }[] | null }[] | null } | null;
  if (!x) throw new HttpError(404, "Not found."); if (x.status !== "Issued") throw new HttpError(409, "That book is not out."); return { ...x, book_id: one(x.cp)?.book_id ?? "", price: one(one(x.cp)?.bk ?? null)?.price ?? 0 };
}
async function memberKind(id: string) { return (check(await supabaseAdmin.from("lib_members").select("kind").eq("id", id).single()) as { kind: string }).kind; }
export async function returnBook(inst: string, id: string) {
  const x = await getIssue(inst, id); const set = await settings(inst); const now = today(); let fine = 0;
  const late = Math.max(0, daysBetween(x.due_on, now));
  if (late > 0) { const rate = (await memberKind(x.member_id)) === "Staff" ? set.late_staff : set.late_student; fine = late * rate; if (set.max_fine !== "No limit" && x.price > 0) fine = Math.min(fine, x.price); }
  check(await supabaseAdmin.from("lib_issues").update({ status: "Returned", returned_on: now }).eq("id", id).select("id"));
  check(await supabaseAdmin.from("lib_copies").update({ status: "Available" }).eq("id", x.copy_id).select("id")); await bump(x.book_id, 1);
  if (fine > 0) check(await supabaseAdmin.from("lib_fines").insert({ institution_id: inst, member_id: x.member_id, issue_id: id, reason: `Late return · ${late} days`, amount: fine }).select("id"));
  const w = check(await supabaseAdmin.from("lib_reservations").select("id").eq("institution_id", inst).eq("book_id", x.book_id).eq("status", "Waiting").order("reserved_on").order("code").limit(1)) as { id: string }[];
  if (w[0]) check(await supabaseAdmin.from("lib_reservations").update({ status: "Ready to collect" }).eq("id", w[0].id).select("id"));
  return { late_days: late, fine, reserved_for_next: !!w[0] };
}
export async function renew(inst: string, id: string) {
  const x = await getIssue(inst, id); const set = await settings(inst);
  if (x.renewals >= set.renewals) throw new HttpError(409, `Already renewed ${set.renewals} times.`);
  const waiting = check(await supabaseAdmin.from("lib_reservations").select("id").eq("book_id", x.book_id).in("status", ["Waiting", "Ready to collect"]).limit(1)) as unknown[]; if (waiting.length) throw new HttpError(409, "Someone has reserved this book.");
  const days = (await memberKind(x.member_id)) === "Staff" ? set.days_staff : set.days_student; const from = x.due_on > today() ? x.due_on : today();
  check(await supabaseAdmin.from("lib_issues").update({ due_on: addDays(from, days), renewals: x.renewals + 1 }).eq("id", id).select("id")); return { due: addDays(from, days) };
}
export async function markLost(inst: string, id: string) {
  const x = await getIssue(inst, id); const set = await settings(inst); const amount = x.price + (set.lost_rule.includes("₹50") ? 50 : 0);
  check(await supabaseAdmin.from("lib_issues").update({ status: "Lost", returned_on: today() }).eq("id", id).select("id"));
  check(await supabaseAdmin.from("lib_copies").update({ status: "Lost" }).eq("id", x.copy_id).select("id")); // the copy stays on record as lost; the book has one fewer
  const b = check(await supabaseAdmin.from("lib_books").select("copies, available").eq("id", x.book_id).single()) as { copies: number; available: number };
  check(await supabaseAdmin.from("lib_books").update({ copies: Math.max(0, b.copies - 1), available: Math.min(Math.max(0, b.copies - 1), b.available) }).eq("id", x.book_id).select("id"));
  if (amount > 0) check(await supabaseAdmin.from("lib_fines").insert({ institution_id: inst, member_id: x.member_id, reason: "Lost book", amount }).select("id"));
  return { fine: amount };
}

// ═════════════ reservations ═════════════
export async function reservations(inst: string) {
  const [r, bk, ro, st, mb] = await Promise.all([supabaseAdmin.from("lib_reservations").select("id, code, book_id, member_id, reserved_on, status").eq("institution_id", inst).order("reserved_on", { ascending: false }).order("code", { ascending: false }), supabaseAdmin.from("lib_books").select("id, title, available").eq("institution_id", inst).order("title"), roster(inst), directory(inst), supabaseAdmin.from("lib_members").select("id, student_id, staff_id").eq("institution_id", inst)]);
  const B = check(bk) as { id: string; title: string; available: number }[]; const M = check(mb) as { id: string; student_id: string | null; staff_id: string | null }[]; const R = new Map(ro.items.map((x) => [x.id, x])); const S = new Map(st.items.map((x) => [x.id, x]));
  const rows = check(r) as { id: string; code: string; book_id: string; member_id: string; reserved_on: string; status: string }[];
  const who = (id: string) => { const m = M.find((x) => x.id === id); const a = m?.student_id ? R.get(m.student_id) : null; const b = m?.staff_id ? S.get(m.staff_id) : null; return { name: a?.name ?? b?.name ?? "", group: a?.class_label ?? b?.designation ?? "" }; };
  const live = rows.filter((x) => ["Waiting", "Ready to collect"].includes(x.status));
  const queue = (x: (typeof rows)[number]) => live.filter((y) => y.book_id === x.book_id && (y.reserved_on < x.reserved_on || (y.reserved_on === x.reserved_on && y.code <= x.code))).length;
  return { books: B.map((x) => ({ id: x.id, title: x.title })), members: [...(await members(inst, "Student")).items, ...(await members(inst, "Staff")).items].map((x) => ({ id: x.id, name: x.name, group: x.group })), items: rows.map((x) => ({ ...x, book: B.find((y) => y.id === x.book_id)?.title ?? "", member: who(x.member_id).name, group: who(x.member_id).group, position: ["Waiting", "Ready to collect"].includes(x.status) ? queue(x) : 0 })) };
}
export async function addReservation(inst: string, input: unknown) {
  const i = z.object({ book_id: uid, member_id: uid }).strict().parse(input);
  const b = check(await supabaseAdmin.from("lib_books").select("id, available").eq("id", i.book_id).eq("institution_id", inst).maybeSingle()) as { id: string; available: number } | null; if (!b) throw new HttpError(404, "Book not found.");
  if (!check(await supabaseAdmin.from("lib_members").select("id").eq("id", i.member_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Member not found.");
  const dup = check(await supabaseAdmin.from("lib_reservations").select("id").eq("book_id", i.book_id).eq("member_id", i.member_id).in("status", ["Waiting", "Ready to collect"])) as unknown[]; if (dup.length) throw new HttpError(409, "Already reserved by that member.");
  return check(await supabaseAdmin.from("lib_reservations").insert({ institution_id: inst, ...i, reserved_on: today(), status: b.available > 0 ? "Ready to collect" : "Waiting" }).select("id, code").single());
}
export async function cancelReservation(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("lib_reservations").update({ status: "Cancelled" }).eq("id", id).eq("institution_id", inst).in("status", ["Waiting", "Ready to collect"]).select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That can't be cancelled."); return { ok: true };
}

// ═════════════ fines ═════════════
export async function fines(inst: string) {
  const [f, mb, ro, st, is, cp, bk] = await Promise.all([supabaseAdmin.from("lib_fines").select("id, code, member_id, issue_id, reason, amount, fined_on, status").eq("institution_id", inst).order("fined_on", { ascending: false }).order("code", { ascending: false }), supabaseAdmin.from("lib_members").select("id, student_id, staff_id").eq("institution_id", inst), roster(inst), directory(inst), issuesRaw(inst), supabaseAdmin.from("lib_copies").select("id, book_id").eq("institution_id", inst).limit(20000), supabaseAdmin.from("lib_books").select("id, title").eq("institution_id", inst)]);
  const M = check(mb) as { id: string; student_id: string | null; staff_id: string | null }[]; const R = new Map(ro.items.map((x) => [x.id, x.name])); const S = new Map(st.items.map((x) => [x.id, x.name])); const C = check(cp) as { id: string; book_id: string }[]; const B = check(bk) as { id: string; title: string }[];
  return { items: (check(f) as { id: string; code: string; member_id: string; issue_id: string | null; reason: string; amount: number; fined_on: string; status: string }[]).map((x) => { const m = M.find((y) => y.id === x.member_id); const i = is.find((y) => y.id === x.issue_id); return { ...x, member: (m?.student_id ? R.get(m.student_id) : m?.staff_id ? S.get(m.staff_id) : "") ?? "", book: B.find((y) => y.id === C.find((c) => c.id === i?.copy_id)?.book_id)?.title ?? "—" }; }) };
}
export async function settleFine(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Paid", "Waived"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("lib_fines").update({ status }).eq("id", id).eq("institution_id", inst).eq("status", "Unpaid").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That fine is already settled."); return { ok: true };
}

// ═════════════ inventory items ═════════════
export async function itemCategories(inst: string) {
  const [c, i] = await Promise.all([supabaseAdmin.from("inv_categories").select("id, name, status").eq("institution_id", inst).order("name"), supabaseAdmin.from("inv_items").select("category_id, in_stock, unit_price, reorder_at").eq("institution_id", inst)]);
  const I = check(i) as { category_id: string | null; in_stock: number; unit_price: number; reorder_at: number }[]; return { items: (check(c) as { id: string; name: string; status: string }[]).map((x) => { const m = I.filter((y) => y.category_id === x.id); return { ...x, items: m.length, stock_value: m.reduce((n, y) => n + y.in_stock * y.unit_price, 0), low: m.filter((y) => y.in_stock <= y.reorder_at).length }; }) };
}
export async function addItemCategory(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the category.").max(80) }).strict().parse(input);
  if ((check(await supabaseAdmin.from("inv_categories").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[]).length) throw new HttpError(409, "That category exists.");
  return check(await supabaseAdmin.from("inv_categories").insert({ institution_id: inst, name: i.name }).select("id").single());
}
export async function setItemCategory(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("inv_categories").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function items(inst: string) {
  const [i, c] = await Promise.all([supabaseAdmin.from("inv_items").select("id, code, name, category_id, unit, in_stock, reorder_at, unit_price").eq("institution_id", inst).order("code"), itemCategories(inst)]);
  return { categories: c.items.filter((x) => x.status === "Active").map((x) => ({ id: x.id, name: x.name })), items: (check(i) as { id: string; code: string; name: string; category_id: string | null; unit: string; in_stock: number; reorder_at: number; unit_price: number }[]).map((x) => ({ ...x, category: c.items.find((y) => y.id === x.category_id)?.name ?? "—", status: x.in_stock <= x.reorder_at ? "Low stock" : "In stock" })) };
}
const itemIn = z.object({ name: z.string().trim().min(2, "Enter the item.").max(160), category_id: uid.nullable().optional(), unit: z.string().trim().max(20).optional(), in_stock: z.number().int().min(0).max(10_000_000), reorder_at: z.number().int().min(0).max(10_000_000), unit_price: z.number().int().min(0).max(10_000_000) }).strict();
export async function addItem(inst: string, input: unknown) {
  const i = itemIn.extend({ code: z.string().trim().max(12).optional() }).parse(input);
  if (i.category_id && !check(await supabaseAdmin.from("inv_categories").select("id").eq("id", i.category_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Category not found.");
  if (i.code && (check(await supabaseAdmin.from("inv_items").select("id").eq("institution_id", inst).eq("code", i.code)) as unknown[]).length) throw new HttpError(409, "That item code is used.");
  const { code, ...rest } = i; return check(await supabaseAdmin.from("inv_items").insert({ institution_id: inst, ...(code ? { code } : {}), ...rest, category_id: rest.category_id ?? null, unit: rest.unit || "pieces" }).select("id, code").single());
}
export async function updateItem(inst: string, id: string, input: unknown) {
  const i = itemIn.parse(input); const r = check(await supabaseAdmin.from("inv_items").update({ ...i, category_id: i.category_id ?? null, unit: i.unit || "pieces" }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
