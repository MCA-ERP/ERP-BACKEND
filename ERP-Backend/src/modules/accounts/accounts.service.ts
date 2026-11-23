import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { everyone, receipts } from "../school/fees2.service";
import { dueIso, feeSettings, yearStart } from "../school/fees.service";
import { alertRules, insights, saveAlertRule } from "../school/fees3.service";
import { reminderLog } from "../school/fees4.service";
import { clearDept } from "../school/hr4.service";
import * as hr4 from "../school/hr4.service";
import { whoAmI } from "../teacher/teacher.service";

/**
 * The Accounts (Fee & Finance) portal for the school's accountant. Every function takes the school and the signed-in
 * person from the server session, never from the request. Fee setup, billing and books reuse the School Admin fee
 * services (reached through /school/fees); what is here is what the accountant's own pages add on top of them.
 */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const istTime = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).toLowerCase();
const monthKey = (d: string) => d.slice(0, 7);

/** Instalments past their due date with something still owing, across every enrolled student. */
function overdueInstalments(detail: { terms: { date: string; due: number }[] }[]) {
  const now = today();
  let n = 0;
  for (const d of detail) for (const t of d.terms) if (t.date < now && t.due > 0) n++;
  return n;
}

// ═════════════ who and the badges ═════════════
export async function me(inst: string, profile: string) {
  const who = await whoAmI(inst, profile);
  const [ov, notes] = await Promise.all([everyone(inst), notifications(inst, profile)]);
  return { name: who.name, line: who.designation || "Accountant", emp_code: who.emp_code, badges: { overdue: overdueInstalments(ov.detail), unread: notes.unread } };
}

