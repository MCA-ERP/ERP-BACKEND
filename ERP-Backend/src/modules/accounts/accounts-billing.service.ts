import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { everyone } from "../school/fees2.service";
import { dueIso, feeSettings, yearStart } from "../school/fees.service";

/** Invoices (one numbered invoice per student and instalment) and the instalment Due List. Dues themselves are worked out live from each student's fee plan. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
type Status = "Paid" | "Overdue" | "Unpaid";
const statusOf = (t: { date: string; amount: number; paid: number; due: number }, now: string): Status => (t.due <= 0 ? "Paid" : t.date < now ? "Overdue" : "Unpaid");

async function termList(inst: string) {
  const [set, ys] = await Promise.all([feeSettings(inst), yearStart(inst)]);
  const due = dueIso(set.due_dates, ys);
  return { set, terms: due.map((d, i) => ({ term: i + 1, name: `Term ${i + 1}`, due_date: d })) };
}
const termNo = (raw: unknown, max: number) => { const n = z.coerce.number().int().min(1).max(max).safeParse(raw); if (!n.success) throw new HttpError(400, "Choose an instalment."); return n.data; };
/** The instalment people are working on: the latest one already due, else the first. */
const current = (terms: { term: number; due_date: string }[], now: string) => (terms.filter((t) => t.due_date <= now).pop() ?? terms[0])?.term ?? 1;

// ═════════════ due list ═════════════
export async function dueList(inst: string, rawTerm: unknown) {
  const now = today();
  const [{ set, terms }, ov] = await Promise.all([termList(inst), everyone(inst)]);
  if (!terms.length) return { terms, term: 1, tiles: { demand: 0, students: 0, collected: 0, paid: 0, outstanding: 0, owing: 0, overdue: 0 }, items: [] };
  const term = rawTerm === undefined || rawTerm === "" ? current(terms, now) : termNo(rawTerm, terms.length);
  const items = ov.detail.flatMap((d) => { const t = d.terms.find((x) => x.term === term); if (!t || t.amount <= 0) return []; const status = statusOf(t, now); const days = Math.max(0, daysBetween(t.date, now) - set.late_grace); const late = status === "Overdue" && set.late_enabled ? Math.min(days * set.late_per_day, set.late_max) : 0; return [{ student_id: d.student_id, student: d.student, class_label: d.class_label, amount: t.amount, paid: t.paid, due: t.due, late_fee: late, due_date: t.date, status }]; });
  const sum = (f: (x: (typeof items)[number]) => number) => items.reduce((n, x) => n + f(x), 0);
  return { terms, term, tiles: { demand: sum((x) => x.amount), students: items.length, collected: sum((x) => Math.min(x.paid, x.amount)), paid: items.filter((x) => x.status === "Paid").length, outstanding: sum((x) => x.due), owing: items.filter((x) => x.due > 0).length, overdue: items.filter((x) => x.status === "Overdue").length }, items };
}

// ═════════════ invoices ═════════════
type Inv = { id: string; number: string; student_id: string; term: number; invoice_date: string; due_date: string; amount: number; sent_at: string | null };

export async function invoices(inst: string, rawTerm: unknown) {
  const now = today();
  const [{ terms }, ov] = await Promise.all([termList(inst), everyone(inst)]);
  if (!terms.length) return { terms, term: 1, tiles: { count: 0, billed: 0, paid_count: 0, paid: 0, unpaid: 0, overdue: 0 }, items: [] };
  const term = rawTerm === undefined || rawTerm === "" ? current(terms, now) : termNo(rawTerm, terms.length);
  const inv = check(await supabaseAdmin.from("fee_invoices").select("id, number, student_id, term, invoice_date, due_date, amount, sent_at").eq("institution_id", inst).eq("term", term).order("number").limit(5000)) as Inv[];
  const D = new Map(ov.detail.map((d) => [d.student_id, d]));
  const items = inv.map((i) => { const d = D.get(i.student_id); const t = d?.terms.find((x) => x.term === term); const paid = Math.min(t?.paid ?? 0, i.amount); const status: Status = t ? statusOf({ date: i.due_date, amount: i.amount, paid: t.paid, due: t.due }, now) : "Unpaid"; return { id: i.id, number: i.number, student: d?.student ?? "", class_label: d?.class_label ?? "", date: i.invoice_date, due_date: i.due_date, amount: i.amount, paid, status, sent: !!i.sent_at, sent_at: i.sent_at }; });
  const paidRows = items.filter((x) => x.status === "Paid");
  return { terms, term, tiles: { count: items.length, billed: items.reduce((n, x) => n + x.amount, 0), paid_count: paidRows.length, paid: paidRows.reduce((n, x) => n + x.amount, 0), unpaid: items.filter((x) => x.status !== "Paid").reduce((n, x) => n + x.amount - x.paid, 0), overdue: items.filter((x) => x.status === "Overdue").length }, items };
}

