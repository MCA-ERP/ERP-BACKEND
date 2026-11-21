import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { buildLines, dueIso, feeSettings, gradeList, groups, inGroup, moneyPure, yearStart } from "./fees.service";

/** Fees, part 2: pending fees and reminders, fines, receipts, refunds. */
const uid = z.string().uuid();
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

async function pages<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) { const rows = check(await build(from, from + 999)) as T[]; out.push(...rows); if (rows.length < 1000) break; }
  return out;
}

// ═════════════ pending fees ═════════════
export type PendKind = "outstanding" | "overdue" | "defaulters";
export interface Detail { student_id: string; student: string; class_label: string; father: string; mobile: string; terms: { term: number; name: string; date: string; due: number; amount: number; paid: number }[] }
interface PendRow { student_id: string; student: string; registration_no: string; class_label: string; father: string; mobile: string; due: number; days_overdue: number; last_reminder: string | null }
export async function everyone(inst: string) {
  const [ro, plans, gs, gr, st, ov, opt, paidRows, set, start, link, rem] = await Promise.all([
    roster(inst),
    supabaseAdmin.from("student_fee_plans").select("student_id, group_id, transport_id, hostel_id, concession_pct, concession_amount").eq("institution_id", inst).limit(20000),
    supabaseAdmin.from("fee_groups").select("id, classes").eq("institution_id", inst).eq("status", "Active"),
    gradeList(inst),
    pages<{ group_id: string; head_id: string; amount: number }>((a, b) => supabaseAdmin.from("fee_structure").select("group_id, head_id, amount, fee_groups:group_id!inner(institution_id)").eq("fee_groups.institution_id", inst).range(a, b)),
    pages<{ section_id: string; head_id: string; amount: number }>((a, b) => supabaseAdmin.from("fee_section_overrides").select("section_id, head_id, amount, sections:section_id!inner(institution_id)").eq("sections.institution_id", inst).range(a, b)),
    supabaseAdmin.from("fee_optional").select("id, amount_year").eq("institution_id", inst),
    pages<{ line_key: string; amount: number; fee_payments: { student_id: string } | { student_id: string }[] }>((a, b) => supabaseAdmin.from("fee_payment_lines").select("line_key, amount, fee_payments:payment_id!inner(student_id, status, institution_id)").eq("fee_payments.institution_id", inst).eq("fee_payments.status", "Paid").range(a, b)),
    feeSettings(inst), yearStart(inst),
    pages<{ student_id: string; relation: string; guardians: { full_name: string; phone: string } | { full_name: string; phone: string }[] | null }>((a, b) => supabaseAdmin.from("student_guardians").select("student_id, relation, guardians:guardian_id!inner(institution_id, full_name, phone)").eq("guardians.institution_id", inst).range(a, b)),
    pages<{ student_id: string; sent_on: string }>((a, b) => supabaseAdmin.from("fee_reminders").select("student_id, sent_on").eq("institution_id", inst).range(a, b)),
  ]);
  const P = new Map((check(plans) as { student_id: string; group_id: string | null; transport_id: string | null; hostel_id: string | null; concession_pct: number; concession_amount: number }[]).map((p) => [p.student_id, p]));
  const G = check(gs) as { id: string; classes: string }[];
  const OP = new Map((check(opt) as { id: string; amount_year: number }[]).map((x) => [x.id, x.amount_year]));
  const paid = new Map<string, Map<string, number>>();
  for (const r of paidRows) { const sid = one(r.fee_payments)!.student_id; const m = paid.get(sid) ?? new Map<string, number>(); m.set(r.line_key, (m.get(r.line_key) ?? 0) + r.amount); paid.set(sid, m); }
  const last = new Map<string, string>(); for (const r of rem) if ((last.get(r.student_id) ?? "") < r.sent_on) last.set(r.student_id, r.sent_on);
  const due = dueIso(set.due_dates, start); const now = today();
  const passed = due.filter((d) => d <= now); const cutoff = passed.length ? passed[passed.length - 1] : null;
  const rows: PendRow[] = []; const detail: Detail[] = [];
  const agg = { students: 0, annual: 0, paid: 0, pending: 0, owe_now: 0, overdue: 0, overdue_students: 0, by_class: new Map<string, number>(), buckets: [0, 0, 0, 0, 0] };
  for (const k of ro.items) {
    if (k.status !== "Enrolled") continue;
    const p = P.get(k.id); const gid = p?.group_id ?? G.find((g) => inGroup(k.class_name, g.classes, gr))?.id ?? null;
    if (!gid) continue;
    const plan = { group_id: gid, transport_id: p?.transport_id ?? null, hostel_id: p?.hostel_id ?? null, concession_pct: p?.concession_pct ?? 0, concession_amount: p?.concession_amount ?? 0 };
    const O = new Map(ov.filter((o) => o.section_id === k.section_id).map((o) => [o.head_id, o.amount]));
    const m = moneyPure(st.filter((x) => x.group_id === gid), O, OP, plan);
    const pm = paid.get(k.id) ?? new Map<string, number>();
    const b = buildLines(m, set, due, pm, plan.concession_pct > 0 || plan.concession_amount > 0);
    const annual = m.fees + m.transport + m.hostel;
    let got = 0; for (const [key, v] of pm) if (!key.endsWith(":late")) got += v;
    const pend = Math.max(0, annual - got);
    const open = b.lines.filter((l) => !l.key.endsWith(":late"));
    const oweNow = open.reduce((n, l) => n + l.due, 0);
    agg.students++; agg.annual += annual; agg.paid += Math.min(got, annual); agg.pending += pend; agg.owe_now += oweNow;
    agg.by_class.set(k.class_name, (agg.by_class.get(k.class_name) ?? 0) + pend);
    agg.buckets[0] += Math.max(0, pend - oweNow);
    let over = 0;
    for (const l of open) { const dd = daysBetween(due[l.term - 1], now); if (dd > 0) over += l.due; agg.buckets[dd <= 30 ? 1 : dd <= 60 ? 2 : dd <= 90 ? 3 : 4] += l.due; }
    agg.overdue += over; if (over > 0) agg.overdue_students++;
    const owe = b.lines.reduce((s, l) => s + l.due, 0);
    const kin = link.filter((l) => l.student_id === k.id); const f = kin.find((l) => l.relation === "Father") ?? kin[0]; const g = one(f?.guardians ?? null);
    const father = g ? `${f!.relation === "Father" ? "Mr. " : ""}${g.full_name}` : "";
    detail.push({ student_id: k.id, student: k.name, class_label: k.class_label, father, mobile: g?.phone ?? "", terms: b.terms.map((t) => ({ term: t.term, name: `Term ${t.term}`, date: t.date, due: t.due, amount: t.amount, paid: t.paid })) });
    if (owe <= 0) continue;
    const late = b.terms.filter((t) => t.status === "Overdue");
    rows.push({ student_id: k.id, student: k.name, registration_no: k.registration_no, class_label: k.class_label, father, mobile: g?.phone ?? "", due: owe, days_overdue: late.length ? daysBetween(late[0].date, now) : 0, last_reminder: last.get(k.id) ?? null });
  }
  rows.sort((a, b) => b.days_overdue - a.days_overdue || b.due - a.due || a.student.localeCompare(b.student));
  return { rows, cutoff, detail, agg };
}
export async function pending(inst: string, kind: PendKind) {
  const { rows, cutoff } = await everyone(inst);
  const items = kind === "outstanding" ? rows : kind === "overdue" ? rows.filter((r) => r.days_overdue > 0) : rows.filter((r) => r.days_overdue > 30);
  return { items, cutoff };
}
export async function remind(inst: string, input: unknown, actor?: string) {
  const { student_ids } = z.object({ student_ids: z.array(uid).min(1, "Choose who to remind.").max(1000) }).strict().parse(input);
  const { rows } = await everyone(inst);
  const want = new Set(student_ids); const targets = rows.filter((r) => want.has(r.student_id));
  const g = targets.length ? (check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, relation, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).in("student_id", targets.map((t) => t.student_id))) as { student_id: string; guardian_id: string; relation: string }[]) : [];
  const msgs: Record<string, unknown>[] = []; const logs: Record<string, unknown>[] = [];
  for (const t of targets) {
    const kin = g.filter((x) => x.student_id === t.student_id); const p = kin.find((x) => x.relation === "Father") ?? kin[0]; if (!p) continue;
    msgs.push({ institution_id: inst, kind: "notification", guardian_id: p.guardian_id, student_id: t.student_id, subject: "Fee reminder", body: `A fee of ₹${t.due.toLocaleString("en-IN")} for ${t.student} (${t.class_label}) is pending. Please pay at the earliest.`, created_by: actor ?? null });
    logs.push({ institution_id: inst, student_id: t.student_id, sent_on: today(), amount: t.due, created_by: actor ?? null });
  }
  if (msgs.length) { check(await supabaseAdmin.from("parent_messages").insert(msgs).select("id")); check(await supabaseAdmin.from("fee_reminders").insert(logs).select("id")); }
  return { reminded: msgs.length, skipped: targets.length - msgs.length };
}

