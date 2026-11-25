import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { directory } from "./hr.service";
import { leaveBalance, bandOf } from "./hr3.service";
import { yearStart } from "./fees.service";

/** HR, part 4: staff exit, full and final, Employee 360, analytics, compliance, scheduled reports and vacancies. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const staffMap = async (inst: string) => new Map((await directory(inst)).items.map((s) => [s.id, s]));
const DEPTS = ["Library", "Store", "Accounts", "IT", "Transport", "Department"] as const;

// ═════════════ exits ═════════════
export async function exits(inst: string) {
  const [r, st] = await Promise.all([supabaseAdmin.from("hr_exits").select("id, staff_id, resigned_on, last_day, reason, status").eq("institution_id", inst).order("resigned_on", { ascending: false }).limit(2000), staffMap(inst)]);
  return { staff: [...st.values()].map((s) => ({ id: s.id, name: s.name })), items: (check(r) as { id: string; staff_id: string; resigned_on: string; last_day: string; reason: string; status: string }[]).map((x) => ({ ...x, staff: st.get(x.staff_id)?.name ?? "", designation: st.get(x.staff_id)?.designation ?? "" })) };
}
export async function addExit(inst: string, input: unknown) {
  const i = z.object({ staff_id: uid, resigned_on: date.optional(), last_day: date, reason: z.string().trim().max(80).optional() }).strict().parse(input);
  if (!(await staffMap(inst)).has(i.staff_id)) throw new HttpError(404, "Staff member not found.");
  const open = check(await supabaseAdmin.from("hr_exits").select("id").eq("staff_id", i.staff_id).in("status", ["Pending", "Approved"])) as unknown[];
  if (open.length) throw new HttpError(409, "That person already has an exit in progress.");
  const resigned = i.resigned_on ?? today();
  if (i.last_day < resigned) throw new HttpError(400, "The last day is before the resignation date.");
  return check(await supabaseAdmin.from("hr_exits").insert({ institution_id: inst, staff_id: i.staff_id, resigned_on: resigned, last_day: i.last_day, reason: i.reason ?? "" }).select("id").single());
}
export async function decideExit(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Approved", "Rejected"]) }).strict().parse(input);
  const x = check(await supabaseAdmin.from("hr_exits").select("id, staff_id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; staff_id: string; status: string } | null;
  if (!x) throw new HttpError(404, "Not found."); if (x.status !== "Pending") throw new HttpError(409, "That was already decided.");
  check(await supabaseAdmin.from("hr_exits").update({ status }).eq("id", id).eq("institution_id", inst).select("id"));
  if (status === "Approved") {
    const s = (await staffMap(inst)).get(x.staff_id);
    // transport has to clear anyone whose job is on the buses, or whose record is linked to a driver or attendant
    const linked = await Promise.all((["tr_drivers", "tr_attendants"] as const).map((t) => supabaseAdmin.from(t).select("id").eq("institution_id", inst).eq("staff_id", x.staff_id).limit(1)));
    const drives = /driver|bus|attendant|transport/i.test(s?.designation ?? "") || linked.some((r) => !!r.data?.length);
    check(await supabaseAdmin.from("hr_clearance").upsert(DEPTS.map((dept) => ({ exit_id: id, dept, state: dept === "Transport" && !drives ? "n/a" : "Pending" })), { onConflict: "exit_id,dept" }).select("exit_id"));
  }
  return { ok: true };
}
export async function relieve(inst: string, id: string) {
  const x = check(await supabaseAdmin.from("hr_exits").select("id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string } | null;
  if (!x) throw new HttpError(404, "Not found."); if (x.status !== "Approved") throw new HttpError(409, "Only an approved exit can be relieved.");
  const c = check(await supabaseAdmin.from("hr_clearance").select("state").eq("exit_id", id)) as { state: string }[];
  if (c.some((y) => y.state === "Pending")) throw new HttpError(409, "Every department must clear the leaver first.");
  check(await supabaseAdmin.from("hr_exits").update({ status: "Relieved" }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true };
}
export async function clearance(inst: string) {
  const [r, st] = await Promise.all([supabaseAdmin.from("hr_exits").select("id, staff_id, last_day, status").eq("institution_id", inst).in("status", ["Approved", "Relieved"]).order("last_day"), staffMap(inst)]);
  const E = check(r) as { id: string; staff_id: string; last_day: string; status: string }[];
  const c = E.length ? (check(await supabaseAdmin.from("hr_clearance").select("exit_id, dept, state").in("exit_id", E.map((x) => x.id))) as { exit_id: string; dept: string; state: string }[]) : [];
  return { depts: DEPTS, items: E.map((x) => { const cs = c.filter((y) => y.exit_id === x.id); return { id: x.id, name: st.get(x.staff_id)?.name ?? "", designation: st.get(x.staff_id)?.designation ?? "", last_day: x.last_day, states: Object.fromEntries(DEPTS.map((d) => [d, cs.find((y) => y.dept === d)?.state ?? "Pending"])), overall: cs.length && cs.every((y) => y.state !== "Pending") ? "Cleared" : "Pending" }; }) };
}
export async function clearDept(inst: string, id: string, input: unknown) {
  const { dept } = z.object({ dept: z.enum(DEPTS) }).strict().parse(input);
  const x = check(await supabaseAdmin.from("hr_exits").select("id").eq("id", id).eq("institution_id", inst).maybeSingle());
  if (!x) throw new HttpError(404, "Not found.");
  const r = check(await supabaseAdmin.from("hr_clearance").update({ state: "Cleared" }).eq("exit_id", id).eq("dept", dept).eq("state", "Pending").select("exit_id")) as unknown[];
  if (!r.length) throw new HttpError(409, "That department is already clear or not applicable."); return { ok: true };
}
/** Pay to the last day, earned leave encashment, gratuity after 5 years, less advances. Basic is taken as half the monthly pay. */
export const NEEDS_120 = "This needs a database update (migration 120) that has not been applied yet.";
type Line = { item: string; amount: number };
/** Settlements already paid, by exit; null until migration 120 has been applied. */
async function paidSettlements(inst: string) {
  const r = await supabaseAdmin.from("hr_exits").select("id, settled_on, settled_lines, settled_net, settled_ref").eq("institution_id", inst).not("settled_on", "is", null);
  return r.error ? null : new Map((r.data as { id: string; settled_on: string; settled_lines: Line[]; settled_net: number; settled_ref: string | null }[]).map((x) => [x.id, x]));
}
export async function fullAndFinal(inst: string) {
  const paid = await paidSettlements(inst);
  // Payroll Settings > Payroll Policies: leave encashment at exit (on unless the school turns it off)
  const encash = (check(await supabaseAdmin.from("pay_settings").select("encash").eq("institution_id", inst).maybeSingle()) as { encash: boolean } | null)?.encash ?? true;
  const [c, st, bal, hs, adv] = await Promise.all([clearance(inst), directory(inst), leaveBalance(inst), supabaseAdmin.from("hr_staff").select("profile_id, monthly_salary, joined_on").eq("institution_id", inst).limit(5000), supabaseAdmin.from("staff_advances").select("staff_id, given, settled").eq("institution_id", inst)]);
  const ex = check(await supabaseAdmin.from("hr_exits").select("id, staff_id").eq("institution_id", inst).in("status", ["Approved", "Relieved"])) as { id: string; staff_id: string }[];
  const H = new Map((check(hs) as { profile_id: string; monthly_salary: number | null; joined_on: string | null }[]).map((x) => [x.profile_id, x]));
  const A = check(adv) as { staff_id: string; given: number; settled: number }[];
  return { items: c.items.map((x) => {
    const sid = ex.find((e) => e.id === x.id)!.staff_id; const h = H.get(sid); const sal = h?.monthly_salary ?? 0; const basic = sal * 0.5;
    const d = Number(x.last_day.slice(8)); const years = h?.joined_on ? Math.max(0, daysBetween(h.joined_on, x.last_day) / 365.25) : 0;
    const left = bal.items.find((b) => b.id === sid)?.earned.left ?? 0;
    const pay = Math.round((sal / 30) * Math.min(30, d)); const enc = encash ? Math.round((basic / 26) * left) : 0; const gratuity = years >= 5 ? Math.round((basic / 26) * 15 * Math.floor(years)) : 0;
    const advance = A.filter((a) => a.staff_id === sid).reduce((n, a) => n + Math.max(0, a.given - a.settled), 0);
    const month = new Date(x.last_day + "T00:00:00Z").toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" });
    const done = paid?.get(x.id);
    const out = { id: x.id, staff_id: sid, name: x.name, designation: x.designation, years: Math.round(years * 10) / 10, last_day: x.last_day, no_salary: sal === 0, paid_on: done?.settled_on ?? null, paid_ref: done?.settled_ref ?? null, lines: [{ item: `Salary for ${Math.min(30, d)} days of ${month}`, amount: pay }, { item: encash ? `Leave encashment (${left} days earned leave)` : "Leave encashment (switched off in Payroll Settings)", amount: enc }, { item: years >= 5 ? `Gratuity (${Math.floor(years)} years)` : `Gratuity (${Math.floor(years)} years, needs 5)`, amount: gratuity }, { item: "Advance recovered", amount: -advance }], net: pay + enc + gratuity - advance, status: x.overall === "Cleared" ? "Ready for Finance" : "Pending" };
    return done ? { ...out, lines: done.settled_lines, net: done.settled_net, status: "Paid" } : out;
  }), _st: st.items.length };
}

