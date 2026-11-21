import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { roster } from "./student-mgmt.service";
import { everyone } from "./fees2.service";
import { directory } from "./hr.service";
import { listCurriculum } from "./academic2.service";

/** Report summaries that need a calculation across several tables. Plain lists reuse the existing endpoints. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const tally = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]) as [string, number][]; };

export async function studentStrength(inst: string) {
  const r = await roster(inst); const act = r.items.filter((x) => x.status === "Enrolled" || x.enrol_status === "Enrolled");
  return { year: r.year?.name ?? "", by_class: tally(act.map((x) => x.class_name)).sort((a, b) => (act.find((x) => x.class_name === a[0])?.sort ?? 0) - (act.find((x) => x.class_name === b[0])?.sort ?? 0)) };
}
export async function syllabusSummary(inst: string) {
  const c = (await listCurriculum(inst)) as { items: { subject?: string; status: string; class_name?: string; chapter?: string; periods?: number; objective?: string; planned_month?: string }[] } | unknown;
  const items = ((c as { items?: unknown[] }).items ?? []) as Record<string, unknown>[];
  const by = new Map<string, { n: number; done: number }>(); for (const x of items) { const s = String(x.subject ?? ""); const o = by.get(s) ?? { n: 0, done: 0 }; o.n++; if (x.status === "Completed") o.done++; by.set(s, o); }
  const done = items.filter((x) => x.status === "Completed").length;
  return { chapters: items.length, completed: done, pct: items.length ? Math.round((done / items.length) * 100) : null, by_subject: [...by.entries()].map(([s, o]) => [s, Math.round((o.done / o.n) * 100)] as [string, number]).sort((a, b) => b[1] - a[1]), counts: tally(items.map((x) => String(x.subject ?? ""))) };
}
export async function staffMonth(inst: string) {
  const t = today(); const ms = `${t.slice(0, 7)}-01`; const [d, a] = await Promise.all([directory(inst), supabaseAdmin.from("staff_attendance").select("staff_id, status, att_date").eq("institution_id", inst).gte("att_date", ms).limit(100000)]);
  const A = check(a) as { staff_id: string; status: string }[];
  return { month: new Date(`${t}T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }), items: d.items.map((s) => { const m = A.filter((x) => x.staff_id === s.id); const n = (c: string) => m.filter((x) => x.status === c).length; return { id: s.id, name: s.name, emp_code: s.emp_code, department: s.department, present: n("P") + n("L"), leave: n("V"), absent: n("A"), late: n("L") }; }) };
}
export async function hrStrength(inst: string) {
  const t = today(); const [d, a, q] = await Promise.all([directory(inst), supabaseAdmin.from("staff_attendance").select("staff_id, status").eq("institution_id", inst).eq("att_date", t), supabaseAdmin.from("staff_qualifications").select("title, profile_id, p:profile_id!inner(institution_id)").eq("p.institution_id", inst).limit(20000)]);
  const A = check(a) as { staff_id: string; status: string }[]; const Q = check(q) as unknown as { title: string; profile_id: string }[]; const ro = await roster(inst);
  const tw = d.items.filter((x) => x.type === "Teaching").length; const pre = A.filter((x) => x.status === "P" || x.status === "L").length; const lv = A.filter((x) => x.status === "V").map((x) => d.items.find((s) => s.id === x.staff_id)?.type);
  const qual = (title: string) => (/ph\.?d|post|m\.?a|m\.?sc|m\.?com|m\.?ed|mba|m\.?tech/i.test(title) ? "Post-graduate" : /b\.?ed|b\.?a|b\.?sc|b\.?com|b\.?tech|graduate/i.test(title) ? "Graduate" : /d\.?el|ntt|diploma/i.test(title) ? "Diploma / NTT" : "Other");
  const best = new Map<string, string>(); const rank = ["Post-graduate", "Graduate", "Diploma / NTT", "Other"]; for (const x of Q) { const k = qual(x.title); const cur = best.get(x.profile_id); if (!cur || rank.indexOf(k) < rank.indexOf(cur)) best.set(x.profile_id, k); }
  return { total: d.items.length, present_today: pre, teaching: tw, non_teaching: d.items.length - tw, ratio: tw ? Math.round(ro.items.filter((x) => x.status === "Enrolled" || x.enrol_status === "Enrolled").length / tw) : null, leave_today: lv.length, leave_teaching: lv.filter((x) => x === "Teaching").length, by_department: tally(d.items.map((x) => x.department || "—")), by_qualification: tally(d.items.map((x) => best.get(x.id) ?? "")), staff: d.items };
}
export async function feeSummary(inst: string) {
  const [e, p, l] = await Promise.all([everyone(inst), supabaseAdmin.from("fee_payments").select("total, mode, status").eq("institution_id", inst).limit(100000), supabaseAdmin.from("fee_payment_lines").select("label, amount, p:payment_id!inner(institution_id, status)").eq("p.institution_id", inst).limit(300000)]);
  const P = (check(p) as { total: number; mode: string; status: string }[]).filter((x) => x.status === "Paid"); const L = (check(l) as unknown as { label: string; amount: number; p: { status: string } | { status: string }[] }[]).filter((x) => (Array.isArray(x.p) ? x.p[0]?.status : x.p?.status) === "Paid");
  const collected = P.reduce((n, x) => n + x.total, 0); const pending = e.rows.reduce((n, x) => n + x.due, 0); const over = e.rows.filter((x) => x.days_overdue > 0);
  const sumBy = <T,>(xs: T[], k: (x: T) => string, v: (x: T) => number) => { const m = new Map<string, number>(); for (const x of xs) m.set(k(x), (m.get(k(x)) ?? 0) + v(x)); return [...m.entries()].sort((a, b) => b[1] - a[1]) as [string, number][]; };
  return { billed: collected + pending, collected, pending, overdue: over.reduce((n, x) => n + x.due, 0), overdue_students: over.length, students: e.rows.length, by_mode: sumBy(P, (x) => x.mode, (x) => x.total), by_head: sumBy(L, (x) => x.label, (x) => x.amount), pending_by_class: sumBy(e.rows, (x) => x.class_label.replace(/ [A-Z]$/, ""), (x) => x.due) };
}
export async function admissionReport(inst: string) {
  const r = check(await supabaseAdmin.from("adm_applications").select("id, code, child, class_sought, parent_name, mobile, source, applied_on, status").eq("institution_id", inst).order("applied_on", { ascending: false }).limit(3000)) as { id: string; code: string; child: string; class_sought: string; parent_name: string; mobile: string | null; source: string; applied_on: string; status: string }[];
  return { items: r.map((x) => ({ ...x, mobile: x.mobile ? `${x.mobile.slice(0, 6)}****${x.mobile.slice(-2)}` : "" })) };
}