/** Students whose instalment amount is known but who have no invoice for it yet. */
async function waiting(inst: string, term: number, classLabel?: string) {
  const [ov, have, cons] = await Promise.all([
    everyone(inst),
    supabaseAdmin.from("fee_invoices").select("student_id").eq("institution_id", inst).eq("term", term).limit(20000),
    supabaseAdmin.from("fee_concessions").select("student_id, type_name, ctype").eq("institution_id", inst).eq("status", "Approved").limit(20000),
  ]);
  const H = new Set(((check(have) ?? []) as { student_id: string }[]).map((x) => x.student_id));
  const C = new Map(((check(cons) ?? []) as { student_id: string; type_name: string | null; ctype: string }[]).map((x) => [x.student_id, x.type_name ?? x.ctype]));
  const rows = ov.detail.filter((d) => !H.has(d.student_id) && d.terms.some((t) => t.term === term && t.amount > 0) && (!classLabel || d.class_label.startsWith(classLabel)));
  return { rows: rows.map((d) => { const t = d.terms.find((x) => x.term === term)!; return { student_id: d.student_id, student: d.student, class_label: d.class_label, amount: t.amount, due_date: t.date, concession: C.get(d.student_id) ?? "None" }; }), classes: [...new Set(ov.detail.map((d) => d.class_label.replace(/\s+[A-Z]$/, "")))].sort() };
}

export async function generateView(inst: string, rawTerm: unknown, classLabel: unknown) {
  const { terms } = await termList(inst);
  if (!terms.length) return { terms, term: 1, due_date: null, items: [], classes: [], total: 0, today: today() };
  const term = rawTerm === undefined || rawTerm === "" ? Math.min(terms.length, current(terms, today()) + 1) : termNo(rawTerm, terms.length);
  const w = await waiting(inst, term, typeof classLabel === "string" && classLabel ? classLabel : undefined);
  return { terms, term, due_date: terms[term - 1].due_date, items: w.rows, classes: w.classes, total: w.rows.reduce((n, x) => n + x.amount, 0), today: today() };
}

export async function generate(inst: string, profile: string, input: unknown) {
  const i = z.object({ term: z.number().int().min(1).max(12), class_label: z.string().trim().max(40).optional() }).strict().parse(input);
  const { terms } = await termList(inst);
  if (i.term > terms.length) throw new HttpError(400, "That instalment does not exist.");
  const w = await waiting(inst, i.term, i.class_label || undefined);
  if (!w.rows.length) throw new HttpError(409, "Every student already has an invoice for this instalment.");
  const yy = today().slice(2, 4);
  const { count } = await supabaseAdmin.from("fee_invoices").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("term", i.term);
  let n = count ?? 0;
  const now = new Date().toISOString();
  const rows = w.rows.map((r) => ({ institution_id: inst, number: `INV-${yy}T${i.term}-${String(++n).padStart(4, "0")}`, student_id: r.student_id, term: i.term, invoice_date: today(), due_date: r.due_date, amount: r.amount, sent_at: now, created_by: profile }));
  const made = check(await supabaseAdmin.from("fee_invoices").insert(rows).select("id, number, student_id, amount, due_date")) as { id: string; number: string; student_id: string; amount: number; due_date: string }[];
  // parents see it in the Parent portal: one notice to the first guardian of each student
  const g = check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, guardians:guardian_id!inner(institution_id)").in("student_id", made.map((m) => m.student_id)).eq("guardians.institution_id", inst).limit(20000)) as unknown as { student_id: string; guardian_id: string }[];
  const first = new Map<string, string>(); for (const x of g) if (!first.has(x.student_id)) first.set(x.student_id, x.guardian_id);
  const msgs = made.filter((m) => first.has(m.student_id)).map((m) => ({ institution_id: inst, kind: "notification", guardian_id: first.get(m.student_id), student_id: m.student_id, subject: `Fee invoice ${m.number}`, body: `Term ${i.term} invoice of ₹${m.amount.toLocaleString("en-IN")}, due ${new Date(m.due_date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}. Pay it in the Parent portal.`, created_by: profile }));
  if (msgs.length) check(await supabaseAdmin.from("parent_messages").insert(msgs).select("id"));
  return { generated: made.length, notified: msgs.length, total: made.reduce((s, m) => s + m.amount, 0) };
}