// ═════════════ finance dashboard: overview ═════════════
async function pagedPayments(inst: string, from: string) {
  const out: { total: number; paid_on: string; mode: string; status: string; created_at: string }[] = [];
  for (let a = 0; ; a += 1000) {
    const rows = check(await supabaseAdmin.from("fee_payments").select("total, paid_on, mode, status, created_at").eq("institution_id", inst).eq("status", "Paid").gte("paid_on", from).range(a, a + 999)) as typeof out;
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const MODE_LABEL: Record<string, string> = { UPI: "UPI", Card: "Card", Bank: "Net banking", Cash: "Cash", Cheque: "Cheque" };

export async function overview(inst: string) {
  const now = today();
  const ys = await yearStart(inst);
  const [ov, pays, exps, open, set, rc, cats, grp, plans] = await Promise.all([
    everyone(inst),
    pagedPayments(inst, ys),
    supabaseAdmin.from("fee_expenses").select("amount, spent_on").eq("institution_id", inst).eq("status", "Approved").gte("spent_on", ys).limit(50000),
    supabaseAdmin.from("fee_cash_open").select("opening, as_of").eq("institution_id", inst).maybeSingle(),
    feeSettings(inst),
    receipts(inst),
    supabaseAdmin.from("fee_categories").select("id", { count: "exact", head: true }).eq("institution_id", inst),
    supabaseAdmin.from("fee_groups").select("id", { count: "exact", head: true }).eq("institution_id", inst).eq("status", "Active"),
    supabaseAdmin.from("student_fee_plans").select("student_id", { count: "exact", head: true }).eq("institution_id", inst),
  ]);
  const sum = (xs: { total: number }[]) => xs.reduce((n, x) => n + x.total, 0);
  const ms = monthKey(now) + "-01";
  const t = pays.filter((p) => p.paid_on === now);
  const month = pays.filter((p) => p.paid_on >= ms);
  const collected = sum(pays);
  const a = ov.agg;
  const rate = collected + a.owe_now > 0 ? Math.round((collected / (collected + a.owe_now)) * 100) : 100;

  // collection by month, from the first month of the year to this month
  const months: { key: string; label: string; total: number }[] = [];
  for (let d = new Date(`${ys.slice(0, 7)}-01T00:00:00Z`); monthKey(d.toISOString()) <= monthKey(now); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const key = d.toISOString().slice(0, 7);
    months.push({ key, label: d.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), total: 0 });
  }
  for (const p of pays) { const m = months.find((x) => x.key === monthKey(p.paid_on)); if (m) m.total += p.total; }
  const due = dueIso(set.due_dates, ys);
  const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", timeZone: "UTC" });
  const passed = due.filter((d) => d <= now);

  const modes = new Map<string, number>();
  for (const p of pays) modes.set(MODE_LABEL[p.mode] ?? p.mode, (modes.get(MODE_LABEL[p.mode] ?? p.mode) ?? 0) + p.total);

  const spent = ((check(exps) ?? []) as { amount: number; spent_on: string }[]);
  const expenditure = spent.reduce((n, x) => n + x.amount, 0);
  const o = check(open) as { opening: number; as_of: string } | null;
  const bank = o ? Number(o.opening) + sum(pays.filter((p) => p.paid_on >= o.as_of)) - spent.filter((x) => x.spent_on >= o.as_of).reduce((n, x) => n + x.amount, 0) : null;

  const have = (r: { count: number | null }) => (r.count ?? 0) > 0;
  const stepsDone = [have(cats as { count: number | null }), have(grp as { count: number | null }), have(plans as { count: number | null }), a.annual > 0, a.annual > 0, pays.length > 0, true];
  return {
    year_start: ys, today: now,
    steps: ["Fee categories", "Class-wise structures", "Assign to students", "Generate dues", "Parent views dues", "Receipt & ledger", "Dashboard updates"].map((label, i) => ({ n: i + 1, label, done: stepsDone[i] })),
    tiles: { today: { amount: sum(t), receipts: t.length }, month: { amount: sum(month), receipts: month.length }, outstanding: { amount: a.pending, overdue_students: a.overdue_students }, rate },
    scope_note: `Totals and charts cover all ${a.students.toLocaleString("en-IN")} enrolled students. Lists show the latest ${Math.min(5, rc.items.length)} receipts.`,
    by_month: months.map((m) => ({ label: m.label, total: m.total, current: m.key === monthKey(now) })),
    month_note: `${passed.map((d, i) => `Term ${i + 1} was due on ${fmt(d)}`).join(" and ")}${passed.length ? ". " : ""}${now.slice(0, 7) === monthKey(now) ? `${new Date(now + "T00:00:00Z").toLocaleDateString("en-IN", { month: "long", timeZone: "UTC" })} is month to date.` : ""}`,
    by_mode: [...modes.entries()].sort((x, y) => y[1] - x[1]).map(([label, total]) => ({ label, total })),
    by_class: [...a.by_class.entries()].map(([label, total]) => ({ label, total })),
    books: { income: collected, expenditure, surplus: collected - expenditure, bank, bank_as_of: o?.as_of ?? null },
    latest: rc.items.filter((r) => r.status === "Valid").slice(0, 5).map((r) => ({ receipt_no: r.receipt_no, student: r.student, total: r.total, mode: r.mode, paid_on: r.paid_on, issued_by: r.issued_by })),
  };
}

// ═════════════ leadership live ═════════════
export async function leadership(inst: string) {
  const now = today();
  const ys = await yearStart(inst);
  const [ov, pays, cons, budgetQ, set, lines] = await Promise.all([
    everyone(inst),
    pagedPayments(inst, ys),
    supabaseAdmin.from("fee_concessions").select("ctype, amount").eq("institution_id", inst).eq("status", "Approved").limit(20000),
    supabaseAdmin.from("fee_revenue_budget").select("fee_type, annual").eq("institution_id", inst),
    feeSettings(inst),
    supabaseAdmin.from("fee_payment_lines").select("line_key, amount, fee_payments:payment_id!inner(institution_id, status, paid_on)").eq("fee_payments.institution_id", inst).eq("fee_payments.status", "Paid").gte("fee_payments.paid_on", ys).limit(50000),
  ]);
  const a = ov.agg;
  const sum = (xs: { total: number }[]) => xs.reduce((n, x) => n + x.total, 0);
  const ms = monthKey(now) + "-01";
  const t = pays.filter((p) => p.paid_on === now);
  const month = pays.filter((p) => p.paid_on >= ms);
  const byHour = new Array(24).fill(0) as number[];
  for (const p of t) byHour[Number(new Date(p.created_at).toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })) % 24] += p.total;
  const hours = ["8–9 am", "9–10 am", "10–11 am", "11–12", "12–1 pm", "1–2 pm", "2–3 pm", "3–4 pm"];
  const given = (check(cons) ?? []) as { ctype: string; amount: number }[];
  const types = new Map<string, number>();
  for (const x of given) types.set(x.ctype, (types.get(x.ctype) ?? 0) + x.amount);
  const collected = sum(pays);

  // revenue against budget: the school's yearly budget by fee type, scaled by how many instalments have fallen due
  const due = dueIso(set.due_dates, ys);
  const pace = due.length ? due.filter((d) => d <= now).length / due.length : 0;
  const LABEL: Record<string, string> = { fees: "Tuition and school fees", transport: "Transport", hostel: "Hostel", late: "Late fees" };
  const actual = new Map<string, number>();
  for (const l of (check(lines) ?? []) as unknown as { line_key: string; amount: number }[]) actual.set(LABEL[l.line_key.split(":")[1]] ?? "Other", (actual.get(LABEL[l.line_key.split(":")[1]] ?? "Other") ?? 0) + l.amount);
  const budgetRows = (check(budgetQ) ?? []) as { fee_type: string; annual: number }[];
  const heads = [...new Set([...budgetRows.map((b) => b.fee_type), ...actual.keys()])];
  const table = heads.map((head) => {
    const b = budgetRows.find((x) => x.fee_type === head);
    const budget = b ? Math.round(Number(b.annual) * pace) : null;
    const act = actual.get(head) ?? 0;
    return { head, budget, actual: act, variance: budget === null ? null : act - budget };
  });
  const budgetTotal = table.reduce((n, r) => n + (r.budget ?? 0), 0);
  const roster = new Map<string, { name: string; class_label: string }>();
  const recentRows = check(await supabaseAdmin.from("fee_payments").select("student_id, total, mode, created_at").eq("institution_id", inst).eq("status", "Paid").eq("paid_on", now).order("created_at", { ascending: false }).limit(8)) as { student_id: string; total: number; mode: string; created_at: string }[];
  if (recentRows.length) {
    const ids = [...new Set(recentRows.map((r) => r.student_id))];
    const st = (check(await supabaseAdmin.from("students").select("id, first_name, last_name").eq("institution_id", inst).in("id", ids)) ?? []) as { id: string; first_name: string; last_name: string }[];
    for (const s of st) roster.set(s.id, { name: `${s.first_name} ${s.last_name}`.trim(), class_label: "" });
  }
  return {
    today: now, stamp: new Date().toISOString(),
    tiles: {
      today: { amount: sum(t), receipts: t.length },
      month: { amount: sum(month), receipts: month.length },
      outstanding: { amount: a.pending, overdue_students: a.overdue_students },
      revenue: { amount: collected, pct_of_budget: budgetTotal > 0 ? Math.round((collected / budgetTotal) * 100) : null },
      concessions: { amount: given.reduce((n, x) => n + x.amount, 0), pct_of_billed: a.annual > 0 ? Math.round((given.reduce((n, x) => n + x.amount, 0) / a.annual) * 1000) / 10 : 0 },
    },
    by_hour: hours.map((label, i) => ({ label, total: byHour[8 + i] })),
    recent: recentRows.map((r) => ({ amount: r.total, student: roster.get(r.student_id)?.name ?? "", mode: MODE_LABEL[r.mode] ?? r.mode, at: istTime(r.created_at) })),
    buckets: ["Not yet due", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"].map((label, i) => ({ label, total: a.buckets[i] })),
    concessions: [...types.entries()].sort((x, y) => y[1] - x[1]).map(([label, total]) => ({ label, total })),
    revenue_table: table,
  };
}

