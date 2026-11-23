import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { everyone } from "../school/fees2.service";
import { yearStart } from "../school/fees.service";

/** Finance reports for the whole school: demand, collection and outstanding by class group, and collection by fee category. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const GROUPS: [string, (n: number | null, label: string) => boolean][] = [
  ["Nursery – UKG", (n, l) => n === null && /nursery|lkg|ukg|pre/i.test(l)], ["Classes 1 – 5", (n) => n !== null && n >= 1 && n <= 5], ["Classes 6 – 8", (n) => n !== null && n >= 6 && n <= 8],
  ["Classes 9 – 10", (n) => n !== null && n >= 9 && n <= 10], ["Classes 11 – 12", (n) => n !== null && n >= 11 && n <= 12],
];
const classNo = (label: string) => { const m = label.match(/(?:class|grade)?\s*(\d{1,2})\b/i); return m ? Number(m[1]) : null; };

export async function classWise(inst: string) {
  const now = today(); const ov = await everyone(inst);
  const rows = GROUPS.map(([name]) => ({ name, demand: 0, collected: 0, outstanding: 0 })); const other = { name: "Other classes", demand: 0, collected: 0, outstanding: 0 };
  for (const d of ov.detail) {
    const n = classNo(d.class_label); const i = GROUPS.findIndex(([, f]) => f(n, d.class_label)); const r = i >= 0 ? rows[i] : other;
    for (const t of d.terms) if (t.date <= now) { r.demand += t.amount; r.collected += Math.min(t.paid, t.amount); r.outstanding += t.due; }
  }
  const items = [...rows, other].filter((r) => r.demand > 0 || r.collected > 0);
  return { as_on: now, year_start: await yearStart(inst), students: ov.agg.students, items, total: items.reduce((a, r) => ({ demand: a.demand + r.demand, collected: a.collected + r.collected, outstanding: a.outstanding + r.outstanding }), { demand: 0, collected: 0, outstanding: 0 }) };
}

const LABEL: Record<string, string> = { fees: "Tuition and school fees", transport: "Transport", hostel: "Hostel", late: "Late fees" };
export async function categoryWise(inst: string) {
  const ys = await yearStart(inst);
  const rows: { line_key: string; amount: number }[] = [];
  for (let a = 0; ; a += 1000) { const r = check(await supabaseAdmin.from("fee_payment_lines").select("line_key, amount, fee_payments:payment_id!inner(institution_id, status, paid_on)").eq("fee_payments.institution_id", inst).eq("fee_payments.status", "Paid").gte("fee_payments.paid_on", ys).range(a, a + 999)) as unknown as { line_key: string; amount: number }[]; rows.push(...r); if (r.length < 1000) break; }
  const m = new Map<string, number>(); for (const r of rows) { const k = LABEL[r.line_key.split(":")[1]] ?? "Other"; m.set(k, (m.get(k) ?? 0) + r.amount); }
  const total = [...m.values()].reduce((n, v) => n + v, 0);
  return { year_start: ys, total, items: [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, collected]) => ({ name, collected, share: total ? Math.round((collected / total) * 100) : 0 })) };
}
