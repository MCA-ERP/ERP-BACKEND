import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";

/** School fees: setup, structure, student plans, concessions, dues and collection. */
const uid = z.string().uuid();
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const gone = (rows: unknown[]) => { if (!rows.length) throw new HttpError(404, "Not found."); return { ok: true }; };
const norm = (n: string) => n.toLowerCase().replace(/^class\s+/, "").trim();

// ═════════════ setup ═════════════
export async function categories(inst: string) {
  const [c, h, s, g] = await Promise.all([supabaseAdmin.from("fee_categories").select("id, name, status").eq("institution_id", inst).order("name"), supabaseAdmin.from("fee_heads").select("id, name, category_id").eq("institution_id", inst), supabaseAdmin.from("fee_structure").select("head_id, amount"), supabaseAdmin.from("fee_groups").select("id").eq("institution_id", inst)]);
  const heads = check(h) as { id: string; name: string; category_id: string | null }[];
  const ids = new Set((check(g) as { id: string }[]).map((x) => x.id));
  const amounts = (check(s) as { head_id: string; amount: number }[]);
  return { items: (check(c) as { id: string; name: string; status: string }[]).map((x) => { const hs = heads.filter((y) => y.category_id === x.id); return { id: x.id, name: x.name, heads: hs.map((y) => y.name), status: x.status, max_annual: Math.max(0, ...hs.map((y) => Math.max(0, ...amounts.filter((a) => a.head_id === y.id).map((a) => a.amount)))) }; }), groups: ids.size };
}
export async function addCategory(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the category.").max(80) }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("fee_categories").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That category exists.");
  return check(await supabaseAdmin.from("fee_categories").insert({ institution_id: inst, name: i.name }).select("id").single());
}
export async function setCategory(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  return gone(check(await supabaseAdmin.from("fee_categories").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]);
}
export async function heads(inst: string) {
  const [h, c] = await Promise.all([supabaseAdmin.from("fee_heads").select("id, name, category_id, frequency, optional_text, status, cat:category_id(name)").eq("institution_id", inst).order("pos"), supabaseAdmin.from("fee_categories").select("id, name").eq("institution_id", inst).order("name")]);
  return { categories: check(c) as { id: string; name: string }[], items: (check(h) as unknown as { id: string; name: string; category_id: string | null; frequency: string; optional_text: string; status: string; cat: { name: string } | { name: string }[] | null }[]).map((x) => ({ id: x.id, name: x.name, category_id: x.category_id, category: one(x.cat)?.name ?? "", frequency: x.frequency, optional: x.optional_text, status: x.status })) };
}
export async function addHead(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the fee head.").max(80), category_id: uid.nullable().optional(), frequency: z.enum(["Term-wise", "Term 1 only", "Annual", "Monthly"]), optional: z.string().trim().max(40).optional() }).strict().parse(input);
  if (i.category_id) { const c = check(await supabaseAdmin.from("fee_categories").select("id").eq("id", i.category_id).eq("institution_id", inst).maybeSingle()); if (!c) throw new HttpError(404, "Category not found."); }
  const dup = check(await supabaseAdmin.from("fee_heads").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That fee head exists.");
  return check(await supabaseAdmin.from("fee_heads").insert({ institution_id: inst, name: i.name, category_id: i.category_id ?? null, frequency: i.frequency, optional_text: i.optional || "No" }).select("id").single());
}
export async function setHead(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  return gone(check(await supabaseAdmin.from("fee_heads").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]);
}

// ═════════════ settings: instalments, late fee, fine rules ═════════════
export interface FeeSet { terms: number[]; due_dates: string[]; year_discount: number; reminders: string; late_enabled: boolean; late_grace: number; late_per_day: number; late_max: number; late_waive: boolean; fine_lost_id: number; fine_lost_book: number; fine_damage: string; fine_waiver: string }
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const defaultDates = (n: number) => (n === 1 ? ["10 Apr"] : n === 2 ? ["10 Apr", "10 Oct"] : n === 3 ? ["10 Apr", "10 Oct", "10 Jan"] : ["10 Apr", "10 Jul", "10 Oct", "10 Jan"]);
const DEFAULTS: FeeSet = { terms: [40, 35, 25], due_dates: defaultDates(3), year_discount: 0, reminders: "7 and 1 days before, 3 days after", late_enabled: false, late_grace: 3, late_per_day: 50, late_max: 1500, late_waive: true, fine_lost_id: 150, fine_lost_book: 100, fine_damage: "Assessed case by case", fine_waiver: "Principal" };
export async function feeSettings(inst: string): Promise<FeeSet> {
  const s = check(await supabaseAdmin.from("fee_settings").select("terms, due_dates, year_discount, reminders, late_enabled, late_grace, late_per_day, late_max, late_waive, fine_lost_id, fine_lost_book, fine_damage, fine_waiver").eq("institution_id", inst).maybeSingle()) as FeeSet | null;
  if (!s) return DEFAULTS;
  return { ...s, due_dates: s.due_dates.length === s.terms.length ? s.due_dates : defaultDates(s.terms.length) };
}
/** "10 Apr" → the date inside this academic year, in order. */
export function dueIso(dates: string[], yearStart: string) {
  const y0 = Number(yearStart.slice(0, 4)); let prev = yearStart;
  return dates.map((s) => {
    const [d, mo] = s.split(" "); const m = MONTHS.indexOf(mo);
    let y = y0; const mk = (yy: number) => `${yy}-${String(m + 1).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
    while (mk(y) < prev) y++;
    prev = mk(y); return prev;
  });
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
export async function yearStart(inst: string) {
  const y = check(await supabaseAdmin.from("academic_years").select("start_date").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { start_date: string } | null;
  return y?.start_date ?? `${new Date().getFullYear()}-04-01`;
}
export async function installments(inst: string) { const s = await feeSettings(inst); return { terms: s.terms, due_dates: s.due_dates, year_discount: s.year_discount, reminders: s.reminders }; }
export async function saveInstallments(inst: string, input: unknown) {
  const i = z.object({ terms: z.array(z.number().int().min(1).max(100)).min(1).max(4), due_dates: z.array(z.string().regex(/^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/, "Write dates like 10 Apr.")).min(1).max(4), year_discount: z.number().int().min(0).max(100), reminders: z.string().trim().min(1).max(60) }).strict().parse(input);
  if (i.terms.reduce((a, b) => a + b, 0) !== 100) throw new HttpError(400, "The split must add up to 100%.");
  if (i.due_dates.length !== i.terms.length) throw new HttpError(400, "Give one due date for each instalment.");
  for (const d of i.due_dates) { const day = Number(d.split(" ")[0]); if (day < 1 || day > 28) throw new HttpError(400, "Use a day between 1 and 28."); }
  check(await supabaseAdmin.from("fee_settings").upsert({ institution_id: inst, ...i }, { onConflict: "institution_id" }).select("institution_id"));
  return installments(inst);
}
export async function lateFee(inst: string) { const s = await feeSettings(inst); return { enabled: s.late_enabled, grace: s.late_grace, per_day: s.late_per_day, max: s.late_max, waive: s.late_waive }; }
export async function saveLateFee(inst: string, input: unknown) {
  const i = z.object({ enabled: z.boolean(), grace: z.number().int().min(0).max(60), per_day: z.number().int().min(0).max(100000), max: z.number().int().min(0).max(10_000_000), waive: z.boolean() }).strict().parse(input);
  check(await supabaseAdmin.from("fee_settings").upsert({ institution_id: inst, late_enabled: i.enabled, late_grace: i.grace, late_per_day: i.per_day, late_max: i.max, late_waive: i.waive }, { onConflict: "institution_id" }).select("institution_id"));
  return lateFee(inst);
}
export async function fineRules(inst: string) { const s = await feeSettings(inst); return { lost_id: s.fine_lost_id, lost_book: s.fine_lost_book, damage: s.fine_damage, waiver: s.fine_waiver }; }
export async function saveFineRules(inst: string, input: unknown) {
  const i = z.object({ lost_id: z.number().int().min(0).max(1_000_000), lost_book: z.number().int().min(0).max(1_000_000), damage: z.enum(["Assessed case by case", "Fixed amount", "Actual repair cost"]), waiver: z.enum(["Principal", "Vice Principal", "School admin", "Accountant"]) }).strict().parse(input);
  check(await supabaseAdmin.from("fee_settings").upsert({ institution_id: inst, fine_lost_id: i.lost_id, fine_lost_book: i.lost_book, fine_damage: i.damage, fine_waiver: i.waiver }, { onConflict: "institution_id" }).select("institution_id"));
  return fineRules(inst);
}

/** What one student owes, term by term. Late fees count once a term is past its due date plus the grace days. */
export function buildLines(m: { fees: number; transport: number; hostel: number }, set: FeeSet, due: string[], paid: Map<string, number>, hasConcession: boolean, now = today()) {
  const n = set.terms.length;
  const cur = Math.max(0, due.filter((d) => d <= now).length - 1);
  const part = (annual: number, t: number) => (t === n - 1 ? annual - set.terms.slice(0, n - 1).reduce((a, p) => a + Math.round((annual * p) / 100), 0) : Math.round((annual * set.terms[t]) / 100));
  const lines: { key: string; label: string; amount: number; paid: number; due: number; term: number }[] = [];
  const terms: { term: number; date: string; amount: number; paid: number; due: number; status: "Paid" | "Overdue" | "Part paid" | "Scheduled"; lines: { label: string; amount: number; due: number }[] }[] = [];
  for (let t = 0; t < n; t++) {
    const name = TERM_NAMES[t] ?? `Term ${t + 1}`; let amount = 0, got = 0, owe = 0; const inTerm: { label: string; amount: number; due: number }[] = [];
    for (const [key, label, annual] of [["fees", `${name} fees`, m.fees], ["transport", `Bus fee, ${name}`, m.transport], ["hostel", `Hostel, ${name}`, m.hostel]] as [string, string, number][]) {
      const a = part(annual, t); if (a <= 0) continue;
      const p = paid.get(`T${t + 1}:${key}`) ?? 0; const d = Math.max(0, a - p);
      amount += a; got += Math.min(p, a); owe += d; inTerm.push({ label, amount: a, due: d });
      if (t <= cur && d > 0) lines.push({ key: `T${t + 1}:${key}`, label, amount: a, paid: p, due: d, term: t + 1 });
    }
    if (set.late_enabled && t <= cur && owe > 0 && now > due[t] && !(hasConcession && set.late_waive) && !(paid.get(`T${t + 1}:late`) ?? 0)) {
      const days = Math.max(0, daysBetween(due[t], now) - set.late_grace); const fee = Math.min(days * set.late_per_day, set.late_max);
      if (fee > 0) lines.push({ key: `T${t + 1}:late`, label: `Late fee, ${name}`, amount: fee, paid: 0, due: fee, term: t + 1 });
    }
    terms.push({ term: t + 1, date: due[t], amount, paid: got, due: owe, status: amount > 0 && owe === 0 ? "Paid" : owe > 0 && due[t] < now ? "Overdue" : got > 0 ? "Part paid" : "Scheduled", lines: inTerm });
  }
  return { lines, terms };
}

export async function gradeList(inst: string) { return check(await supabaseAdmin.from("grades").select("id, name, sort_order").eq("institution_id", inst).order("sort_order")) as { id: string; name: string; sort_order: number }[]; }
export function inGroup(gradeName: string, classes: string, grades: { name: string; sort_order: number }[]) {
  const parts = classes.split(/\s*[–-]\s*/).map(norm).filter(Boolean);
  const g = grades.find((x) => norm(x.name) === norm(gradeName));
  if (!g || !parts.length) return false;
  const orders = parts.map((p) => grades.find((x) => norm(x.name) === p)?.sort_order);
  if (orders.some((o) => o === undefined)) return false;
  return parts.length === 1 ? g.sort_order === orders[0] : g.sort_order >= Math.min(...(orders as number[])) && g.sort_order <= Math.max(...(orders as number[]));
}

export async function groups(inst: string) {
  const [g, s, ro, gr, pl] = await Promise.all([supabaseAdmin.from("fee_groups").select("id, name, classes, status").eq("institution_id", inst).order("pos"), supabaseAdmin.from("fee_structure").select("group_id, amount, fee_heads:head_id!inner(optional_text, institution_id)").eq("fee_heads.institution_id", inst), roster(inst), gradeList(inst), supabaseAdmin.from("student_fee_plans").select("student_id, group_id").eq("institution_id", inst)]);
  const S = check(s) as unknown as { group_id: string; amount: number; fee_heads: { optional_text: string } | { optional_text: string }[] | null }[];
  const P = new Map((check(pl) as { student_id: string; group_id: string | null }[]).map((p) => [p.student_id, p.group_id]));
  const G = check(g) as { id: string; name: string; classes: string; status: string }[];
  return { items: G.map((x) => ({ id: x.id, name: x.name, classes: x.classes, status: x.status, annual: S.filter((y) => y.group_id === x.id).reduce((n, y) => n + y.amount, 0), students: ro.items.filter((r) => r.status === "Enrolled" && (P.has(r.id) ? P.get(r.id) === x.id : inGroup(r.class_name, x.classes, gr))).length })) };
}
export async function addGroup(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the group.").max(80), classes: z.string().trim().min(1, "Enter the classes.").max(60) }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("fee_groups").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That group exists.");
  return check(await supabaseAdmin.from("fee_groups").insert({ institution_id: inst, ...i }).select("id").single());
}

// ═════════════ structure ═════════════
export async function structure(inst: string) {
  const [g, h, s] = await Promise.all([supabaseAdmin.from("fee_groups").select("id, name, classes").eq("institution_id", inst).eq("status", "Active").order("pos"), supabaseAdmin.from("fee_heads").select("id, name, optional_text").eq("institution_id", inst).eq("status", "Active").order("pos"), supabaseAdmin.from("fee_structure").select("group_id, head_id, amount, fee_groups:group_id!inner(institution_id)").eq("fee_groups.institution_id", inst)]);
  const S = check(s) as { group_id: string; head_id: string; amount: number }[];
  const H = (check(h) as { id: string; name: string; optional_text: string }[]).filter((x) => x.optional_text === "No" || S.some((y) => y.head_id === x.id));
  const used = H.filter((x) => S.some((y) => y.head_id === x.id));
  return { heads: used.map((x) => ({ id: x.id, name: x.name })), all_heads: H.map((x) => ({ id: x.id, name: x.name })), items: (check(g) as { id: string; name: string; classes: string }[]).map((x) => { const a = Object.fromEntries(H.map((y) => [y.id, S.find((z) => z.group_id === x.id && z.head_id === y.id)?.amount ?? 0])); return { id: x.id, name: x.name, classes: x.classes, amounts: a, total: used.reduce((n, y) => n + (a[y.id] ?? 0), 0) }; }) };
}
export async function saveStructure(inst: string, input: unknown) {
  const i = z.object({ group_id: uid, amounts: z.record(uid, z.number().int().min(0).max(10_000_000)) }).strict().parse(input);
  const g = check(await supabaseAdmin.from("fee_groups").select("id").eq("id", i.group_id).eq("institution_id", inst).maybeSingle());
  if (!g) throw new HttpError(404, "Group not found.");
  const ok = new Set((check(await supabaseAdmin.from("fee_heads").select("id").eq("institution_id", inst)) as { id: string }[]).map((x) => x.id));
  const rows = Object.entries(i.amounts).filter(([k]) => ok.has(k)).map(([head_id, amount]) => ({ group_id: i.group_id, head_id, amount }));
  if (rows.length) check(await supabaseAdmin.from("fee_structure").upsert(rows, { onConflict: "group_id,head_id" }).select("head_id"));
  return { saved: rows.length };
}
export async function sectionWise(inst: string) {
  const [r, s, g, gr] = await Promise.all([supabaseAdmin.from("fee_section_overrides").select("section_id, head_id, amount, stream, sections:section_id!inner(institution_id, name, grades:grade_id(name)), fee_heads:head_id(name)").eq("sections.institution_id", inst), supabaseAdmin.from("fee_structure").select("group_id, head_id, amount"), supabaseAdmin.from("fee_groups").select("id, classes").eq("institution_id", inst), gradeList(inst)]);
  const S = check(s) as { group_id: string; head_id: string; amount: number }[]; const G = check(g) as { id: string; classes: string }[];
  type R = { section_id: string; head_id: string; amount: number; stream: string; sections: { name: string; grades: { name: string } | { name: string }[] | null } | { name: string; grades: { name: string } | { name: string }[] | null }[] | null; fee_heads: { name: string } | { name: string }[] | null };
  return { items: (check(r) as unknown as R[]).map((x) => { const sec = one(x.sections); const gn = one(sec?.grades ?? null)?.name ?? ""; const grp = G.find((y) => inGroup(gn, y.classes, gr)); return { section_id: x.section_id, head_id: x.head_id, label: `${gn} ${sec?.name ?? ""}`.trim(), stream: x.stream, head: one(x.fee_heads)?.name ?? "", group_amount: S.find((y) => y.group_id === grp?.id && y.head_id === x.head_id)?.amount ?? 0, amount: x.amount }; }) };
}
export async function saveOverride(inst: string, input: unknown) {
  const i = z.object({ section_id: uid, head_id: uid, amount: z.number().int().min(0).max(10_000_000), stream: z.string().trim().max(60).optional() }).strict().parse(input);
  const [s, h] = await Promise.all([supabaseAdmin.from("sections").select("id").eq("id", i.section_id).eq("institution_id", inst).maybeSingle(), supabaseAdmin.from("fee_heads").select("id").eq("id", i.head_id).eq("institution_id", inst).maybeSingle()]);
  if (!check(s) || !check(h)) throw new HttpError(404, "Section or fee head not found.");
  check(await supabaseAdmin.from("fee_section_overrides").upsert({ section_id: i.section_id, head_id: i.head_id, amount: i.amount, stream: i.stream ?? "" }, { onConflict: "section_id,head_id" }).select("section_id"));
  return { ok: true };
}
export async function removeOverride(inst: string, sectionId: string, headId: string) {
  const s = check(await supabaseAdmin.from("sections").select("id").eq("id", sectionId).eq("institution_id", inst).maybeSingle());
  if (!s) throw new HttpError(404, "Section not found.");
  check(await supabaseAdmin.from("fee_section_overrides").delete().eq("section_id", sectionId).eq("head_id", headId).select("section_id"));
  return { ok: true };
}
export async function optional(inst: string) {
  const [o, p] = await Promise.all([supabaseAdmin.from("fee_optional").select("id, name, kind, amount_year, details, status").eq("institution_id", inst).order("pos"), supabaseAdmin.from("student_fee_plans").select("transport_id, hostel_id").eq("institution_id", inst)]);
  const P = check(p) as { transport_id: string | null; hostel_id: string | null }[];
  return { items: (check(o) as { id: string; name: string; kind: string; amount_year: number; details: string; status: string }[]).map((x) => ({ ...x, opted: P.filter((y) => y.transport_id === x.id || y.hostel_id === x.id).length })) };
}
export async function addOptional(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the fee.").max(80), kind: z.enum(["Transport", "Hostel", "Mess", "Other"]), amount_year: z.number().int().min(0).max(10_000_000), details: z.string().trim().max(160).optional() }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("fee_optional").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[];
  if (dup.length) throw new HttpError(409, "That fee exists.");
  return check(await supabaseAdmin.from("fee_optional").insert({ institution_id: inst, name: i.name, kind: i.kind, amount_year: i.amount_year, details: i.details ?? "" }).select("id").single());
}

/** One click: the standard categories, heads, groups, structure and optional fees. */
export async function defaults(inst: string) {
  const have = check(await supabaseAdmin.from("fee_groups").select("id").eq("institution_id", inst)) as unknown[];
  if (have.length) throw new HttpError(409, "Fees are already set up.");
  const cats = ["Tuition", "Activities and exams", "Transport", "Day scholar mess", "Hostel", "Admission"];
  const cid = new Map((check(await supabaseAdmin.from("fee_categories").insert(cats.map((name) => ({ institution_id: inst, name }))).select("id, name")) as { id: string; name: string }[]).map((c) => [c.name, c.id]));
  const hs: [string, string, string, string][] = [["Tuition fee", "Tuition", "Term-wise", "No"], ["Lab fee", "Tuition", "Term-wise", "Class 6 and above"], ["Computer fee", "Tuition", "Term-wise", "Class 1 and above"], ["Annual activity fee", "Activities and exams", "Term 1 only", "No"], ["Exam fee", "Activities and exams", "Term 1 only", "No"], ["Transport fee", "Transport", "Term-wise", "Yes"], ["School mess", "Day scholar mess", "Term-wise", "Yes"], ["Hostel fee", "Hostel", "Term-wise", "Yes"], ["Hostel mess", "Hostel", "Term-wise", "Yes"], ["Admission fee", "Admission", "Annual", "No"], ["Caution deposit", "Admission", "Annual", "No"]];
  const hid = new Map((check(await supabaseAdmin.from("fee_heads").insert(hs.map(([name, c, frequency, optional_text]) => ({ institution_id: inst, name, category_id: cid.get(c), frequency, optional_text }))).select("id, name")) as { id: string; name: string }[]).map((h) => [h.name, h.id]));
  const gs: [string, string, number[]][] = [["Pre-primary", "Nursery – UKG", [52000, 4000, 0, 6000, 6000]], ["Primary", "Class 1 – 5", [62000, 6000, 3000, 6000, 5000]], ["Middle", "Class 6 – 8", [72000, 8000, 4000, 6000, 6000]], ["Secondary", "Class 9 – 10", [80000, 10000, 6000, 6000, 6000]], ["Senior secondary", "Class 11 – 12", [92000, 14000, 6000, 6000, 6000]]];
  const gid = check(await supabaseAdmin.from("fee_groups").insert(gs.map(([name, classes]) => ({ institution_id: inst, name, classes }))).select("id, name")) as { id: string; name: string }[];
  const order = ["Tuition fee", "Lab fee", "Computer fee", "Annual activity fee", "Exam fee"];
  const rows = gs.flatMap(([name, , a]) => order.map((h, k) => ({ group_id: gid.find((g) => g.name === name)!.id, head_id: hid.get(h)!, amount: a[k] })));
  check(await supabaseAdmin.from("fee_structure").insert(rows).select("head_id"));
  check(await supabaseAdmin.from("fee_optional").insert([{ institution_id: inst, name: "Transport", kind: "Transport", amount_year: 27000, details: "₹9,000 a term" }, { institution_id: inst, name: "School mess (day scholars)", kind: "Mess", amount_year: 21600, details: "₹7,200 a term" }, { institution_id: inst, name: "Hostel", kind: "Hostel", amount_year: 72000, details: "Plus mess ₹6,500 a month" }]).select("id"));
  return { groups: gid.length };
}

// ═════════════ plans ═════════════
const TERM_NAMES = ["Term 1", "Term 2", "Term 3", "Term 4"];
export async function termSplit(inst: string): Promise<number[]> {
  const s = check(await supabaseAdmin.from("fee_settings").select("terms").eq("institution_id", inst).maybeSingle()) as { terms: number[] } | null;
  return s?.terms ?? [40, 35, 25];
}
async function groupOfStudent(inst: string, studentId: string, gradeName: string, planGroup: string | null | undefined) {
  if (planGroup) return planGroup;
  const [g, gr] = await Promise.all([supabaseAdmin.from("fee_groups").select("id, classes").eq("institution_id", inst).eq("status", "Active"), gradeList(inst)]);
  void studentId;
  return (check(g) as { id: string; classes: string }[]).find((x) => inGroup(gradeName, x.classes, gr))?.id ?? null;
}
async function planOf(inst: string, studentId: string) {
  const kid = (await roster(inst)).items.find((r) => r.id === studentId);
  if (!kid) throw new HttpError(404, "Student not found.");
  const p = check(await supabaseAdmin.from("student_fee_plans").select("group_id, transport_id, hostel_id, concession_pct, concession_amount").eq("student_id", studentId).maybeSingle()) as { group_id: string | null; transport_id: string | null; hostel_id: string | null; concession_pct: number; concession_amount: number } | null;
  const group_id = await groupOfStudent(inst, studentId, kid.class_name, p?.group_id);
  return { kid, plan: { group_id, transport_id: p?.transport_id ?? null, hostel_id: p?.hostel_id ?? null, concession_pct: p?.concession_pct ?? 0, concession_amount: p?.concession_amount ?? 0 }, saved: !!p };
}
type Plan = { group_id: string | null; transport_id: string | null; hostel_id: string | null; concession_pct: number; concession_amount: number };
export function moneyPure(st: { head_id: string; amount: number }[], O: Map<string, number>, OP: Map<string, number>, plan: Plan) {
  const gross = st.reduce((n, x) => n + (O.get(x.head_id) ?? x.amount), 0);
  const fees = Math.max(0, Math.round(gross * (1 - plan.concession_pct / 100)) - plan.concession_amount);
  return { gross, fees, transport: plan.transport_id ? OP.get(plan.transport_id) ?? 0 : 0, hostel: plan.hostel_id ? OP.get(plan.hostel_id) ?? 0 : 0 };
}
async function money(inst: string, kid: { section_id: string | null }, plan: Plan) {
  const [st, ov, opt] = await Promise.all([plan.group_id ? supabaseAdmin.from("fee_structure").select("head_id, amount, fee_heads:head_id(optional_text)").eq("group_id", plan.group_id) : Promise.resolve({ data: [], error: null }), kid.section_id ? supabaseAdmin.from("fee_section_overrides").select("head_id, amount").eq("section_id", kid.section_id) : Promise.resolve({ data: [], error: null }), supabaseAdmin.from("fee_optional").select("id, amount_year").eq("institution_id", inst)]);
  return moneyPure(check(st) as unknown as { head_id: string; amount: number }[], new Map((check(ov) as { head_id: string; amount: number }[]).map((x) => [x.head_id, x.amount])), new Map((check(opt) as { id: string; amount_year: number }[]).map((x) => [x.id, x.amount_year])), plan);
}
export async function studentPlan(inst: string, studentId: string) {
  const { kid, plan, saved } = await planOf(inst, studentId);
  const m = await money(inst, kid, plan);
  return { student: { id: kid.id, name: kid.name, class_label: kid.class_label, registration_no: kid.registration_no }, saved, ...plan, annual: m.fees + m.transport + m.hostel, gross: m.gross };
}
export async function savePlan(inst: string, studentId: string, input: unknown) {
  const i = z.object({ group_id: uid.nullable(), transport_id: uid.nullable(), hostel_id: uid.nullable(), concession_pct: z.number().int().min(0).max(100) }).strict().parse(input);
  const cur = await planOf(inst, studentId);
  const ids = [i.group_id, i.transport_id, i.hostel_id].filter((x): x is string => !!x);
  if (i.group_id) { const g = check(await supabaseAdmin.from("fee_groups").select("id").eq("id", i.group_id).eq("institution_id", inst).maybeSingle()); if (!g) throw new HttpError(404, "Fee group not found."); }
  for (const id of [i.transport_id, i.hostel_id].filter((x): x is string => !!x)) { const o = check(await supabaseAdmin.from("fee_optional").select("id").eq("id", id).eq("institution_id", inst).maybeSingle()); if (!o) throw new HttpError(404, "Optional fee not found."); }
  void ids;
  check(await supabaseAdmin.from("student_fee_plans").upsert({ student_id: studentId, institution_id: inst, group_id: i.group_id, transport_id: i.transport_id, hostel_id: i.hostel_id, concession_pct: i.concession_pct, concession_amount: cur.plan.concession_amount, updated_at: new Date().toISOString() }, { onConflict: "student_id" }).select("student_id"));
  return studentPlan(inst, studentId);
}
export async function bulkAssign(inst: string, input: unknown) {
  const i = z.object({ grade_id: uid, section_id: uid.nullable().optional(), group_id: uid, terms: z.array(z.number().int().min(1).max(100)).min(1).max(4).optional(), skip_existing: z.boolean(), siblings: z.boolean() }).strict().parse(input);
  const [g, grp] = await Promise.all([supabaseAdmin.from("grades").select("id").eq("id", i.grade_id).eq("institution_id", inst).maybeSingle(), supabaseAdmin.from("fee_groups").select("id").eq("id", i.group_id).eq("institution_id", inst).maybeSingle()]);
  if (!check(g)) throw new HttpError(404, "Class not found."); if (!check(grp)) throw new HttpError(404, "Fee group not found.");
  if (i.terms && i.terms.reduce((a, b) => a + b, 0) !== 100) throw new HttpError(400, "The term split must add up to 100.");
  if (i.terms) { const cur = await feeSettings(inst); check(await supabaseAdmin.from("fee_settings").upsert({ institution_id: inst, terms: i.terms, due_dates: cur.due_dates.length === i.terms.length ? cur.due_dates : defaultDates(i.terms.length) }, { onConflict: "institution_id" }).select("institution_id")); }
  const kids = (await roster(inst)).items.filter((r) => r.status === "Enrolled" && r.grade_id === i.grade_id && (!i.section_id || r.section_id === i.section_id));
  const have = new Set((kids.length ? (check(await supabaseAdmin.from("student_fee_plans").select("student_id").in("student_id", kids.map((k) => k.id))) as { student_id: string }[]) : []).map((x) => x.student_id));
  const todo = kids.filter((k) => !(i.skip_existing && have.has(k.id)));
  // the younger child of a family gets the sibling discount
  const pct = new Map<string, number>();
  if (i.siblings && todo.length) {
    const links = check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).limit(20000)) as { student_id: string; guardian_id: string }[];
    const dob = new Map((check(await supabaseAdmin.from("students").select("id, date_of_birth").eq("institution_id", inst).limit(20000)) as { id: string; date_of_birth: string | null }[]).map((s) => [s.id, s.date_of_birth ?? ""]));
    for (const k of todo) { const fam = links.filter((l) => l.student_id === k.id).flatMap((l) => links.filter((x) => x.guardian_id === l.guardian_id && x.student_id !== k.id).map((x) => x.student_id)); if (fam.some((s) => (dob.get(s) ?? "") > "" && (dob.get(s) ?? "") < (dob.get(k.id) ?? ""))) pct.set(k.id, 10); }
  }
  if (todo.length) check(await supabaseAdmin.from("student_fee_plans").upsert(todo.map((k) => ({ student_id: k.id, institution_id: inst, group_id: i.group_id, transport_id: null, hostel_id: null, concession_pct: pct.get(k.id) ?? 0, concession_amount: 0, updated_at: new Date().toISOString() })), { onConflict: "student_id" }).select("student_id"));
  return { assigned: todo.length, skipped: kids.length - todo.length, siblings: pct.size };
}

// ═════════════ dues and collection ═════════════
async function paidByKey(studentId: string) {
  const rows = check(await supabaseAdmin.from("fee_payment_lines").select("line_key, amount, fee_payments:payment_id!inner(student_id, status)").eq("fee_payments.student_id", studentId).eq("fee_payments.status", "Paid")) as { line_key: string; amount: number }[];
  const m = new Map<string, number>(); for (const r of rows) m.set(r.line_key, (m.get(r.line_key) ?? 0) + r.amount); return m;
}
export async function dues(inst: string, studentId: string) {
  const { kid, plan } = await planOf(inst, studentId);
  const [m, set, start, paid, hist] = await Promise.all([money(inst, kid, plan), feeSettings(inst), yearStart(inst), paidByKey(studentId), supabaseAdmin.from("fee_payments").select("id, receipt_no, total, paid_on, mode, collected_at, status").eq("student_id", studentId).order("paid_on", { ascending: false }).order("created_at", { ascending: false }).limit(10)]);
  const due = dueIso(set.due_dates, start);
  const b = buildLines(m, set, due, paid, plan.concession_pct > 0 || plan.concession_amount > 0);
  const overdue = b.terms.filter((t) => t.status === "Overdue");
  return { student: { id: kid.id, name: kid.name, class_label: kid.class_label, registration_no: kid.registration_no }, has_plan: !!plan.group_id, lines: b.lines, outstanding: b.lines.reduce((s, l) => s + l.due, 0), overdue: overdue.length > 0, days_overdue: overdue.length ? daysBetween(overdue[0].date, today()) : 0, history: check(hist) as { id: string; receipt_no: string; total: number; paid_on: string; mode: string; collected_at: string; status: string }[] };
}
export async function schedule(inst: string, studentId: string) {
  const { kid, plan } = await planOf(inst, studentId);
  const [m, set, start, paid] = await Promise.all([money(inst, kid, plan), feeSettings(inst), yearStart(inst), paidByKey(studentId)]);
  const b = buildLines(m, set, dueIso(set.due_dates, start), paid, plan.concession_pct > 0 || plan.concession_amount > 0);
  return { student: { id: kid.id, name: kid.name, class_label: kid.class_label, registration_no: kid.registration_no }, has_plan: !!plan.group_id, terms: b.terms.map((t) => ({ ...t, name: TERM_NAMES[t.term - 1] ?? `Term ${t.term}` })), overdue: b.terms.some((t) => t.status === "Overdue") };
}
export async function collect(inst: string, input: unknown, actor?: string) {
  const i = z.object({ student_id: uid, line_keys: z.array(z.string().max(20)).min(1, "Choose at least one fee.").max(40), mode: z.enum(["Cash", "UPI", "Card", "Cheque", "Bank"]), reference: z.string().trim().max(60).optional(), concession: z.number().int().min(0).max(10_000_000), collected_at: z.enum(["Counter", "Online"]), status: z.enum(["Paid", "Pending", "Failed"]).optional() }).strict().parse(input);
  const d = await dues(inst, i.student_id);
  const chosen = i.line_keys.map((k) => d.lines.find((l) => l.key === k));
  if (chosen.some((c) => !c)) throw new HttpError(409, "One of those fees is already paid or not due yet.");
  const lines = chosen as NonNullable<(typeof chosen)[number]>[];
  const sum = lines.reduce((s, l) => s + l.due, 0);
  if (i.concession > sum) throw new HttpError(400, "The concession is more than the amount due.");
  const status = i.collected_at === "Counter" ? "Paid" : i.status ?? "Paid";
  const p = check(await supabaseAdmin.from("fee_payments").insert({ institution_id: inst, student_id: i.student_id, mode: i.mode, reference: i.reference || null, concession: i.concession, total: sum - i.concession, collected_at: i.collected_at, status, paid_on: today(), created_by: actor ?? null }).select("id, receipt_no").single()) as { id: string; receipt_no: string };
  // a concession settles the lines it covers, so each line is recorded in full
  const rows = lines.map((l) => ({ payment_id: p.id, line_key: l.key, label: l.label, amount: l.due }));
  if (rows.length) check(await supabaseAdmin.from("fee_payment_lines").insert(rows).select("line_key"));
  return { receipt_no: p.receipt_no, total: sum - i.concession, status };
}
export async function receipt(inst: string, id: string) {
  const p = check(await supabaseAdmin.from("fee_payments").select("id, receipt_no, student_id, mode, reference, concession, total, paid_on, collected_at, status, cancel_reason").eq("id", id).eq("institution_id", inst).maybeSingle()) as { cancel_reason: string | null; id: string; receipt_no: string; student_id: string; mode: string; reference: string | null; concession: number; total: number; paid_on: string; collected_at: string; status: string } | null;
  if (!p) throw new HttpError(404, "Receipt not found.");
  const [ls, ro, sc] = await Promise.all([supabaseAdmin.from("fee_payment_lines").select("label, amount").eq("payment_id", id), roster(inst), supabaseAdmin.from("institutions").select("name, address").eq("id", inst).maybeSingle()]);
  const k = ro.items.find((r) => r.id === p.student_id);
  return { ...p, school: (sc.data as { name: string } | null)?.name ?? "", address: (sc.data as { address: string | null } | null)?.address ?? "", student: k?.name ?? "", class_label: k?.class_label ?? "", registration_no: k?.registration_no ?? "", lines: check(ls) as { label: string; amount: number }[] };
}
export async function payments(inst: string, collectedAt?: string) {
  let q = supabaseAdmin.from("fee_payments").select("id, receipt_no, student_id, mode, total, paid_on, collected_at, status").eq("institution_id", inst);
  if (collectedAt === "Counter" || collectedAt === "Online") q = q.eq("collected_at", collectedAt);
  const [rows, ro] = await Promise.all([q.order("paid_on", { ascending: false }).order("created_at", { ascending: false }).limit(3000), roster(inst)]);
  const P = check(rows) as { id: string; receipt_no: string; student_id: string; mode: string; total: number; paid_on: string; collected_at: string; status: string }[];
  const ids = P.map((p) => p.id);
  const L = ids.length ? (check(await supabaseAdmin.from("fee_payment_lines").select("payment_id, label").in("payment_id", ids.slice(0, 1000))) as { payment_id: string; label: string }[]) : [];
  const k = new Map(ro.items.map((r) => [r.id, r]));
  return { items: P.map((p) => ({ ...p, student: k.get(p.student_id)?.name ?? "", class_label: k.get(p.student_id)?.class_label ?? "", fee: L.filter((l) => l.payment_id === p.id).map((l) => l.label).join(", ") })) };
}

// ═════════════ concessions ═════════════
export async function concessions(inst: string) {
  const [rows, ro] = await Promise.all([supabaseAdmin.from("fee_concessions").select("id, code, student_id, ctype, reason, amount, requested_on, status, source").eq("institution_id", inst).order("requested_on", { ascending: false }).order("code", { ascending: false }), roster(inst)]);
  const k = new Map(ro.items.map((r) => [r.id, r]));
  return { students: ro.items.filter((r) => r.status === "Enrolled").map((r) => ({ id: r.id, name: r.name, class_label: r.class_label })), items: (check(rows) as { id: string; code: string; student_id: string; ctype: string; reason: string; amount: number; requested_on: string; status: string; source: string }[]).map((x) => ({ ...x, student: k.get(x.student_id)?.name ?? "", class_label: k.get(x.student_id)?.class_label ?? "" })) };
}
export async function addConcession(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, ctype: z.enum(["Scholarship", "Sibling", "Staff ward", "Financial aid", "Discount", "Fee waiver", "Other"]), reason: z.string().trim().max(200).optional(), amount: z.number().int().min(1).max(10_000_000), source: z.enum(["Office", "Parent"]).optional() }).strict().parse(input);
  if (!(await roster(inst)).items.some((r) => r.id === i.student_id)) throw new HttpError(404, "Student not found.");
  return check(await supabaseAdmin.from("fee_concessions").insert({ institution_id: inst, student_id: i.student_id, ctype: i.ctype, reason: i.reason ?? "", amount: i.amount, source: i.source ?? "Office", requested_on: today(), status: i.source === "Parent" ? "Under review" : "Pending" }).select("id, code").single());
}
export async function decideConcession(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Approved", "Rejected", "Info asked"]) }).strict().parse(input);
  const c = check(await supabaseAdmin.from("fee_concessions").select("id, student_id, amount, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; student_id: string; amount: number; status: string } | null;
  if (!c) throw new HttpError(404, "Not found.");
  if (!["Pending", "Under review", "Info asked"].includes(c.status)) throw new HttpError(409, "That was already decided.");
  if (status === "Approved") { const { plan } = await planOf(inst, c.student_id); check(await supabaseAdmin.from("student_fee_plans").upsert({ student_id: c.student_id, institution_id: inst, group_id: plan.group_id, transport_id: plan.transport_id, hostel_id: plan.hostel_id, concession_pct: plan.concession_pct, concession_amount: plan.concession_amount + c.amount, updated_at: new Date().toISOString() }, { onConflict: "student_id" }).select("student_id")); }
  check(await supabaseAdmin.from("fee_concessions").update({ status }).eq("id", id).select("id"));
  return { ok: true };
}
export async function newAdmissions(inst: string) {
  const y = check(await supabaseAdmin.from("academic_years").select("name, start_date").eq("institution_id", inst).eq("is_current", true).maybeSingle()) as { name: string; start_date: string } | null;
  const [rows, ro] = await Promise.all([y ? supabaseAdmin.from("students").select("id, registration_no, admission_date").eq("institution_id", inst).gte("admission_date", y.start_date).limit(2000) : Promise.resolve({ data: [], error: null }), roster(inst)]);
  const k = new Map(ro.items.map((r) => [r.id, r]));
  const S = check(rows) as { id: string; registration_no: string; admission_date: string | null }[];
  const paid = S.length ? (check(await supabaseAdmin.from("fee_payments").select("student_id, total").eq("status", "Paid").in("student_id", S.map((s) => s.id))) as { student_id: string; total: number }[]) : [];
  const out: { student: string; class_label: string; registration_no: string; received: number; status: string }[] = [];
  for (const s of S) { const r = k.get(s.id); if (!r) continue; const d = await dues(inst, s.id).catch(() => null); const got = paid.filter((p) => p.student_id === s.id).reduce((n, p) => n + p.total, 0); out.push({ student: r.name, class_label: r.class_label, registration_no: s.registration_no, received: got, status: d && d.outstanding === 0 && d.has_plan ? "Paid" : got > 0 ? "Part paid" : "Due" }); }
  return { year: y?.name ?? "", items: out };
}