export async function saveRevenueBudget(inst: string, input: unknown) {
  const i = z.object({ fee_type: z.enum(["Tuition and school fees", "Transport", "Hostel", "Late fees", "Other"]), annual: z.number().int().min(0).max(100_000_000_000) }).strict().parse(input);
  check(await supabaseAdmin.from("fee_revenue_budget").upsert({ institution_id: inst, fee_type: i.fee_type, annual: i.annual }, { onConflict: "institution_id,fee_type" }).select("fee_type"));
  return { ok: true };
}

// ═════════════ notifications ═════════════
export interface Note { key: string; tone: "bad" | "warn" | "info" | "good"; title: string; note: string; when: string; read: boolean; tab?: string }

export async function notifications(inst: string, profile: string): Promise<{ items: Note[]; unread: number }> {
  const now = today();
  const since = new Date(Date.now() - 3 * 86400000).toISOString();
  const [ov, pending, failed, reads, tasks, sets, recentAdm, plans] = await Promise.all([
    everyone(inst),
    supabaseAdmin.from("fee_payments").select("id, mode, created_at").eq("institution_id", inst).eq("status", "Pending").limit(500),
    supabaseAdmin.from("fee_payments").select("id, mode, created_at").eq("institution_id", inst).eq("status", "Failed").gte("created_at", since).limit(500),
    supabaseAdmin.from("staff_notification_reads").select("key").eq("profile_id", profile).limit(5000),
    supabaseAdmin.from("acc_tasks").select("id, title, created_at").eq("institution_id", inst).eq("owner_id", profile).eq("status", "Open").limit(50),
    supabaseAdmin.from("fee_settlements").select("id, ref, bank_credit_on, bank_amount, created_at").eq("institution_id", inst).eq("status", "Matched").order("created_at", { ascending: false }).limit(1),
    supabaseAdmin.from("students").select("id").eq("institution_id", inst).gte("admission_date", new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)).limit(500),
    supabaseAdmin.from("student_fee_plans").select("student_id").eq("institution_id", inst).limit(20000),
  ]);
  const R = new Set(((check(reads) ?? []) as { key: string }[]).map((r) => r.key));
  const items: Note[] = [];
  const add = (n: Omit<Note, "read">) => items.push({ ...n, read: R.has(n.key) });
  const late = overdueInstalments(ov.detail);
  const term = ov.detail.flatMap((d) => d.terms).filter((t) => t.date < now && t.due > 0).map((t) => t.term).sort((x, y) => y - x)[0];
  if (late > 0) add({ key: `overdue:${now}:${late}`, tone: "bad", title: `${late} instalment${late === 1 ? "" : "s"} overdue`, note: `Term ${term} · late fee applies`, when: "Today", tab: "installment-dues" });
  const P = (check(pending) ?? []) as { mode: string; created_at: string }[];
  if (P.length) add({ key: `pending:${P.length}:${P[0].created_at.slice(0, 10)}`, tone: "warn", title: `${P.length} gateway payment${P.length === 1 ? "" : "s"} pending`, note: `${MODE_LABEL[P[0].mode] ?? P[0].mode} · match with settlement`, when: istTime(P[0].created_at), tab: "reconciliation" });
  const F = (check(failed) ?? []) as { mode: string; created_at: string }[];
  if (F.length) add({ key: `failed:${F.length}:${F[0].created_at.slice(0, 10)}`, tone: "bad", title: `${F.length} ${(MODE_LABEL[F[0].mode] ?? F[0].mode).toLowerCase()} payment${F.length === 1 ? "" : "s"} failed`, note: "Parent can retry from the Parent portal", when: istTime(F[0].created_at) });
  const planned = new Set(((check(plans) ?? []) as { student_id: string }[]).map((p) => p.student_id));
  const noPlan = ((check(recentAdm) ?? []) as { id: string }[]).filter((s) => !planned.has(s.id)).length;
  if (noPlan) add({ key: `admissions:${now}:${noPlan}`, tone: "info", title: "New admissions need dues", note: `${noPlan} new student${noPlan === 1 ? "" : "s"} without a fee plan yet`, when: "Today" });
  const S = ((check(sets) ?? []) as { ref: string; bank_credit_on: string | null; created_at: string }[])[0];
  if (S) add({ key: `settled:${S.ref}`, tone: "good", title: "Gateway payout matched", note: `Payout ${S.ref} matched to the bank credit`, when: S.bank_credit_on ? new Date(S.bank_credit_on + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }) : "Recently" });
  for (const t of (check(tasks) ?? []) as { id: string; title: string; created_at: string }[]) add({ key: `task:${t.id}`, tone: "info", title: t.title, note: "A task you created from an AI insight", when: new Date(t.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }), tab: "insights" });
  return { items, unread: items.filter((n) => !n.read).length };
}