// ═════════════ Employee 360 ═════════════
export async function profile360(inst: string, id: string) {
  const s = (await staffMap(inst)).get(id); if (!s) throw new HttpError(404, "Staff member not found.");
  const ys = await yearStart(inst);
  const [h, sh, bal, cy, docs, q] = await Promise.all([supabaseAdmin.from("hr_staff").select("monthly_salary, joined_on").eq("profile_id", id).maybeSingle(), supabaseAdmin.from("hr_salary_history").select("id, from_on, before_amt, after_amt, reason").eq("staff_id", id).order("from_on", { ascending: false }), leaveBalance(inst), supabaseAdmin.from("hr_cycle").select("cycle, self_score, reviewer_score, closed, inc_pct").eq("staff_id", id).eq("closed", true).order("cycle", { ascending: false }).limit(3), supabaseAdmin.from("hr_documents").select("doc_type, file_name, valid_until, status").eq("staff_id", id), supabaseAdmin.from("hr_qualifications").select("title, year").eq("profile_id", id)]);
  const hh = check(h) as { monthly_salary: number | null; joined_on: string | null } | null; const H = check(sh) as { id: string; from_on: string; before_amt: number | null; after_amt: number; reason: string }[]; const b = bal.items.find((x) => x.id === id);
  const C = (check(cy) as { cycle: string; self_score: number | null; reviewer_score: number | null; inc_pct: number | null }[]).map((x) => { const f = Math.round(Number(x.self_score) * 30 + Number(x.reviewer_score) * 70) / 100; return { cycle: x.cycle, score: f, rating: bandOf(f).band, increment: x.inc_pct }; });
  const now = today(); const joined = hh?.joined_on ?? null;
  const timeline = [...H.map((x) => ({ on: x.from_on, title: x.before_amt ? `Salary revised ${x.after_amt >= x.before_amt ? "+" : ""}${Math.round(((x.after_amt - x.before_amt) / x.before_amt) * 100)}%` : "Joining salary", text: x.before_amt ? `₹${x.before_amt.toLocaleString("en-IN")} → ₹${x.after_amt.toLocaleString("en-IN")} a month${x.reason ? ` · ${x.reason}` : ""}` : `₹${x.after_amt.toLocaleString("en-IN")} a month` })), ...(joined ? [{ on: joined, title: `Joined as ${s.designation || "staff"}`, text: s.department }] : []), ...(check(q) as { title: string; year: number | null }[]).filter((x) => x.year).map((x) => ({ on: `${x.year}-01-01`, title: x.title, text: "Qualification" }))].sort((a, c) => (a.on < c.on ? 1 : -1));
  return { id, name: s.name, emp_code: s.emp_code, designation: s.designation, department: s.department, status: s.status, salary: hh?.monthly_salary ?? 0, joined, years: joined ? Math.floor(daysBetween(joined, now) / 365.25) : 0, leave: b ? { casual: b.casual, sick: b.sick, earned: b.earned, total_left: b.total_left } : null, year: ys.slice(0, 4), last_score: C[0]?.score ?? null, appraisals: C, salary_history: H, timeline, documents: (check(docs) as { doc_type: string; file_name: string; valid_until: string | null; status: string }[]).map((d) => ({ ...d, status: d.valid_until && d.valid_until < now ? "Expired" : d.valid_until && d.valid_until < addDays(now, 120) ? "Expiring soon" : d.status })) };
}
export async function reviseSalary(inst: string, id: string, input: unknown) {
  const i = z.object({ from_on: date, after_amt: z.number().int().min(1).max(10_000_000), reason: z.string().trim().max(120).optional() }).strict().parse(input);
  if (!(await staffMap(inst)).has(id)) throw new HttpError(404, "Staff member not found.");
  const cur = check(await supabaseAdmin.from("hr_staff").select("monthly_salary").eq("profile_id", id).maybeSingle()) as { monthly_salary: number | null } | null;
  check(await supabaseAdmin.from("hr_salary_history").insert({ institution_id: inst, staff_id: id, from_on: i.from_on, before_amt: cur?.monthly_salary ?? null, after_amt: i.after_amt, reason: i.reason ?? "" }).select("id"));
  check(await supabaseAdmin.from("hr_staff").update({ monthly_salary: i.after_amt }).eq("profile_id", id).eq("institution_id", inst).select("profile_id"));
  return { ok: true };
}