// ═════════════ fines ═════════════
const FINE_ROLES: Record<string, string[]> = { Principal: ["Principal", "InstitutionAdmin"], "Vice Principal": ["VicePrincipal", "Principal", "InstitutionAdmin"], "School admin": ["InstitutionAdmin"], Accountant: ["Accountant", "Principal", "InstitutionAdmin"] };
export async function fines(inst: string) {
  const [rows, ro, set] = await Promise.all([supabaseAdmin.from("fee_fines").select("id, code, student_id, reason, days_late, amount, fined_on, status, mode, settled_on").eq("institution_id", inst).order("fined_on", { ascending: false }).order("code", { ascending: false }), roster(inst), feeSettings(inst)]);
  const k = new Map(ro.items.map((r) => [r.id, r]));
  return { students: ro.items.filter((r) => r.status === "Enrolled").map((r) => ({ id: r.id, name: r.name, class_label: r.class_label })), waiver: set.fine_waiver, rules: { lost_id: set.fine_lost_id, lost_book: set.fine_lost_book }, items: (check(rows) as { id: string; code: string; student_id: string; reason: string; days_late: number; amount: number; fined_on: string; status: string; mode: string | null; settled_on: string | null }[]).map((x) => ({ ...x, student: k.get(x.student_id)?.name ?? "", class_label: k.get(x.student_id)?.class_label ?? "" })) };
}
export async function addFine(inst: string, input: unknown, actor?: string) {
  const i = z.object({ student_id: uid, reason: z.string().trim().min(2, "Enter the reason.").max(80), days_late: z.number().int().min(0).max(3650).optional(), amount: z.number().int().min(1).max(1_000_000).optional() }).strict().parse(input);
  if (!(await roster(inst)).items.some((r) => r.id === i.student_id)) throw new HttpError(404, "Student not found.");
  const set = await feeSettings(inst);
  const amount = i.amount ?? (/lost id/i.test(i.reason) ? set.fine_lost_id : /lost library/i.test(i.reason) ? set.fine_lost_book : 0);
  if (!amount) throw new HttpError(400, "Enter the amount.");
  return check(await supabaseAdmin.from("fee_fines").insert({ institution_id: inst, student_id: i.student_id, reason: i.reason, days_late: i.days_late ?? 0, amount, created_by: actor ?? null }).select("id, code").single());
}
export async function settleFine(inst: string, id: string, input: unknown, role: string) {
  const i = z.object({ status: z.enum(["Paid", "Waived"]), mode: z.enum(["Cash", "UPI", "Card", "Cheque", "Bank"]).optional() }).strict().parse(input);
  const f = check(await supabaseAdmin.from("fee_fines").select("id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string } | null;
  if (!f) throw new HttpError(404, "Not found.");
  if (f.status !== "Unpaid") throw new HttpError(409, "That fine is already settled.");
  if (i.status === "Waived") { const set = await feeSettings(inst); if (!(FINE_ROLES[set.fine_waiver] ?? []).includes(role)) throw new HttpError(403, `Only the ${set.fine_waiver} can waive fines.`); }
  check(await supabaseAdmin.from("fee_fines").update({ status: i.status, mode: i.status === "Paid" ? i.mode ?? "Cash" : null, settled_on: today() }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ receipts ═════════════
export async function receipts(inst: string) {
  const [rows, ro] = await Promise.all([supabaseAdmin.from("fee_payments").select("id, receipt_no, student_id, mode, total, paid_on, collected_at, status, cancel_reason, created_by, who:created_by(first_name, last_name)").eq("institution_id", inst).in("status", ["Paid", "Cancelled"]).order("paid_on", { ascending: false }).order("created_at", { ascending: false }).limit(3000), roster(inst)]);
  const k = new Map(ro.items.map((r) => [r.id, r]));
  type R = { id: string; receipt_no: string; student_id: string; mode: string; total: number; paid_on: string; collected_at: string; status: string; cancel_reason: string | null; who: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null };
  return { items: (check(rows) as unknown as R[]).map((x) => { const w = one(x.who); return { id: x.id, receipt_no: x.receipt_no, student: k.get(x.student_id)?.name ?? "", class_label: k.get(x.student_id)?.class_label ?? "", total: x.total, mode: x.mode, paid_on: x.paid_on, issued_by: x.collected_at === "Online" ? "Online" : `Counter${w ? ` · ${w.first_name}` : ""}`, status: x.status === "Paid" ? "Valid" : "Cancelled", cancel_reason: x.cancel_reason }; }) };
}
export async function cancelReceipt(inst: string, id: string, input: unknown) {
  const { reason } = z.object({ reason: z.string().trim().min(3, "Say why it is being cancelled.").max(200) }).strict().parse(input);
  const p = check(await supabaseAdmin.from("fee_payments").select("id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string } | null;
  if (!p) throw new HttpError(404, "Receipt not found.");
  if (p.status !== "Paid") throw new HttpError(409, "Only a valid receipt can be cancelled.");
  check(await supabaseAdmin.from("fee_payments").update({ status: "Cancelled", cancel_reason: reason, cancelled_on: today() }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ refunds ═════════════
export async function refunds(inst: string) {
  const [rows, ro] = await Promise.all([supabaseAdmin.from("fee_refunds").select("id, code, student_id, reason, amount, requested_on, status, decided_on, paid_on").eq("institution_id", inst).order("requested_on", { ascending: false }).order("code", { ascending: false }), roster(inst)]);
  const k = new Map(ro.items.map((r) => [r.id, r]));
  return { students: ro.items.filter((r) => r.status === "Enrolled").map((r) => ({ id: r.id, name: r.name, class_label: r.class_label })), items: (check(rows) as { id: string; code: string; student_id: string; reason: string; amount: number; requested_on: string; status: string; decided_on: string | null; paid_on: string | null }[]).map((x) => ({ ...x, student: k.get(x.student_id)?.name ?? "", class_label: k.get(x.student_id)?.class_label ?? "" })) };
}
export async function addRefund(inst: string, input: unknown, actor?: string) {
  const i = z.object({ student_id: uid, reason: z.string().trim().min(3, "Enter the reason.").max(200), amount: z.number().int().min(1).max(10_000_000) }).strict().parse(input);
  if (!(await roster(inst)).items.some((r) => r.id === i.student_id)) throw new HttpError(404, "Student not found.");
  return check(await supabaseAdmin.from("fee_refunds").insert({ institution_id: inst, ...i, requested_on: today(), created_by: actor ?? null }).select("id, code").single());
}
export async function moveRefund(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Approved", "Rejected", "Paid"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("fee_refunds").select("id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string } | null;
  if (!r) throw new HttpError(404, "Not found.");
  if (status === "Paid" ? r.status !== "Approved" : r.status !== "Pending") throw new HttpError(409, status === "Paid" ? "Approve the refund before paying it." : "That was already decided.");
  check(await supabaseAdmin.from("fee_refunds").update(status === "Paid" ? { status, paid_on: today() } : { status, decided_on: today() }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}

// ═════════════ concession totals (Parent Requests tiles) ═════════════
export async function concessionTotals(inst: string) {
  const [c, g] = await Promise.all([supabaseAdmin.from("fee_concessions").select("amount").eq("institution_id", inst).eq("status", "Approved"), groups(inst)]);
  const given = (check(c) as { amount: number }[]).reduce((n, x) => n + x.amount, 0);
  const billed = g.items.reduce((n, x) => n + x.annual * x.students, 0);
  return { given, billed };
}