export async function markRead(inst: string, profile: string, input: unknown) {
  const { keys } = z.object({ keys: z.array(z.string().max(120)).max(200).optional() }).strict().parse(input);
  const list = keys?.length ? keys : (await notifications(inst, profile)).items.map((n) => n.key);
  if (list.length) check(await supabaseAdmin.from("staff_notification_reads").upsert(list.map((key) => ({ profile_id: profile, key })), { onConflict: "profile_id,key" }).select("key"));
  return { ok: true };
}

// ═════════════ sent messages ═════════════
export async function sentMessages(inst: string) {
  const since = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const [log, msgs] = await Promise.all([
    reminderLog(inst),
    supabaseAdmin.from("parent_messages").select("sent_on, subject, channel, status").eq("institution_id", inst).gte("sent_on", since).or("subject.ilike.%fee%,subject.ilike.%receipt%").limit(20000),
  ]);
  type Row = { id: string; sent_on: string; to: string; channel: string; message: string; sent: number; delivered: number };
  const rows: Row[] = log.items.filter((x) => x.sent_on >= since).map((x) => ({ id: x.id, sent_on: x.sent_on, to: "Parents with overdue fees", channel: x.channel, message: x.step, sent: x.sent_to, delivered: x.delivered }));
  const g = new Map<string, Row>();
  for (const m of (check(msgs) ?? []) as { sent_on: string; subject: string; channel: string; status: string }[]) {
    if (/^fee reminder$/i.test(m.subject)) continue; // already in the reminder log above
    const k = `${m.sent_on}|${m.subject}|${m.channel}`;
    const r = g.get(k) ?? { id: k, sent_on: m.sent_on, to: /receipt/i.test(m.subject) ? "Parents who paid" : "Parents", channel: m.channel, message: m.subject, sent: 0, delivered: 0 };
    r.sent++; if (["Delivered", "Read", "Replied"].includes(m.status)) r.delivered++;
    g.set(k, r);
  }
  const items = [...rows, ...g.values()].sort((a, b) => (a.sent_on < b.sent_on ? 1 : -1)).map((r) => ({ ...r, status: r.delivered >= r.sent ? "Delivered" : r.delivered === 0 ? "Not delivered" : "Partly delivered" }));
  const sent = items.reduce((n, x) => n + x.sent, 0); const delivered = items.reduce((n, x) => n + x.delivered, 0);
  return { items, messages: items.length, recipients: sent, delivered_pct: sent ? Math.round((delivered / sent) * 1000) / 10 : 100, not_delivered: sent - delivered };
}

