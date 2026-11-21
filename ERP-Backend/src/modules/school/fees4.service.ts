import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { everyone } from "./fees2.service";
import { feeSettings, yearStart } from "./fees.service";
import { entries, fill, reminderConfig } from "./fees3.service";

/** Fees, part 4: automatic reminders (queue, log, results), reconciliation, budgets and forecasts, staff claims and advances. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-03.");
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
async function pages<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) { const rows = check(await build(from, from + 999)) as T[]; out.push(...rows); if (rows.length < 1000) break; }
  return out;
}
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// ═════════════ automatic reminders: queue, log, results ═════════════
const short = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
export async function reminderQueue(inst: string) {
  const now = today();
  const [cfg, ov, set, open, acts] = await Promise.all([reminderConfig(inst), everyone(inst), feeSettings(inst), supabaseAdmin.from("fee_concessions").select("student_id").eq("institution_id", inst).in("status", ["Pending", "Under review", "Info asked"]), supabaseAdmin.from("fee_reminder_actions").select("student_id, term, step_key, status").eq("institution_id", inst).eq("on_date", now)]);
  const skipC = cfg.rules.find((r) => r.key === "skip_concession")?.on ? new Set((check(open) as { student_id: string }[]).map((x) => x.student_id)) : new Set<string>();
  const A = check(acts) as { student_id: string; term: number; step_key: string; status: string }[];
  const items: { key: string; student_id: string; term: number; step_key: string; student: string; class_label: string; father: string; fee: string; amount: number; step: string; offset: number; channel: string; app: boolean; status: "Scheduled" | "Held back" | "Sent"; message: string }[] = [];
  let paid = 0, concession = 0;
  for (const d of ov.detail) for (const s of cfg.steps) {
    if (!s.on) continue;
    const t = d.terms.find((x) => daysBetween(x.date, now) === s.offset); if (!t) continue;
    if (t.due <= 0) { paid++; continue; }
    if (skipC.has(d.student_id)) { concession++; continue; }
    const a = A.find((x) => x.student_id === d.student_id && x.term === t.term && x.step_key === s.key);
    const late = addDays(t.date, set.late_grace);
    items.push({ key: `${d.student_id}:${t.term}:${s.key}`, student_id: d.student_id, term: t.term, step_key: s.key, student: d.student, class_label: d.class_label, father: d.father, fee: `Instalment ${t.term}`, amount: t.due, step: s.title, offset: s.offset, channel: s.channel, app: s.channel.startsWith("Parent app"), status: a?.status === "Sent" ? "Sent" : a ? "Held back" : "Scheduled", message: fill(s.text, { parent: d.father || "Parent", child: d.student.split(" ")[0], instalment: `Instalment ${t.term}`, amount: inr(t.due), due: short(t.date), latefrom: short(late) }) });
  }
  const live = items.filter((x) => x.status !== "Sent");
  return { items, going_out: live.filter((x) => x.status === "Scheduled").length, overdue_steps: items.filter((x) => x.offset > 0).length, skipped: paid + concession, skipped_paid: paid, skipped_concession: concession, calls: items.filter((x) => x.channel.startsWith("Call list")).length };
}
export async function holdReminder(inst: string, input: unknown) {
  const i = z.object({ student_id: uid, term: z.number().int().min(1).max(4), step_key: z.string().max(10), hold: z.boolean() }).strict().parse(input);
  const q = (await reminderQueue(inst)).items.find((x) => x.student_id === i.student_id && x.term === i.term && x.step_key === i.step_key);
  if (!q) throw new HttpError(404, "That reminder is not in today's queue.");
  if (q.status === "Sent") throw new HttpError(409, "That reminder was already sent.");
  if (i.hold) check(await supabaseAdmin.from("fee_reminder_actions").upsert({ institution_id: inst, student_id: i.student_id, term: i.term, step_key: i.step_key, on_date: today(), status: "Held", channel: q.channel, amount: q.amount }, { onConflict: "institution_id,student_id,term,step_key,on_date" }).select("student_id"));
  else check(await supabaseAdmin.from("fee_reminder_actions").delete().eq("institution_id", inst).eq("student_id", i.student_id).eq("term", i.term).eq("step_key", i.step_key).eq("on_date", today()).select("student_id"));
  return { ok: true };
}
export async function sendReminders(inst: string, input: unknown, actor?: string) {
  const { keys } = z.object({ keys: z.array(z.string().max(80)).max(5000).optional() }).strict().parse(input ?? {});
  const now = today(); const q = (await reminderQueue(inst)).items;
  const todo = q.filter((x) => (keys ? keys.includes(x.key) : x.status === "Scheduled") && x.status !== "Sent");
  const app = todo.filter((x) => x.app);
  const g = app.length ? (check(await supabaseAdmin.from("student_guardians").select("student_id, guardian_id, relation, guardians:guardian_id!inner(institution_id)").eq("guardians.institution_id", inst).in("student_id", app.map((t) => t.student_id))) as { student_id: string; guardian_id: string; relation: string }[]) : [];
  const msgs: Record<string, unknown>[] = []; const logs: Record<string, unknown>[] = []; const acts: Record<string, unknown>[] = [];
  for (const t of app) { const kin = g.filter((x) => x.student_id === t.student_id); const p = kin.find((x) => x.relation === "Father") ?? kin[0]; if (!p) continue;
    msgs.push({ institution_id: inst, kind: "notification", guardian_id: p.guardian_id, student_id: t.student_id, subject: "Fee reminder", body: t.message, created_by: actor ?? null });
    logs.push({ institution_id: inst, student_id: t.student_id, sent_on: now, amount: t.amount, created_by: actor ?? null });
    acts.push({ institution_id: inst, student_id: t.student_id, term: t.term, step_key: t.step_key, on_date: now, status: "Sent", channel: t.channel, amount: t.amount }); }
  if (msgs.length) { check(await supabaseAdmin.from("parent_messages").insert(msgs).select("id")); check(await supabaseAdmin.from("fee_reminders").insert(logs).select("id")); check(await supabaseAdmin.from("fee_reminder_actions").upsert(acts, { onConflict: "institution_id,student_id,term,step_key,on_date" }).select("student_id")); }
  return { sent: msgs.length, not_connected: todo.length - app.length, no_parent: app.length - msgs.length };
}
interface Sent { student_id: string; term: number; step_key: string; on_date: string; channel: string; amount: number; paid3: boolean; got: number }
async function sentActions(inst: string, since: string): Promise<Sent[]> {
  const [a, lines] = await Promise.all([pages<{ student_id: string; term: number; step_key: string; on_date: string; channel: string; amount: number }>((x, y) => supabaseAdmin.from("fee_reminder_actions").select("student_id, term, step_key, on_date, channel, amount").eq("institution_id", inst).eq("status", "Sent").gte("on_date", since).range(x, y)), pages<{ line_key: string; amount: number; fee_payments: { student_id: string; paid_on: string } | { student_id: string; paid_on: string }[] }>((x, y) => supabaseAdmin.from("fee_payment_lines").select("line_key, amount, fee_payments:payment_id!inner(student_id, paid_on, status, institution_id)").eq("fee_payments.institution_id", inst).eq("fee_payments.status", "Paid").gte("fee_payments.paid_on", since).range(x, y))]);
  return a.map((r) => { const hit = lines.filter((l) => { const p = one(l.fee_payments)!; return p.student_id === r.student_id && l.line_key.startsWith(`T${r.term}:`) && !l.line_key.endsWith(":late") && p.paid_on >= r.on_date && p.paid_on <= addDays(r.on_date, 3); }); return { ...r, paid3: hit.length > 0, got: hit.reduce((n, l) => n + l.amount, 0) }; });
}
export async function reminderLog(inst: string) {
  const cfg = await reminderConfig(inst); const title = new Map(cfg.steps.map((s) => [s.key, s.title]));
  const since = addDays(today(), -120);
  const [rows, msgs] = await Promise.all([sentActions(inst, since), pages<{ student_id: string; sent_on: string; status: string }>((x, y) => supabaseAdmin.from("parent_messages").select("student_id, sent_on, status").eq("institution_id", inst).eq("subject", "Fee reminder").gte("sent_on", since).range(x, y))]);
  const groups = new Map<string, Sent[]>(); for (const r of rows) { const k = `${r.on_date}|${r.step_key}|${r.term}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  return { items: [...groups.entries()].map(([k, rs]) => { const [d, step, term] = k.split("|"); const read = msgs.filter((m) => m.sent_on === d && m.status === "Read" && rs.some((r) => r.student_id === m.student_id)).length; return { id: k, sent_on: d, step: `Instalment ${term} · ${title.get(step) ?? step}`, channel: rs[0].channel, sent_to: rs.length, delivered: rs.length, read, paid3: rs.filter((r) => r.paid3).length }; }).sort((a, b) => (a.id < b.id ? 1 : -1)) };
}
export async function reminderResults(inst: string) {
  const cfg = await reminderConfig(inst); const rows = await sentActions(inst, addDays(today(), -30));
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const by = (f: (r: Sent) => string) => { const m = new Map<string, Sent[]>(); for (const r of rows) m.set(f(r), [...(m.get(f(r)) ?? []), r]); return [...m.entries()].map(([k, v]) => [k, pct(v.filter((x) => x.paid3).length, v.length)] as [string, number]).sort((a, b) => b[1] - a[1]); };
  const title = new Map(cfg.steps.map((s) => [s.key, s.title]));
  const fam = new Set(rows.map((r) => r.student_id)); const paid = new Set(rows.filter((r) => r.paid3).map((r) => r.student_id));
  return { sent: rows.length, families: fam.size, paid3: paid.size, paid3_pct: pct(paid.size, fam.size), collected: rows.reduce((n, r) => n + r.got, 0), by_step: by((r) => title.get(r.step_key) ?? r.step_key), by_channel: by((r) => r.channel) };
}

// ═════════════ reconciliation ═════════════
const RULES: [string, string, string, string, string][] = [["utr", "UTR / reference in receipt", "A bank reference that matches a receipt's UTR or transaction ID", "Exact", "UTR in receipt"], ["payout", "Gateway payout ID", "Settlement ID in the narration, matched to the payout and its payments", "Exact", "Payout ID"], ["cheque", "Cheque number", "Cheque number in the narration, matched to a cheque receipt", "Exact", "Cheque number"], ["cash", "Cash deposit slip", "Deposit amount matched to the day book cash for the days before it", "Exact", "Cash deposit slip"], ["name", "Amount, date and name", "Same amount within 2 days of a receipt", "Suggest only", "Amount and date"], ["keyword", "Narration keyword", "BANK CHGS → bank charges; INT CR → interest income; GST → input GST", "Exact", "Narration keyword"], ["payee", "Amount and payee", "Payment matched to an approved expense for the same payee and amount", "Exact", "Amount and payee"]];
export async function reconRules(inst: string) {
  const r = check(await supabaseAdmin.from("recon_rules").select("rule_key, enabled").eq("institution_id", inst)) as { rule_key: string; enabled: boolean }[];
  return { items: RULES.map(([key, rule, how, posts], i) => ({ key, order: i + 1, rule, how, posts, on: r.find((x) => x.rule_key === key)?.enabled ?? true })) };
}
async function audit(inst: string, who: string, action: string, item: string, details: string, journal?: string) {
  check(await supabaseAdmin.from("recon_audit").insert({ institution_id: inst, who: who || "System", action, item: item.slice(0, 200), details: details.slice(0, 300), journal: journal ?? null }).select("id"));
}
async function nextJournal(inst: string) {
  const [a, b] = await Promise.all([supabaseAdmin.from("bank_statement_lines").select("id", { count: "exact", head: true }).eq("institution_id", inst).not("journal", "is", null), supabaseAdmin.from("recon_audit").select("id", { count: "exact", head: true }).eq("institution_id", inst).not("journal", "is", null)]);
  return `JV-${today().slice(2, 4)}-${3141 + (a.count ?? 0) + (b.count ?? 0)}`;
}
export async function saveReconRule(inst: string, input: unknown, who: string) {
  const i = z.object({ key: z.enum(["utr", "payout", "cheque", "cash", "name", "keyword", "payee"]), on: z.boolean() }).strict().parse(input);
  check(await supabaseAdmin.from("recon_rules").upsert({ institution_id: inst, rule_key: i.key, enabled: i.on }, { onConflict: "institution_id,rule_key" }).select("rule_key"));
  await audit(inst, who, "Rule changed", RULES.find((r) => r[0] === i.key)![1], i.on ? "Turned on" : "Turned off");
  return reconRules(inst);
}
export async function settlements(inst: string) {
  const [s, un] = await Promise.all([supabaseAdmin.from("fee_settlements").select("id, ref, payments_on, payments, gross, fee_gst, bank_amount, bank_credit_on, bank_ref, status").eq("institution_id", inst).order("payments_on", { ascending: false }).limit(500), supabaseAdmin.from("fee_payments").select("total").eq("institution_id", inst).eq("status", "Paid").eq("collected_at", "Online").is("settlement_id", null)]);
  const items = (check(s) as { id: string; ref: string; payments_on: string; payments: number; gross: number; fee_gst: number; bank_amount: number | null; bank_credit_on: string | null; bank_ref: string | null; status: string }[]).map((x) => ({ ...x, net: x.gross - x.fee_gst }));
  const week = items.filter((x) => x.payments_on >= addDays(today(), -7)); const U = check(un) as { total: number }[];
  return { items, week_total: week.length, week_matched: week.filter((x) => x.status === "Matched").length, fees: items.reduce((n, x) => n + x.fee_gst, 0), unsettled: U.length, unsettled_amount: U.reduce((n, x) => n + x.total, 0) };
}
export async function recordSettlement(inst: string, input: unknown, who: string) {
  const i = z.object({ ref: z.string().trim().min(3, "Enter the settlement ID.").max(40), payments_on: date, fee_gst: z.number().int().min(0).max(10_000_000) }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("fee_settlements").select("id").eq("institution_id", inst).eq("ref", i.ref)) as unknown[];
  if (dup.length) throw new HttpError(409, "That settlement is already recorded.");
  const p = check(await supabaseAdmin.from("fee_payments").select("id, total").eq("institution_id", inst).eq("status", "Paid").eq("collected_at", "Online").eq("paid_on", i.payments_on).is("settlement_id", null)) as { id: string; total: number }[];
  if (!p.length) throw new HttpError(404, "There are no unsettled online payments on that date.");
  const gross = p.reduce((n, x) => n + x.total, 0);
  if (i.fee_gst > gross) throw new HttpError(400, "The fee and GST are more than the payments.");
  const s = check(await supabaseAdmin.from("fee_settlements").insert({ institution_id: inst, ref: i.ref, payments_on: i.payments_on, payments: p.length, gross, fee_gst: i.fee_gst }).select("id").single()) as { id: string };
  check(await supabaseAdmin.from("fee_payments").update({ settlement_id: s.id }).in("id", p.map((x) => x.id)).select("id"));
  await audit(inst, who, "Settlement recorded", i.ref, `${p.length} payments, gross ${inr(gross)}, fee and GST ${inr(i.fee_gst)}`);
  return { id: s.id, payments: p.length, gross };
}
export async function bankCredit(inst: string, id: string, input: unknown, who: string) {
  const i = z.object({ bank_amount: z.number().int().min(0).max(1_000_000_000), bank_credit_on: date, bank_ref: z.string().trim().max(60).optional() }).strict().parse(input);
  const s = check(await supabaseAdmin.from("fee_settlements").select("id, ref, gross, fee_gst").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; ref: string; gross: number; fee_gst: number } | null;
  if (!s) throw new HttpError(404, "Settlement not found.");
  const status = i.bank_amount === s.gross - s.fee_gst ? "Matched" : "Difference";
  check(await supabaseAdmin.from("fee_settlements").update({ bank_amount: i.bank_amount, bank_credit_on: i.bank_credit_on, bank_ref: i.bank_ref ?? null, status }).eq("id", id).eq("institution_id", inst).select("id"));
  await audit(inst, who, status === "Matched" ? "Auto-matched" : "Difference found", s.ref, `Bank credit ${inr(i.bank_amount)} against net ${inr(s.gross - s.fee_gst)}`);
  return { status };
}
export async function paymentMatching(inst: string) {
  const [rows, ro] = await Promise.all([supabaseAdmin.from("fee_payments").select("id, receipt_no, student_id, mode, total, paid_on, created_at, status, reference, st:settlement_id(ref, status)").eq("institution_id", inst).eq("collected_at", "Online").order("created_at", { ascending: false }).limit(1000), roster(inst)]);
  const K = new Map(ro.items.map((r) => [r.id, r]));
  type R = { id: string; receipt_no: string; student_id: string; mode: string; total: number; paid_on: string; created_at: string; status: string; reference: string | null; st: { ref: string; status: string } | { ref: string; status: string }[] | null };
  return { items: (check(rows) as unknown as R[]).map((x) => { const st = one(x.st); return { id: x.id, payment: x.reference || x.id.slice(0, 8), student: K.get(x.student_id)?.name ?? "", class_label: K.get(x.student_id)?.class_label ?? "", amount: x.total, mode: x.mode, at: x.created_at, receipt: x.status === "Paid" ? x.receipt_no : "Missing", payout: st?.ref ?? "Not settled", status: x.status !== "Paid" ? (x.status === "Failed" ? "Failed" : "No receipt") : !st ? "Not settled yet" : st.status === "Matched" ? "Matched" : st.status === "Difference" ? "Difference" : "Awaiting bank" }; }) };
}
export async function reconLive(inst: string) {
  const now = today();
  const [pays, ro, ex, st, un, s] = await Promise.all([supabaseAdmin.from("fee_payments").select("id, receipt_no, student_id, mode, total, created_at, status, collected_at").eq("institution_id", inst).eq("paid_on", now).order("created_at", { ascending: false }), roster(inst), supabaseAdmin.from("recon_exceptions").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("status", "Open"), supabaseAdmin.from("bank_statement_lines").select("money_in, money_out").eq("institution_id", inst).eq("status", "No match"), supabaseAdmin.from("recon_audit").select("at").eq("institution_id", inst).order("at", { ascending: false }).limit(1), settlements(inst)]);
  const K = new Map(ro.items.map((r) => [r.id, r])); const P = check(pays) as { id: string; receipt_no: string; student_id: string; mode: string; total: number; created_at: string; status: string; collected_at: string }[];
  const paid = P.filter((p) => p.status === "Paid");
  return { today_count: paid.length, today_amount: paid.reduce((n, p) => n + p.total, 0), week_matched: s.week_matched, week_total: s.week_total, exceptions: ex.count ?? 0, unmatched: (check(st) as { money_in: number; money_out: number }[]).reduce((n, l) => n + l.money_in + l.money_out, 0), last: (check(un) as { at: string }[])[0]?.at ?? null, incoming: P.filter((p) => p.collected_at === "Online").slice(0, 10).map((p) => ({ at: p.created_at, student: K.get(p.student_id)?.name ?? "", class_label: K.get(p.student_id)?.class_label ?? "", mode: p.mode, amount: p.total, receipt: p.status === "Paid" ? p.receipt_no : "Missing" })) };
}
export async function exceptions(inst: string) {
  const [pays, ro, sets, lines, have] = await Promise.all([supabaseAdmin.from("fee_payments").select("id, student_id, total, mode, paid_on, status, collected_at").eq("institution_id", inst).limit(5000), roster(inst), supabaseAdmin.from("fee_settlements").select("id, ref, gross, fee_gst, bank_amount, status").eq("institution_id", inst).eq("status", "Difference"), supabaseAdmin.from("bank_statement_lines").select("id, line_on, narration, money_in").eq("institution_id", inst).eq("status", "No match").gt("money_in", 0), supabaseAdmin.from("recon_exceptions").select("ref_key").eq("institution_id", inst)]);
  const K = new Map(ro.items.map((r) => [r.id, r])); const keys = new Set((check(have) as { ref_key: string }[]).map((x) => x.ref_key));
  const P = check(pays) as { id: string; student_id: string; total: number; mode: string; paid_on: string; status: string; collected_at: string }[];
  const add: Record<string, unknown>[] = []; const nm = (id: string) => `${K.get(id)?.name ?? "A student"} (${K.get(id)?.class_label ?? ""})`;
  const seen = new Map<string, number>(); for (const p of P.filter((x) => x.status === "Paid")) { const k = `twice:${p.student_id}:${p.total}:${p.paid_on}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  for (const [k, n] of seen) if (n > 1 && !keys.has(k)) { const [, sid, amt, d] = k.split(":"); add.push({ institution_id: inst, ref_key: k, kind: "Paid twice", detail: `${nm(sid)} paid ${inr(Number(amt))} ${n} times on ${d}.`, amount: Number(amt), student_id: sid }); }
  for (const p of P.filter((x) => x.collected_at === "Online" && x.status === "Pending")) { const k = `norcpt:${p.id}`; if (!keys.has(k)) add.push({ institution_id: inst, ref_key: k, kind: "Paid but no receipt", detail: `${nm(p.student_id)} paid ${inr(p.total)} by ${p.mode}; the payment is still pending, so there is no receipt.`, amount: p.total, student_id: p.student_id }); }
  for (const s of check(sets) as { id: string; ref: string; gross: number; fee_gst: number; bank_amount: number | null }[]) { const k = `short:${s.id}`; const diff = (s.gross - s.fee_gst) - (s.bank_amount ?? 0); if (!keys.has(k)) add.push({ institution_id: inst, ref_key: k, kind: diff > 0 ? "Payout short" : "Payout over", detail: `Settlement ${s.ref} was ${inr(Math.abs(diff))} ${diff > 0 ? "less" : "more"} than expected.`, amount: Math.abs(diff) }); }
  for (const l of check(lines) as { id: string; line_on: string; narration: string; money_in: number }[]) { const k = `bank:${l.id}`; if (!keys.has(k)) add.push({ institution_id: inst, ref_key: k, kind: "Bank credit with no payment", detail: `${inr(l.money_in)} credit “${l.narration}” on ${l.line_on}, with no matching payment.`, amount: l.money_in }); }
  if (add.length) check(await supabaseAdmin.from("recon_exceptions").insert(add).select("id"));
  const rows = check(await supabaseAdmin.from("recon_exceptions").select("id, ref_key, kind, detail, amount, student_id, status, opened_on, cleared_on").eq("institution_id", inst).order("opened_on", { ascending: false }).limit(500)) as { id: string; ref_key: string; kind: string; detail: string; amount: number; student_id: string | null; status: string; opened_on: string; cleared_on: string | null }[];
  const ms = today().slice(0, 7); const done = rows.filter((x) => x.status === "Cleared");
  const open = rows.filter((x) => x.status === "Open");
  const avg = done.length ? done.reduce((n, x) => n + daysBetween(x.opened_on, x.cleared_on ?? x.opened_on), 0) / done.length : 0;
  return { items: rows.map((r) => ({ ...r, fix: r.kind === "Paid but no receipt" ? "receipt" : r.kind === "Paid twice" ? "refund" : "clear" })), open: open.length, amount: open.reduce((n, x) => n + x.amount, 0), cleared_month: done.filter((x) => (x.cleared_on ?? "").startsWith(ms)).length, avg_days: Math.round(avg * 10) / 10 };
}
export async function fixException(inst: string, id: string, input: unknown, who: string, actor?: string) {
  const { action } = z.object({ action: z.enum(["receipt", "refund", "clear"]) }).strict().parse(input);
  const x = check(await supabaseAdmin.from("recon_exceptions").select("id, ref_key, kind, amount, student_id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; ref_key: string; kind: string; amount: number; student_id: string | null; status: string } | null;
  if (!x) throw new HttpError(404, "Not found."); if (x.status !== "Open") throw new HttpError(409, "That is already cleared.");
  let note = "Cleared";
  if (action === "receipt") { if (!x.ref_key.startsWith("norcpt:")) throw new HttpError(400, "That is not a missing receipt."); check(await supabaseAdmin.from("fee_payments").update({ status: "Paid" }).eq("id", x.ref_key.slice(7)).eq("institution_id", inst).select("id")); note = "Receipt created"; }
  if (action === "refund") { if (!x.student_id) throw new HttpError(400, "No student to refund."); check(await supabaseAdmin.from("fee_refunds").insert({ institution_id: inst, student_id: x.student_id, reason: "Paid twice by mistake", amount: x.amount, requested_on: today(), created_by: actor ?? null }).select("id")); note = "Refund requested"; }
  check(await supabaseAdmin.from("recon_exceptions").update({ status: "Cleared", cleared_on: today() }).eq("id", id).eq("institution_id", inst).select("id"));
  await audit(inst, who, "Exception cleared", x.kind, note);
  return { ok: true };
}
export async function bankLines(inst: string) {
  const r = check(await supabaseAdmin.from("bank_statement_lines").select("id, line_on, narration, money_in, money_out, matched_to, rule_note, journal, status").eq("institution_id", inst).order("line_on", { ascending: false }).limit(2000)) as { id: string; line_on: string; narration: string; money_in: number; money_out: number; matched_to: string | null; rule_note: string | null; journal: string | null; status: string }[];
  const n = (s: string) => r.filter((x) => x.status === s).length;
  return { items: r, total: r.length, auto: n("Auto") + n("Manual"), suggested: n("Suggested"), none: n("No match") };
}
export async function uploadStatement(inst: string, input: unknown, who: string) {
  const i = z.object({ rows: z.array(z.object({ date, narration: z.string().trim().min(1).max(240), money_in: z.number().int().min(0).max(1_000_000_000), money_out: z.number().int().min(0).max(1_000_000_000) }).strict()).min(1, "The statement has no lines.").max(2000) }).strict().parse(input);
  const rules = new Map((await reconRules(inst)).items.map((r) => [r.key, r.on]));
  const [pays, ro, sets, exps, existing] = await Promise.all([supabaseAdmin.from("fee_payments").select("id, receipt_no, student_id, mode, total, paid_on, reference").eq("institution_id", inst).eq("status", "Paid").limit(5000), roster(inst), supabaseAdmin.from("fee_settlements").select("id, ref, payments, payments_on, gross, fee_gst").eq("institution_id", inst), supabaseAdmin.from("fee_expenses").select("voucher, amount, paid_to").eq("institution_id", inst).eq("status", "Approved").limit(5000), supabaseAdmin.from("bank_statement_lines").select("line_on, narration, money_in, money_out").eq("institution_id", inst).limit(20000)]);
  const K = new Map(ro.items.map((r) => [r.id, r.name])); const P = check(pays) as { id: string; receipt_no: string; student_id: string; mode: string; total: number; paid_on: string; reference: string | null }[];
  const S = check(sets) as { id: string; ref: string; payments: number; payments_on: string; gross: number; fee_gst: number }[]; const E = check(exps) as { voucher: string; amount: number; paid_to: string }[];
  const have = new Set((check(existing) as { line_on: string; narration: string; money_in: number; money_out: number }[]).map((x) => `${x.line_on}|${x.narration}|${x.money_in}|${x.money_out}`));
  const used = new Set<string>(); const out: Record<string, unknown>[] = []; let jn = Number((await nextJournal(inst)).split("-")[2]); const yy = today().slice(2, 4);
  const journal = () => `JV-${yy}-${jn++}`;
  let dup = 0;
  for (const r of i.rows) {
    if (have.has(`${r.date}|${r.narration}|${r.money_in}|${r.money_out}`)) { dup++; continue; }
    const N = r.narration.toUpperCase(); let rec: Record<string, unknown> = { institution_id: inst, line_on: r.date, narration: r.narration, money_in: r.money_in, money_out: r.money_out, status: "No match" };
    if (r.money_in > 0) {
      const ref = P.find((p) => !used.has(p.id) && p.reference && p.reference.length >= 6 && N.includes(p.reference.toUpperCase()) && p.total === r.money_in && ((p.mode === "Cheque" ? rules.get("cheque") : rules.get("utr")) ?? true));
      const so = S.find((s) => N.includes(s.ref.toUpperCase()) && rules.get("payout") !== false);
      if (ref) { used.add(ref.id); rec = { ...rec, status: "Auto", matched_to: `Receipt ${ref.receipt_no} · ${K.get(ref.student_id) ?? ""}`, rule_note: ref.mode === "Cheque" ? "Cheque number" : "UTR in receipt", journal: journal() }; }
      else if (so) { check(await supabaseAdmin.from("fee_settlements").update({ bank_amount: r.money_in, bank_credit_on: r.date, bank_ref: r.narration.slice(0, 60), status: r.money_in === so.gross - so.fee_gst ? "Matched" : "Difference" }).eq("id", so.id).eq("institution_id", inst).select("id")); rec = { ...rec, status: "Auto", matched_to: `Gateway payout ${so.ref} · ${so.payments} payments`, rule_note: "Payout ID", journal: journal() }; }
      else if (rules.get("keyword") !== false && /INT\.? ?CR|INTEREST/.test(N)) rec = { ...rec, status: "Auto", matched_to: "Interest income", rule_note: "Narration keyword", journal: journal() };
      else if (rules.get("name") !== false) { const g = P.find((p) => !used.has(p.id) && p.total === r.money_in && Math.abs(daysBetween(p.paid_on, r.date)) <= 2); if (g) { used.add(g.id); rec = { ...rec, status: "Suggested", matched_to: `Receipt ${g.receipt_no} · ${K.get(g.student_id) ?? ""} (amount and date match, no UTR)`, rule_note: "Amount and date", suggest_payment: g.id }; } }
    } else if (r.money_out > 0) {
      if (rules.get("keyword") !== false && /BANK CHG|BANK CHARGES|GST/.test(N)) rec = { ...rec, status: "Auto", matched_to: /GST/.test(N) ? "Input GST" : "Bank charges", rule_note: "Narration keyword", journal: journal() };
      else if (rules.get("payee") !== false) { const e = E.find((x) => x.amount === r.money_out && x.paid_to.toUpperCase().split(/\s+/).some((w) => w.length >= 4 && N.includes(w))); if (e) rec = { ...rec, status: "Auto", matched_to: `Payment voucher ${e.voucher} · ${e.paid_to}`, rule_note: "Amount and payee", journal: journal() }; }
    }
    out.push(rec);
  }
  if (out.length) check(await supabaseAdmin.from("bank_statement_lines").insert(out).select("id"));
  const auto = out.filter((x) => x.status === "Auto").length;
  await audit(inst, "System", "Statement received", `${out.length} lines`, `${auto} matched on their own${dup ? `, ${dup} already uploaded` : ""}`);
  void who;
  return { added: out.length, auto, suggested: out.filter((x) => x.status === "Suggested").length, none: out.filter((x) => x.status === "No match").length, duplicates: dup };
}
export async function confirmLine(inst: string, id: string, who: string) {
  const l = check(await supabaseAdmin.from("bank_statement_lines").select("id, status, matched_to, money_in").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string; matched_to: string | null; money_in: number } | null;
  if (!l) throw new HttpError(404, "Not found."); if (l.status !== "Suggested") throw new HttpError(409, "Only a suggested match can be confirmed.");
  const j = await nextJournal(inst);
  check(await supabaseAdmin.from("bank_statement_lines").update({ status: "Manual", journal: j }).eq("id", id).eq("institution_id", inst).select("id"));
  await audit(inst, who, "Manually matched", `${inr(l.money_in)}`, l.matched_to ?? "", j);
  return { journal: j };
}
export async function reconAudit(inst: string) {
  return { items: check(await supabaseAdmin.from("recon_audit").select("id, at, who, action, item, details, journal").eq("institution_id", inst).order("at", { ascending: false }).limit(500)) as { id: string; at: string; who: string; action: string; item: string; details: string; journal: string | null }[] };
}

// ═════════════ budgets and forecasts ═════════════
function monthsDone(ys: string, now: string) { const a = Number(ys.slice(0, 4)) * 12 + Number(ys.slice(5, 7)); const b = Number(now.slice(0, 4)) * 12 + Number(now.slice(5, 7)); return Math.max(1, Math.min(12, b - a)); }
async function spentBy(inst: string, ys: string) {
  const e = await pages<{ amount: number; spent_on: string; cat: { name: string } | { name: string }[] | null }>((a, b) => supabaseAdmin.from("fee_expenses").select("amount, spent_on, cat:category_id(name)").eq("institution_id", inst).eq("status", "Approved").gte("spent_on", ys).range(a, b));
  return e.map((x) => ({ amount: x.amount, spent_on: x.spent_on, head: (one(x.cat)?.name ?? "").toLowerCase() }));
}
export async function budgets(inst: string) {
  const [ys, b] = await Promise.all([yearStart(inst), supabaseAdmin.from("fee_budgets").select("id, head, department, annual, revised").eq("institution_id", inst).order("annual", { ascending: false })]);
  const now = today(); const m = monthsDone(ys, now); const ex = await spentBy(inst, ys); const pace = Math.round((m / 12) * 100);
  const items = (check(b) as { id: string; head: string; department: string; annual: number; revised: number | null }[]).map((x) => { const spent = ex.filter((e) => e.head === x.head.toLowerCase()).reduce((n, e) => n + e.amount, 0); const projected = Math.round((spent / m) * 12); return { ...x, spent, used: x.annual ? Math.round((spent / x.annual) * 100) : 0, projected }; });
  const total = items.reduce((n, x) => n + x.annual, 0); const spent = items.reduce((n, x) => n + x.spent, 0); const proj = items.reduce((n, x) => n + x.projected, 0);
  return { year_start: ys, months_done: m, pace, items, total, spent, spent_pct: total ? Math.round((spent / total) * 100) : 0, projected: proj, over: Math.max(0, proj - total), heads_over: items.filter((x) => x.used > pace + 5 || x.projected > x.annual).length };
}
export async function addBudget(inst: string, input: unknown) {
  const i = z.object({ head: z.string().trim().min(2, "Enter the head.").max(80), department: z.string().trim().max(40).optional(), annual: z.number().int().min(0).max(10_000_000_000) }).strict().parse(input);
  const dup = check(await supabaseAdmin.from("fee_budgets").select("id").eq("institution_id", inst).ilike("head", i.head)) as unknown[];
  if (dup.length) throw new HttpError(409, "That head is already budgeted.");
  return check(await supabaseAdmin.from("fee_budgets").insert({ institution_id: inst, head: i.head, department: i.department ?? "", annual: i.annual }).select("id").single());
}
export async function reviseBudget(inst: string, id: string, input: unknown) {
  const { revised } = z.object({ revised: z.number().int().min(0).max(10_000_000_000).nullable() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("fee_budgets").update({ revised }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[];
  if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function budgetVsActual(inst: string) {
  const [ys, b] = await Promise.all([yearStart(inst), supabaseAdmin.from("fee_budgets").select("head, annual").eq("institution_id", inst)]);
  const B = check(b) as { head: string; annual: number }[]; const month = Math.round(B.reduce((n, x) => n + x.annual, 0) / 12);
  const ex = await spentBy(inst, ys); const now = today(); const n = monthsDone(ys, now) + (now.slice(8) > "00" ? 1 : 0);
  const out: { month: string; label: string; budget: number; actual: number }[] = [];
  for (let k = 0; k < Math.min(12, n); k++) { const d = new Date(Date.UTC(Number(ys.slice(0, 4)), Number(ys.slice(5, 7)) - 1 + k, 1)); const key = d.toISOString().slice(0, 7); if (key > now.slice(0, 7)) break; out.push({ month: key, label: d.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), budget: month, actual: ex.filter((e) => e.spent_on.startsWith(key)).reduce((s, e) => s + e.amount, 0) }); }
  const done = out.slice(0, -1).length ? out.slice(0, -1) : out;
  let since = ""; for (let k = done.length - 1; k >= 0 && done[k].actual > done[k].budget; k--) since = done[k].label;
  const heads = (await budgets(inst)).items.filter((x) => x.projected > x.annual).map((x) => x.head.toLowerCase()).slice(0, 3);
  return { months: out, since, heads };
}
export async function feeIncome(inst: string) {
  const ov = await everyone(inst); const now = today();
  let paid = 0, amt = 0; for (const d of ov.detail) for (const t of d.terms) if (t.date < now) { paid += t.paid; amt += t.amount; }
  const rate = amt ? paid / amt : 0.9;
  const by = new Map<number, { date: string; billed: number; due: number; paid: number }>();
  for (const d of ov.detail) for (const t of d.terms) { const x = by.get(t.term) ?? { date: t.date, billed: 0, due: 0, paid: 0 }; x.billed += t.amount; x.due += t.due; x.paid += t.paid; by.set(t.term, x); }
  const rows = [...by.entries()].filter(([, x]) => x.due > 0).map(([term, x]) => ({ name: `Instalment ${term}`, date: x.date, billed: x.billed, expected: Math.round(x.paid + x.due * rate), pct: x.billed ? Math.round(((x.paid + x.due * rate) / x.billed) * 100) : 0, based_on: amt ? `${Math.round(rate * 100)}% of billed fees paid on past instalments` : "No past instalments yet; assumed 90%" })).sort((a, b) => (a.date < b.date ? -1 : 1));
  return { rate: Math.round(rate * 100), items: rows };
}
export async function cashFlow(inst: string) {
  const [fi, ov, plan, op] = await Promise.all([feeIncome(inst), everyone(inst), supabaseAdmin.from("fee_cash_plan").select("month, other_in, running, capital").eq("institution_id", inst), supabaseAdmin.from("fee_cash_open").select("opening, as_of").eq("institution_id", inst).maybeSingle()]);
  const P = new Map((check(plan) as { month: string; other_in: number; running: number; capital: number }[]).map((x) => [x.month, x]));
  const o = check(op) as { opening: number; as_of: string } | null; const rate = fi.rate / 100;
  const feesBy = new Map<string, number>(); const seen = new Map<number, string>();
  for (const d of ov.detail) for (const t of d.terms) { seen.set(t.term, t.date); const k = t.date.slice(0, 7); feesBy.set(k, (feesBy.get(k) ?? 0) + t.due * rate); }
  const now = today(); let opening = Number(o?.opening ?? 0); const rows: { month: string; label: string; opening: number; fees_in: number; other_in: number; running: number; capital: number; closing: number }[] = [];
  for (let k = 0; k < 6; k++) { const d = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 1 + k, 1)); const key = d.toISOString().slice(0, 7); const p = P.get(key); const fees_in = Math.round(feesBy.get(key) ?? 0); const closing = opening + fees_in + (p?.other_in ?? 0) - (p?.running ?? 0) - (p?.capital ?? 0); rows.push({ month: key, label: d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }), opening, fees_in, other_in: p?.other_in ?? 0, running: p?.running ?? 0, capital: p?.capital ?? 0, closing }); opening = closing; }
  const low = rows.reduce((a, b) => (b.closing < a.closing ? b : a), rows[0]);
  return { opening: Number(o?.opening ?? 0), as_of: o?.as_of ?? null, rows, tightest: { label: low.label, closing: low.closing } };
}
export async function saveCashPlan(inst: string, input: unknown) {
  const i = z.object({ opening: z.number().int().min(-10_000_000_000).max(10_000_000_000), months: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), other_in: z.number().int().min(0).max(10_000_000_000), running: z.number().int().min(0).max(10_000_000_000), capital: z.number().int().min(0).max(10_000_000_000) }).strict()).max(12) }).strict().parse(input);
  check(await supabaseAdmin.from("fee_cash_open").upsert({ institution_id: inst, opening: i.opening, as_of: today() }, { onConflict: "institution_id" }).select("institution_id"));
  if (i.months.length) check(await supabaseAdmin.from("fee_cash_plan").upsert(i.months.map((m) => ({ institution_id: inst, ...m })), { onConflict: "institution_id,month" }).select("month"));
  return cashFlow(inst);
}

// ═════════════ staff claims and advances ═════════════
const CLAIM_DEFAULTS: [string, number, string, number, string][] = [["Travel", 2000, "trip", 500, "HOD"], ["Field trip", 15000, "", 0, "HOD, then Principal"], ["Training", 10000, "", 0, "HOD"], ["Petty cash", 5000, "month", 200, "Accountant"], ["Medical supplies", 3000, "", 0, "Principal"]];
export async function claimRules(inst: string) {
  let r = check(await supabaseAdmin.from("claim_rules").select("ctype, limit_amount, per, receipt_above, approver").eq("institution_id", inst)) as { ctype: string; limit_amount: number; per: string; receipt_above: number; approver: string }[];
  if (!r.length) { check(await supabaseAdmin.from("claim_rules").insert(CLAIM_DEFAULTS.map(([ctype, limit_amount, per, receipt_above, approver]) => ({ institution_id: inst, ctype, limit_amount, per, receipt_above, approver }))).select("ctype")); r = CLAIM_DEFAULTS.map(([ctype, limit_amount, per, receipt_above, approver]) => ({ ctype, limit_amount, per, receipt_above, approver })); }
  const order = CLAIM_DEFAULTS.map((x) => x[0]);
  return { items: r.sort((a, b) => order.indexOf(a.ctype) - order.indexOf(b.ctype)).map((x) => ({ ...x, limit_text: `${inr(x.limit_amount)}${x.per ? ` a ${x.per}` : ""}`, receipt_text: x.receipt_above ? `Above ${inr(x.receipt_above)}` : "Always" })) };
}
async function staffNames(inst: string) {
  const r = check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, designation").eq("institution_id", inst).limit(2000)) as { id: string; first_name: string; last_name: string; designation: string | null }[];
  return new Map(r.map((x) => [x.id, { name: `${x.first_name} ${x.last_name}`.trim(), dept: x.designation ?? "" }]));
}
export async function claims(inst: string) {
  const [rows, names, rules] = await Promise.all([supabaseAdmin.from("staff_claims").select("id, code, staff_id, ctype, description, claim_on, amount, receipts, status, paid_on").eq("institution_id", inst).order("claim_on", { ascending: false }).order("code", { ascending: false }).limit(1000), staffNames(inst), claimRules(inst)]);
  const items = (check(rows) as { id: string; code: string; staff_id: string; ctype: string; description: string; claim_on: string; amount: number; receipts: number; status: string; paid_on: string | null }[]).map((x) => ({ ...x, staff: names.get(x.staff_id)?.name ?? "", dept: names.get(x.staff_id)?.dept ?? "", limit: rules.items.find((r) => r.ctype === x.ctype)?.limit_amount ?? 0, approver: rules.items.find((r) => r.ctype === x.ctype)?.approver ?? "" }));
  const ms = today().slice(0, 7); const paid = items.filter((x) => x.status === "Paid");
  return { staff: [...names.entries()].map(([id, v]) => ({ id, name: v.name })).sort((a, b) => a.name.localeCompare(b.name)), types: rules.items.map((r) => r.ctype), items, waiting: items.filter((x) => ["Submitted", "HOD approved"].includes(x.status)).length, to_pay: items.filter((x) => x.status === "Approved").length, to_pay_amount: items.filter((x) => x.status === "Approved").reduce((n, x) => n + x.amount, 0), paid_month: paid.filter((x) => (x.paid_on ?? "").startsWith(ms)).reduce((n, x) => n + x.amount, 0), avg_days: paid.length ? Math.round(paid.reduce((n, x) => n + daysBetween(x.claim_on, x.paid_on ?? x.claim_on), 0) / paid.length) : 0 };
}
export async function addClaim(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, ctype: z.string().trim().min(1).max(20), description: z.string().trim().max(200).optional(), claim_on: date, amount: z.number().int().min(1).max(10_000_000), receipts: z.number().int().min(0).max(100) }).strict().parse(input);
  const rule = (await claimRules(inst)).items.find((r) => r.ctype === i.ctype); if (!rule) throw new HttpError(400, "Choose a claim type.");
  if (!(await staffNames(inst)).has(i.staff_id)) throw new HttpError(404, "Staff member not found.");
  if (daysBetween(i.claim_on, today()) > 30) throw new HttpError(400, "Claims must be made within 30 days of spending.");
  if (daysBetween(today(), i.claim_on) > 0) throw new HttpError(400, "The date is in the future.");
  if (i.amount > rule.receipt_above && i.receipts < 1) throw new HttpError(400, `A receipt is needed above ${inr(rule.receipt_above)}.`);
  return check(await supabaseAdmin.from("staff_claims").insert({ institution_id: inst, ...i, description: i.description ?? "" }).select("id, code").single());
}
export async function moveClaim(inst: string, id: string, input: unknown, role: string) {
  const { action } = z.object({ action: z.enum(["approve", "reject", "pay"]) }).strict().parse(input);
  const c = check(await supabaseAdmin.from("staff_claims").select("id, ctype, amount, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; ctype: string; amount: number; status: string } | null;
  if (!c) throw new HttpError(404, "Not found.");
  const rule = (await claimRules(inst)).items.find((r) => r.ctype === c.ctype); const top = ["Principal", "InstitutionAdmin"]; const lead = [...top, "VicePrincipal"];
  if (action === "pay") { if (c.status !== "Approved") throw new HttpError(409, "Approve the claim before paying it."); if (![...lead, "Accountant", "Finance"].includes(role)) throw new HttpError(403, "Only accounts or the principal can pay a claim."); check(await supabaseAdmin.from("staff_claims").update({ status: "Paid", paid_on: today() }).eq("id", id).eq("institution_id", inst).select("id")); return { ok: true }; }
  if (!["Submitted", "HOD approved"].includes(c.status)) throw new HttpError(409, "That was already decided.");
  const allowed = c.status === "HOD approved" || c.amount > (rule?.limit_amount ?? 0) || rule?.approver === "Principal" ? top : rule?.approver === "Accountant" ? [...lead, "Accountant"] : lead;
  if (!allowed.includes(role)) throw new HttpError(403, "You can't decide this claim.");
  const next = action === "reject" ? "Rejected" : c.status === "Submitted" && rule?.approver.includes("then") ? "HOD approved" : "Approved";
  check(await supabaseAdmin.from("staff_claims").update({ status: next }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true, status: next };
}
export async function advances(inst: string) {
  const [rows, names] = await Promise.all([supabaseAdmin.from("staff_advances").select("id, staff_id, purpose, given, settle_by, settled").eq("institution_id", inst).order("settle_by", { ascending: false }).limit(500), staffNames(inst)]);
  return { staff: [...names.entries()].map(([id, v]) => ({ id, name: v.name })).sort((a, b) => a.name.localeCompare(b.name)), items: (check(rows) as { id: string; staff_id: string; purpose: string; given: number; settle_by: string; settled: number }[]).map((x) => ({ ...x, staff: names.get(x.staff_id)?.name ?? "", balance: x.given - x.settled, status: x.given - x.settled <= 0 ? "Settled" : "Open" })) };
}
export async function addAdvance(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, purpose: z.string().trim().min(2, "Enter the purpose.").max(160), given: z.number().int().min(1).max(10_000_000), settle_by: date }).strict().parse(input);
  if (!(await staffNames(inst)).has(i.staff_id)) throw new HttpError(404, "Staff member not found.");
  return check(await supabaseAdmin.from("staff_advances").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function settleAdvance(inst: string, id: string, input: unknown) {
  const { amount } = z.object({ amount: z.number().int().min(1).max(10_000_000) }).strict().parse(input);
  const a = check(await supabaseAdmin.from("staff_advances").select("id, given, settled").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; given: number; settled: number } | null;
  if (!a) throw new HttpError(404, "Not found."); if (amount > a.given - a.settled) throw new HttpError(409, `Only ${inr(a.given - a.settled)} is left to settle.`);
  check(await supabaseAdmin.from("staff_advances").update({ settled: a.settled + amount }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}
void entries;