// ═════════════ analytics ═════════════
export async function analytics(inst: string) {
  const ys = await yearStart(inst); const now = today();
  const [d, ex, hs, lv] = await Promise.all([directory(inst), supabaseAdmin.from("hr_exits").select("staff_id, last_day, reason, status").eq("institution_id", inst).in("status", ["Approved", "Relieved"]), supabaseAdmin.from("hr_staff").select("profile_id, monthly_salary, joined_on").eq("institution_id", inst).limit(5000), supabaseAdmin.from("leave_requests").select("from_date, days").eq("institution_id", inst).eq("status", "Approved").gte("from_date", ys).limit(50000)]);
  const E = check(ex) as { staff_id: string; last_day: string; reason: string; status: string }[]; const H = check(hs) as { profile_id: string; monthly_salary: number | null; joined_on: string | null }[]; const L = check(lv) as { from_date: string; days: number }[];
  const months: { key: string; label: string }[] = [];
  for (let k = 0; k < 12; k++) { const dt = new Date(Date.UTC(Number(ys.slice(0, 4)), Number(ys.slice(5, 7)) - 1 + k, 1)); const key = dt.toISOString().slice(0, 7); if (key > now.slice(0, 7)) break; months.push({ key, label: dt.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }) }); }
  const active = (key: string) => H.filter((h) => (h.joined_on ?? "0000") <= `${key}-31` && !E.some((e) => e.staff_id === h.profile_id && e.status === "Relieved" && e.last_day.slice(0, 7) <= key && e.last_day.slice(0, 7) < key));
  const yearAgo = addDays(now, -365); const recent = E.filter((e) => e.last_day >= yearAgo);
  const head = d.items.length; const byDept = new Map<string, number>(); const byReason = new Map<string, number>(); const dept = new Map(d.items.map((s) => [s.id, s.department || "Other"]));
  for (const e of recent) { byDept.set(dept.get(e.staff_id) ?? "Other", (byDept.get(dept.get(e.staff_id) ?? "Other") ?? 0) + 1); byReason.set(e.reason || "Not given", (byReason.get(e.reason || "Not given") ?? 0) + 1); }
  const payroll = H.reduce((n, h) => n + (h.monthly_salary ?? 0), 0);
  return { year: ys.slice(0, 4), headcount: head, teaching: d.items.filter((s) => s.type === "Teaching").length, non_teaching: d.items.filter((s) => s.type !== "Teaching").length, exits: recent.length, attrition: head ? Math.round((recent.length / head) * 1000) / 10 : 0, payroll, leave_per_person: Math.round((L.reduce((n, l) => n + Number(l.days), 0) / Math.max(1, head) / Math.max(1, months.length)) * 10) / 10,
    headcount_by_month: months.map((m) => [m.label, active(m.key).length] as [string, number]), payroll_by_month: months.map((m) => [m.label, active(m.key).reduce((n, h) => n + (h.monthly_salary ?? 0), 0)] as [string, number]), leave_by_month: months.map((m) => [m.label, Math.round((L.filter((l) => l.from_date.startsWith(m.key)).reduce((n, l) => n + Number(l.days), 0) / Math.max(1, head)) * 10) / 10] as [string, number]),
    exits_by_dept: [...byDept.entries()].sort((a, b) => b[1] - a[1]), exit_reasons: [...byReason.entries()].sort((a, b) => b[1] - a[1]) };
}