// ═════════════ staff exit clearance (Accounts) ═════════════
export async function exitClearance(inst: string) {
  const ex = check(await supabaseAdmin.from("hr_exits").select("id, staff_id, last_day, status").eq("institution_id", inst).in("status", ["Approved", "Relieved"]).order("last_day")) as { id: string; staff_id: string; last_day: string; status: string }[];
  if (!ex.length) return { items: [] };
  const ids = ex.map((x) => x.staff_id);
  const [cl, adv, who] = await Promise.all([
    supabaseAdmin.from("hr_clearance").select("exit_id, state").eq("dept", "Accounts").in("exit_id", ex.map((x) => x.id)),
    supabaseAdmin.from("staff_advances").select("staff_id, given, settled").eq("institution_id", inst).in("staff_id", ids),
    supabaseAdmin.from("user_profiles").select("id, first_name, last_name, designation").eq("institution_id", inst).in("id", ids),
  ]);
  const C = new Map(((check(cl) ?? []) as { exit_id: string; state: string }[]).map((x) => [x.exit_id, x.state]));
  const A = (check(adv) ?? []) as { staff_id: string; given: number; settled: number }[];
  const W = new Map(((check(who) ?? []) as { id: string; first_name: string; last_name: string; designation: string | null }[]).map((x) => [x.id, x]));
  return {
    items: ex.map((x) => {
      const w = W.get(x.staff_id); const owed = A.filter((a) => a.staff_id === x.staff_id).reduce((n, a) => n + Math.max(0, a.given - a.settled), 0);
      return { id: x.id, name: w ? `${w.first_name} ${w.last_name}`.trim() : "", designation: w?.designation ?? "", last_day: x.last_day, advance: owed, state: C.get(x.id) ?? "Pending" };
    }),
  };
}

export async function clearAccounts(inst: string, id: string) {
  return clearDept(inst, id, { dept: "Accounts" });
}

// ═════════════ hiring budget ═════════════
const VAC = "id, code, post, department, vtype, note, posts, cost_year, requested_by, requested_on, stage";
type Vac = { id: string; code: string; post: string; department: string; vtype: string; note: string; posts: number; cost_year: number; requested_by: string; requested_on: string; stage: string };

