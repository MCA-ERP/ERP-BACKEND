import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "../school/student-mgmt.service";
import { collect, dues, schedule, feeSettings } from "../school/fees.service";

/** The accountant's concession pages (types, register, requests) and the Parent Payment test-mode gateway. Decisions on requests stay with the Principal and School Admin. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

// ═════════════ concession types ═════════════
const DEFAULT_TYPES: [string, "Percentage" | "Fixed", number, string, string][] = [["Sibling 10%", "Percentage", 10, "Second child onwards", "Automatic"], ["Merit 25%", "Percentage", 25, "Top 3 in class last year", "Principal"], ["Staff ward 50%", "Percentage", 50, "Children of school staff", "Principal"], ["RTE / EWS 100%", "Percentage", 100, "RTE quota seats", "Principal"], ["Single parent ₹2,000", "Fixed", 2000, "Per term, on tuition", "Principal"]];
type TypeRow = { id: string; name: string; kind: string; value: number; for_whom: string; approved_by: string };

export async function concessionTypes(inst: string) {
  const load = async () => check(await supabaseAdmin.from("fee_concession_types").select("id, name, kind, value, for_whom, approved_by").eq("institution_id", inst).order("created_at")) as TypeRow[];
  let t = await load();
  if (!t.length) {
    check(await supabaseAdmin.from("fee_concession_types").upsert(DEFAULT_TYPES.map(([name, kind, value, for_whom, approved_by]) => ({ institution_id: inst, name, kind, value, for_whom, approved_by })), { onConflict: "institution_id,name", ignoreDuplicates: true }).select("id"));
    t = await load();
  }
  const c = check(await supabaseAdmin.from("fee_concessions").select("type_name, ctype, status").eq("institution_id", inst).eq("status", "Approved").limit(20000)) as { type_name: string | null; ctype: string }[];
  return { items: t.map((x) => ({ ...x, value_text: x.kind === "Percentage" ? `${x.value}% of tuition` : `₹${x.value.toLocaleString("en-IN")} a term`, students: c.filter((y) => (y.type_name ?? y.ctype) === x.name).length })) };
}

export async function addConcessionType(inst: string, profile: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter a name.").max(60), kind: z.enum(["Percentage", "Fixed"]), value: z.number().int().min(1, "Enter the value."), for_whom: z.string().trim().max(120).optional(), approved_by: z.enum(["Automatic", "Accountant", "Principal", "School admin"]) }).strict().parse(input);
  if (i.kind === "Percentage" && i.value > 100) throw new HttpError(400, "A percentage cannot be more than 100.");
  await concessionTypes(inst);
  const dup = check(await supabaseAdmin.from("fee_concession_types").select("id").eq("institution_id", inst).ilike("name", i.name).limit(1)) as unknown[];
  if (dup.length) throw new HttpError(409, "There is already a concession type with that name.");
  return check(await supabaseAdmin.from("fee_concession_types").insert({ institution_id: inst, name: i.name, kind: i.kind, value: i.value, for_whom: i.for_whom ?? "", approved_by: i.approved_by, created_by: profile }).select("id").single());
}

// ═════════════ register and requests (read only here) ═════════════
type Row = { id: string; code: string; student_id: string; ctype: string; type_name: string | null; reason: string; amount: number; requested_on: string; status: string; source: string };
async function rows(inst: string) {
  const [r, ro, set] = await Promise.all([
    supabaseAdmin.from("fee_concessions").select("id, code, student_id, ctype, type_name, reason, amount, requested_on, status, source").eq("institution_id", inst).order("requested_on", { ascending: false }).limit(5000),
    roster(inst), feeSettings(inst),
  ]);
  return { items: check(r) as Row[], k: new Map(ro.items.map((x) => [x.id, x])), terms: Math.max(1, set.terms.length) };
}

export async function concessionRegister(inst: string) {
  const { items, k, terms } = await rows(inst);
  const by = new Map<string, { student: string; class_label: string; registration_no: string; concession: string; year: number }>();
  for (const x of items.filter((y) => y.status === "Approved")) {
    const s = k.get(x.student_id); const cur = by.get(x.student_id); const name = x.type_name ?? x.ctype;
    by.set(x.student_id, { student: s?.name ?? "", class_label: s?.class_label ?? "", registration_no: s?.registration_no ?? "", concession: cur ? `${cur.concession}, ${name}` : name, year: (cur?.year ?? 0) + x.amount });
  }
  const list = [...by.values()].map((x) => ({ ...x, per_term: Math.round(x.year / terms) }));
  return { items: list, students: list.length, given: list.reduce((n, x) => n + x.year, 0), terms };
}

export async function concessionRequests(inst: string, parentOnly: boolean) {
  const { items, k, terms } = await rows(inst);
  return { terms, items: items.filter((x) => !parentOnly || x.source === "Parent").map((x) => { const s = k.get(x.student_id); return { id: x.id, code: x.code, student: s?.name ?? "", class_label: s?.class_label ?? "", registration_no: s?.registration_no ?? "", concession: x.type_name ?? x.ctype, reason: x.reason, from: x.source === "Parent" ? "Parent" : "Office", on: x.requested_on, per_term: Math.round(x.amount / terms), status: x.status }; }) };
}

// ═════════════ parent payment (test-mode gateway) ═════════════
const METHODS: Record<string, { mode: "UPI" | "Card" | "Bank"; sub: string }> = { PhonePe: { mode: "UPI", sub: "UPI app" }, "Google Pay": { mode: "UPI", sub: "UPI app" }, "Other UPI ID": { mode: "UPI", sub: "Any UPI app" }, Card: { mode: "Card", sub: "Debit or credit" }, "Net banking": { mode: "Bank", sub: "All banks" } };

export async function payStudents(inst: string) {
  const ro = await roster(inst);
  return { items: ro.items.filter((s) => s.status === "Enrolled").slice(0, 500).map((s) => ({ id: s.id, name: s.name, class_label: s.class_label })) };
}

export async function payView(inst: string, studentId: string) {
  const [s, d, g] = await Promise.all([
    schedule(inst, studentId), dues(inst, studentId),
    supabaseAdmin.from("student_guardians").select("relation, guardians:guardian_id!inner(institution_id, full_name)").eq("student_id", studentId).eq("guardians.institution_id", inst).limit(5),
  ]);
  const gs = (check(g) ?? []) as unknown as { relation: string; guardians: { full_name: string } | { full_name: string }[] | null }[];
  const f = gs.find((x) => x.relation === "Father") ?? gs[0]; const name = one(f?.guardians ?? null)?.full_name;
  const first = d.lines[0]?.term ?? null;
  const pay = first ? d.lines.filter((l) => l.term === first) : [];
  return {
    student: s.student, parent: name ? `${f!.relation === "Father" ? "Mr. " : ""}${name}` : "", has_plan: s.has_plan,
    terms: s.terms.map((t) => ({ term: t.term, name: t.name, date: t.date, amount: t.due, late: d.lines.filter((l) => l.term === t.term && l.key.endsWith(":late")).reduce((n, l) => n + l.due, 0), status: t.status === "Scheduled" ? "Upcoming" : t.status })),
    paying: first ? { term: first, name: s.terms.find((t) => t.term === first)?.name ?? `Term ${first}`, amount: pay.reduce((n, l) => n + l.due, 0), line_keys: pay.map((l) => l.key) } : null,
    methods: Object.entries(METHODS).map(([n, m]) => ({ name: n, sub: m.sub })),
  };
}

export async function payStart(inst: string, profile: string, input: unknown) {
  const i = z.object({ student_id: z.string().uuid(), method: z.enum(["PhonePe", "Google Pay", "Other UPI ID", "Card", "Net banking"]) }).strict().parse(input);
  const v = await payView(inst, i.student_id);
  if (!v.paying) throw new HttpError(409, "Nothing is due for this student right now.");
  const txn = `pay_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const r = await collect(inst, { student_id: i.student_id, line_keys: v.paying.line_keys, mode: METHODS[i.method].mode, reference: `${i.method} · ${txn}`.slice(0, 60), concession: 0, collected_at: "Online", status: "Pending" }, profile);
  const p = check(await supabaseAdmin.from("fee_payments").select("id").eq("institution_id", inst).eq("receipt_no", r.receipt_no).maybeSingle()) as { id: string } | null;
  if (!p) throw new HttpError(500, "The payment could not be started.");
  const school = check(await supabaseAdmin.from("institutions").select("name").eq("id", inst).maybeSingle()) as { name: string } | null;
  return { id: p.id, txn, merchant: school?.name ?? "", for_text: `${v.student.name} · ${v.paying.name}`, amount: r.total, method: i.method };
}

export async function payFinish(inst: string, profile: string, id: string, ok: boolean) {
  const r = check(await supabaseAdmin.from("fee_payments").update(ok ? { status: "Paid", paid_on: today() } : { status: "Failed" }).eq("id", id).eq("institution_id", inst).eq("created_by", profile).eq("status", "Pending").eq("collected_at", "Online").select("id, receipt_no, total")) as { id: string; receipt_no: string; total: number }[];
  if (!r.length) throw new HttpError(404, "That payment is not waiting for the gateway.");
  return { status: ok ? "Paid" : "Failed", receipt_no: r[0].receipt_no, total: r[0].total };
}