// ═════════════ compliance ═════════════
export async function compliance(inst: string) {
  const r = check(await supabaseAdmin.from("hr_compliance").select("id, due_on, what, where_to, period, status, proof").eq("institution_id", inst).order("due_on")) as { id: string; due_on: string; what: string; where_to: string; period: string; status: string; proof: string | null }[];
  const now = today(); const soon = r.filter((x) => x.status === "Due" && x.due_on >= now && x.due_on <= addDays(now, 14)); const late = r.filter((x) => x.status === "Due" && x.due_on < now); const filed = r.filter((x) => x.status === "Filed"); const next = r.find((x) => x.status === "Due" && /24Q/.test(x.what));
  return { items: r.map((x) => ({ ...x, status: x.status === "Due" && x.due_on < now ? "Overdue" : x.status })), soon: soon.length, soon_note: soon.map((x) => x.what.split(" ")[0]).slice(0, 3).join(" and "), overdue: late.length, filed: filed.length, next_return: next ? { what: next.what, due_on: next.due_on } : null };
}
export async function seedCompliance(inst: string) {
  const have = check(await supabaseAdmin.from("hr_compliance").select("id").eq("institution_id", inst).limit(1)) as unknown[];
  if (have.length) throw new HttpError(409, "The calendar is already set up.");
  const y = new Date().getFullYear(); const rows: Record<string, unknown>[] = [];
  const mon = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  for (let k = 0; k < 12; k++) { const dt = new Date(Date.UTC(y, new Date().getMonth() + k, 1)); const yy = dt.getUTCFullYear(), mm = dt.getUTCMonth(); const per = mon(yy, mm - 1 < 0 ? 11 : mm - 1).replace(/^(.*) (\d+)$/, (_, a, b) => `${a} ${mm === 0 ? Number(b) : b}`); const p = (d: number) => `${yy}-${String(mm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    rows.push({ institution_id: inst, due_on: p(7), what: "TDS deposit", where_to: "Income Tax · Challan 281", period: per }, { institution_id: inst, due_on: p(10), what: "Professional tax", where_to: "State Commercial Taxes", period: per }, { institution_id: inst, due_on: p(15), what: "PF ECR and payment", where_to: "EPFO", period: per }, { institution_id: inst, due_on: p(15), what: "ESI contribution", where_to: "ESIC", period: per }); }
  for (const [what, to, per, dd] of [["Form 24Q · Q3 TDS return", "Income Tax · TRACES", "Oct–Dec", `${y}-01-31`], ["Form 24Q · Q4 TDS return", "Income Tax · TRACES", "Jan–Mar", `${y}-05-31`], ["Form 16 to all staff", "Income Tax", "Financial year", `${y}-06-15`], ["Labour welfare fund", "State Labour Welfare Board", String(y), `${y}-12-31`]] as string[][]) rows.push({ institution_id: inst, due_on: dd, what, where_to: to, period: per });
  check(await supabaseAdmin.from("hr_compliance").insert(rows).select("id"));
  return { added: rows.length };
}
export async function fileCompliance(inst: string, id: string, input: unknown) {
  const { proof } = z.object({ proof: z.string().trim().min(2, "Enter the challan or acknowledgement number.").max(80) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("hr_compliance").update({ status: "Filed", proof, filed_on: today() }).eq("id", id).eq("institution_id", inst).eq("status", "Due").select("id")) as unknown[];
  if (!r.length) throw new HttpError(409, "That is already filed."); return { ok: true };
}

// ═════════════ scheduled reports ═════════════
export const REPORTS = ["Monthly payroll summary", "Attendance summary", "Leave summary", "Attrition report", "Compliance due list", "Headcount report"];
export const HOW = ["Monthly · 1st at 9 am", "Weekly · Monday at 9 am", "Daily · 8 am", "Quarterly · 1st at 9 am"];
export async function scheduled(inst: string) {
  return { reports: REPORTS, how: HOW, items: check(await supabaseAdmin.from("hr_scheduled").select("id, report, how_often, send_to, format, status, last_run").eq("institution_id", inst).order("report")) as { id: string; report: string; how_often: string; send_to: string; format: string; status: string; last_run: string | null }[] };
}
export async function addScheduled(inst: string, input: unknown) {
  const i = z.object({ report: z.enum(REPORTS as [string, ...string[]]), how_often: z.enum(HOW as [string, ...string[]]), send_to: z.string().trim().min(2, "Say who gets it.").max(120), format: z.enum(["PDF", "Excel", "CSV"]) }).strict().parse(input);
  return check(await supabaseAdmin.from("hr_scheduled").insert({ institution_id: inst, ...i }).select("id").single());
}
export async function actScheduled(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["pause", "resume", "send", "remove"]) }).strict().parse(input);
  const q = supabaseAdmin.from("hr_scheduled");
  const r = (action === "remove" ? await q.delete().eq("id", id).eq("institution_id", inst).select("id") : await q.update(action === "send" ? { last_run: today() } : { status: action === "pause" ? "Paused" : "Active" }).eq("id", id).eq("institution_id", inst).select("id"));
  if (!(check(r) as unknown[]).length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ vacancies ═════════════
const STAGES = ["Requested", "Principal OK", "Approved", "Posted", "Filled"] as const;
export async function vacancies(inst: string) {
  const r = check(await supabaseAdmin.from("hr_vacancies").select("id, code, post, department, vtype, note, posts, cost_year, requested_by, requested_on, stage, need_from").eq("institution_id", inst).order("requested_on", { ascending: false }).order("code", { ascending: false })) as { id: string; code: string; post: string; department: string; vtype: string; note: string; posts: number; cost_year: number; requested_by: string; requested_on: string; stage: string; need_from: string | null }[];
  const open = r.filter((x) => ["Approved", "Posted"].includes(x.stage)); const filled = r.filter((x) => x.stage === "Filled");
  // the filled date comes with migration 119
  const fd = await supabaseAdmin.from("hr_vacancies").select("id, filled_on").eq("institution_id", inst);
  const on = new Map(((fd.data ?? []) as { id: string; filled_on: string | null }[]).map((x) => [x.id, x.filled_on]));
  const days = filled.flatMap((x) => (on.get(x.id) ? [daysBetween(x.requested_on, on.get(x.id)!)] : []));
  return { filled_this_year: filled.filter((x) => on.get(x.id)?.startsWith(today().slice(0, 4))).length, avg_days: days.length ? Math.round(days.reduce((n, d) => n + d, 0) / days.length) : null, items: r.map((x) => ({ ...x, step: x.stage === "Rejected" ? 0 : STAGES.indexOf(x.stage as (typeof STAGES)[number]) + 1 })), open: open.length, waiting: r.filter((x) => ["Requested", "Principal OK"].includes(x.stage)).length, open_cost: open.reduce((n, x) => n + x.cost_year * x.posts, 0), filled: filled.length };
}
export async function addVacancy(inst: string, input: unknown, who: string) {
  const i = z.object({ post: z.string().trim().min(2, "Enter the post.").max(100), department: z.string().trim().max(60).optional(), vtype: z.enum(["New post", "Replacement"]), note: z.string().trim().max(200).optional(), posts: z.number().int().min(1).max(50), cost_year: z.number().int().min(0).max(100_000_000), need_from: date.nullable().optional() }).strict().parse(input);
  return check(await supabaseAdmin.from("hr_vacancies").insert({ institution_id: inst, ...i, need_from: i.need_from ?? null, department: i.department ?? "", note: i.note ?? "", requested_by: who, requested_on: today() }).select("id, code").single());
}
export async function moveVacancy(inst: string, id: string, input: unknown, role: string) {
  const { action } = z.object({ action: z.enum(["approve", "reject", "post", "fill"]) }).strict().parse(input);
  const v = check(await supabaseAdmin.from("hr_vacancies").select("id, stage").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; stage: string } | null;
  if (!v) throw new HttpError(404, "Not found.");
  const top = ["Principal", "InstitutionAdmin"].includes(role);
  let next: string;
  if (action === "approve") { if (v.stage === "Requested") next = "Principal OK"; else if (v.stage === "Principal OK") next = "Approved"; else throw new HttpError(409, "Nothing to approve."); if (next === "Principal OK" && !top) throw new HttpError(403, "The Principal approves first."); if (next === "Approved" && !["Accountant", "Finance", ...["Principal", "InstitutionAdmin"]].includes(role)) throw new HttpError(403, "Finance approves next."); }
  else if (action === "reject") { if (role === "HR") throw new HttpError(403, "The Principal or Finance rejects a vacancy."); if (!["Requested", "Principal OK"].includes(v.stage)) throw new HttpError(409, "Too late to reject."); next = "Rejected"; }
  else if (action === "post") { if (v.stage !== "Approved") throw new HttpError(409, "Approve it first."); next = "Posted"; }
  else { if (v.stage !== "Posted") throw new HttpError(409, "Post it first."); next = "Filled"; }
  check(await supabaseAdmin.from("hr_vacancies").update({ stage: next }).eq("id", id).eq("institution_id", inst).select("id"));
  // ignored until migration 119 adds the column
  if (next === "Filled") await supabaseAdmin.from("hr_vacancies").update({ filled_on: today() }).eq("id", id).eq("institution_id", inst);
  return { stage: next };
}
export async function sanctioned(inst: string) {
  const [r, d, ex] = await Promise.all([supabaseAdmin.from("hr_sanctioned").select("id, department, designation, sanctioned").eq("institution_id", inst).order("department").order("designation"), directory(inst), supabaseAdmin.from("hr_exits").select("staff_id").eq("institution_id", inst).in("status", ["Pending", "Approved"])]);
  const N = new Set((check(ex) as { staff_id: string }[]).map((x) => x.staff_id));
  const items = (check(r) as { id: string; department: string; designation: string; sanctioned: number }[]).map((x) => { const f = d.items.filter((s) => s.department.toLowerCase() === x.department.toLowerCase() && s.designation.toLowerCase() === x.designation.toLowerCase()); return { ...x, filled: f.length, vacant: Math.max(0, x.sanctioned - f.length), notice: f.filter((s) => N.has(s.id)).length }; });
  const s = items.reduce((n, x) => n + x.sanctioned, 0); const f = items.reduce((n, x) => n + Math.min(x.filled, x.sanctioned), 0);
  return { items, sanctioned: s, filled: f, vacant: s - f, notice: items.reduce((n, x) => n + x.notice, 0) };
}
export async function addSanctioned(inst: string, input: unknown) {
  const i = z.object({ department: z.string().trim().min(2).max(60), designation: z.string().trim().min(2).max(100), sanctioned: z.number().int().min(0).max(1000) }).strict().parse(input);
  check(await supabaseAdmin.from("hr_sanctioned").upsert({ institution_id: inst, ...i }, { onConflict: "institution_id,department,designation" }).select("id"));
  return { ok: true };
}

// ═════════════ final settlement payment ═════════════
/** Accounts records that a cleared leaver's settlement was paid. The working is kept as it was on that day. */
export async function paySettlement(inst: string, id: string, input: unknown, role: string, actor?: string) {
  const i = z.object({ tds: z.number().int().min(0).max(100_000_000), reference: z.string().trim().min(2, "Enter the payment reference.").max(80) }).strict().parse(input);
  if (!["Accountant", "Finance", "Principal", "InstitutionAdmin"].includes(role)) throw new HttpError(403, "Only accounts or the principal can pay a final settlement.");
  if (!(await paidSettlements(inst))) throw new HttpError(409, NEEDS_120);
  const x = (await fullAndFinal(inst)).items.find((s) => s.id === id);
  if (!x) throw new HttpError(404, "Settlement not found.");
  if (actor && x.staff_id === actor) throw new HttpError(403, "Someone else has to pay your own settlement.");
  if (x.status === "Paid") throw new HttpError(409, "That settlement is already paid.");
  if (x.status !== "Ready for Finance") throw new HttpError(409, "Every department must clear the leaver first.");
  if (i.tds > x.net) throw new HttpError(400, "The tax is more than the amount payable.");
  const r = check(await supabaseAdmin.from("hr_exits").update({ settled_on: today(), settled_lines: [...x.lines, { item: "TDS", amount: -i.tds }], settled_net: x.net - i.tds, settled_ref: i.reference, settled_by: actor ?? null }).eq("id", id).eq("institution_id", inst).is("settled_on", null).select("id")) as unknown[];
  if (!r.length) throw new HttpError(409, "That settlement is already paid.");
  return { ok: true, net: x.net - i.tds };
}

// ═════════════ exit interviews ═════════════
export async function exitInterviews(inst: string) {
  const ys = await yearStart(inst);
  const [x, st, hs, iv] = await Promise.all([supabaseAdmin.from("hr_exits").select("id, staff_id, last_day, reason, status").eq("institution_id", inst).in("status", ["Approved", "Relieved"]).order("last_day", { ascending: false }).limit(2000), directory(inst), supabaseAdmin.from("hr_staff").select("profile_id, joined_on").eq("institution_id", inst).limit(5000), supabaseAdmin.from("hr_exit_interviews").select("exit_id, reason, would_rejoin, said").eq("institution_id", inst)]);
  const E = check(x) as { id: string; staff_id: string; last_day: string; reason: string; status: string }[];
  const S = new Map(st.items.map((s) => [s.id, s])); const J = new Map((check(hs) as { profile_id: string; joined_on: string | null }[]).map((r) => [r.profile_id, r.joined_on]));
  const I = new Map(((iv.error ? [] : iv.data) as { exit_id: string; reason: string; would_rejoin: boolean; said: string }[]).map((r) => [r.exit_id, r]));
  const year = E.filter((e) => e.last_day >= ys);
  const count = new Map<string, number>(); for (const e of year) { const why = I.get(e.id)?.reason || e.reason || "Not given"; count.set(why, (count.get(why) ?? 0) + 1); }
  const reasons = [...count.entries()].sort((a, b) => b[1] - a[1]);
  const answered = year.flatMap((e) => (I.has(e.id) ? [I.get(e.id)!] : []));
  const spans = year.flatMap((e) => (J.get(e.staff_id) ? [daysBetween(J.get(e.staff_id)!, e.last_day) / 365.25] : []));
  const active = st.items.filter((s) => s.status === "Active").length;
  return {
    ready: !iv.error, year: `${ys.slice(0, 4)}–${String(Number(ys.slice(0, 4)) + 1).slice(2)}`, exits: year.length,
    attrition: active + year.length ? Math.round((year.length / (active + year.length)) * 1000) / 10 : 0,
    would_rejoin: answered.length ? Math.round((answered.filter((a) => a.would_rejoin).length / answered.length) * 100) : null,
    avg_years: spans.length ? Math.round((spans.reduce((n, v) => n + Math.max(0, v), 0) / spans.length) * 10) / 10 : null,
    reasons,
    items: E.map((e) => { const a = I.get(e.id); return { id: e.id, staff_id: e.staff_id, name: S.get(e.staff_id)?.name ?? "", designation: S.get(e.staff_id)?.designation ?? "", reason: a?.reason || e.reason, status: a ? "Closed" : "Pending", would_rejoin: a ? a.would_rejoin : null, said: a?.said ?? "" }; }),
  };
}
export async function saveExitInterview(inst: string, id: string, input: unknown, actor?: string) {
  const i = z.object({ reason: z.string().trim().min(2, "Enter the reason.").max(80), would_rejoin: z.boolean(), said: z.string().trim().max(500).optional() }).strict().parse(input);
  const x = check(await supabaseAdmin.from("hr_exits").select("id, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string } | null;
  if (!x) throw new HttpError(404, "Not found.");
  if (!["Approved", "Relieved"].includes(x.status)) throw new HttpError(409, "Approve the exit first.");
  const r = await supabaseAdmin.from("hr_exit_interviews").upsert({ exit_id: id, institution_id: inst, reason: i.reason, would_rejoin: i.would_rejoin, said: i.said ?? "", recorded_on: today(), recorded_by: actor ?? null }, { onConflict: "exit_id" }).select("exit_id");
  if (r.error && ["42P01", "PGRST205"].includes(r.error.code)) throw new HttpError(409, NEEDS_120);
  check(r); return { ok: true };
}

// ═════════════ exit letters ═════════════
export async function exitLetters(inst: string) {
  const [f, hs, sc, st] = await Promise.all([fullAndFinal(inst), supabaseAdmin.from("hr_staff").select("profile_id, joined_on").eq("institution_id", inst).limit(5000), supabaseAdmin.from("institutions").select("name, address").eq("id", inst).maybeSingle(), directory(inst)]);
  const J = new Map((check(hs) as { profile_id: string; joined_on: string | null }[]).map((r) => [r.profile_id, r.joined_on])); const s = sc.data as { name: string; address: string | null } | null;
  return { school: s?.name ?? "", address: s?.address ?? "", principal: st.items.find((x) => x.designation === "Principal")?.name ?? "", items: f.items.map((x) => ({ id: x.id, name: x.name, designation: x.designation, joined_on: J.get(x.staff_id) ?? null, last_day: x.last_day, settlement: x.status === "Paid" ? "Paid" : "Pending", can_issue: x.status === "Paid" && x.last_day <= today() })) };
}