export async function postApprovals(inst: string) {
  const r = (check(await supabaseAdmin.from("hr_vacancies").select(VAC).eq("institution_id", inst).order("requested_on", { ascending: false }).limit(300)) ?? []) as Vac[];
  const wait = r.filter((x) => x.stage === "Principal OK");
  const done = r.filter((x) => ["Approved", "Posted", "Filled", "Rejected"].includes(x.stage)).slice(0, 30);
  return { waiting: wait, decided: done.map((x) => ({ ...x, stage: x.stage === "Approved" ? "Approved" : x.stage })) };
}

export async function decidePost(inst: string, id: string, input: unknown, role: string) {
  const { action } = z.object({ action: z.enum(["approve", "reject"]) }).strict().parse(input);
  const v = check(await supabaseAdmin.from("hr_vacancies").select("id, stage").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; stage: string } | null;
  if (!v) throw new HttpError(404, "Not found.");
  if (v.stage !== "Principal OK") throw new HttpError(409, "Only a post the Principal has approved waits for you.");
  return hr4.moveVacancy(inst, id, { action }, role);
}

export async function salaryBudget(inst: string) {
  const [staff, vac, bud] = await Promise.all([
    supabaseAdmin.from("hr_staff").select("profile_id, monthly_salary").eq("institution_id", inst).limit(20000),
    supabaseAdmin.from("hr_vacancies").select("posts, cost_year, stage").eq("institution_id", inst).in("stage", ["Principal OK", "Approved", "Posted", "Filled"]),
    supabaseAdmin.from("fee_budgets").select("head, annual, revised").eq("institution_id", inst),
  ]);
  const S = (check(staff) ?? []) as { monthly_salary: number | null }[];
  const payroll = S.reduce((n, s) => n + (s.monthly_salary ?? 0) * 12, 0);
  const V = (check(vac) ?? []) as { posts: number; cost_year: number; stage: string }[];
  const approved = V.filter((x) => x.stage !== "Principal OK").reduce((n, x) => n + x.posts * x.cost_year, 0);
  const waiting = V.filter((x) => x.stage === "Principal OK").reduce((n, x) => n + x.posts * x.cost_year, 0);
  const B = ((check(bud) ?? []) as { head: string; annual: number; revised: number | null }[]).filter((b) => /salar|payroll|staff/i.test(b.head));
  const budget = B.reduce((n, b) => n + (b.revised ?? b.annual), 0);
  return { budget: B.length ? budget : null, payroll, staff: S.length, approved, waiting, left: B.length ? budget - payroll - approved - waiting : null };
}

export async function finalSettlements(inst: string) {
  const f = await hr4.fullAndFinal(inst);
  return { items: f.items.map((x) => ({ id: x.id, name: x.name, designation: x.designation, years: x.years, last_day: x.last_day, lines: x.lines, net: x.net, status: x.status === "Ready for Finance" ? "Ready for Finance" : "Pending", waiting_for: x.status === "Ready for Finance" ? "" : "Waiting for HR" })) };
}

// ═════════════ AI insights ═════════════
export async function insightList(inst: string, profile: string) {
  const [i, t] = await Promise.all([insights(inst), supabaseAdmin.from("acc_tasks").select("source_key").eq("institution_id", inst).eq("owner_id", profile)]);
  const made = new Set(((check(t) ?? []) as { source_key: string }[]).map((x) => x.source_key));
  return { ...i, items: (i as unknown as { items: { key: string }[] }).items.map((x) => ({ ...x, task: made.has(x.key) })) };
}

export async function createTask(inst: string, profile: string, input: unknown) {
  const i = z.object({ key: z.string().trim().min(1).max(100), title: z.string().trim().min(2).max(160), detail: z.string().trim().max(500).optional() }).strict().parse(input);
  const list = (await insights(inst)) as unknown as { items: { key: string }[] };
  if (!list.items.some((x) => x.key === i.key)) throw new HttpError(404, "That insight is no longer on the list.");
  check(await supabaseAdmin.from("acc_tasks").upsert({ institution_id: inst, owner_id: profile, title: i.title, detail: i.detail ?? "", source_key: i.key }, { onConflict: "institution_id,owner_id,source_key", ignoreDuplicates: true }).select("id"));
  return { ok: true };
}

export { alertRules, saveAlertRule };
