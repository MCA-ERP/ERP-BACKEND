import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { items } from "./lib2.service";
import { orders } from "./inv.service";

/** Inventory, part 2: vendor checks and scorecards, quotations, three-way invoice matching and the school store. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const GST = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/; const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** GSTIN format plus its check character (base-36 weighted sum). */
export function gstValid(g: string) {
  if (!GST.test(g)) return false; const c = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; let sum = 0;
  for (let i = 0; i < 14; i++) { const v = c.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(v / 36) + (v % 36); }
  return c[(36 - (sum % 36)) % 36] === g[14];
}

// ═════════════ vendor onboarding and scorecards ═════════════
export async function vendors(inst: string) {
  const s = check(await supabaseAdmin.from("inv_suppliers").select("id, name, supplies, gstin, pan, bank_account, ifsc, msme, bank_status, vendor_status, rating").eq("institution_id", inst).order("name")) as { id: string; name: string; supplies: string; gstin: string; pan: string; bank_account: string; ifsc: string; msme: string; bank_status: string; vendor_status: string; rating: number | null }[];
  return { items: s.map((x) => ({ ...x, gst_ok: gstValid(x.gstin), pan_ok: PAN.test(x.pan), bank_details: !!(x.bank_account && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(x.ifsc)) })) };
}
export async function saveVendor(inst: string, id: string, input: unknown) {
  const i = z.object({ pan: z.string().trim().toUpperCase().regex(/^([A-Z]{5}[0-9]{4}[A-Z])?$/, "PAN looks like ABCDE1234F.").optional(), bank_account: z.string().trim().regex(/^(\d{6,20})?$/, "Account numbers are 6 to 20 digits.").optional(), ifsc: z.string().trim().toUpperCase().regex(/^([A-Z]{4}0[A-Z0-9]{6})?$/, "IFSC looks like HDFC0001234.").optional(), msme: z.string().trim().max(30).optional(), rating: z.number().min(1).max(5).nullable().optional() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("inv_suppliers").update({ ...i, ...(i.bank_account !== undefined || i.ifsc !== undefined ? { bank_status: "Pending" } : {}) }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function vendorAction(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["bank_check", "verify", "reject", "blacklist", "reinstate"]) }).strict().parse(input);
  const v = (await vendors(inst)).items.find((x) => x.id === id); if (!v) throw new HttpError(404, "Not found.");
  const upd = async (row: object) => { check(await supabaseAdmin.from("inv_suppliers").update(row).eq("id", id).eq("institution_id", inst).select("id")); return { ok: true }; };
  if (action === "bank_check") { if (!v.bank_details) throw new HttpError(409, "Add a valid account number and IFSC first."); return upd({ bank_status: "Verified" }); }
  if (action === "verify") { if (!v.gst_ok || !v.pan_ok || v.bank_status !== "Verified") throw new HttpError(409, "GSTIN, PAN and the bank account must all be valid first."); return upd({ vendor_status: "Verified" }); }
  if (action === "reject") return upd({ vendor_status: "Rejected" });
  if (action === "blacklist") return upd({ vendor_status: "Blacklisted" });
  return upd({ vendor_status: "Pending checks" });
}
export async function scorecards(inst: string) {
  const [v, o, g] = await Promise.all([vendors(inst), supabaseAdmin.from("inv_pos").select("id, supplier_id, delivery_by").eq("institution_id", inst).in("status", ["Partly received", "Received"]), supabaseAdmin.from("inv_grns").select("po_id, received_on").eq("institution_id", inst)]);
  const O = check(o) as { id: string; supplier_id: string; delivery_by: string | null }[]; const G = check(g) as { po_id: string | null; received_on: string }[];
  return { items: v.items.filter((x) => x.vendor_status !== "Rejected").map((x) => { const mine = O.filter((p) => p.supplier_id === x.id && p.delivery_by); const done = mine.filter((p) => G.some((r) => r.po_id === p.id)); const on = done.filter((p) => G.filter((r) => r.po_id === p.id).every((r) => r.received_on <= p.delivery_by!)).length; const pct = done.length ? Math.round((on / done.length) * 100) : null; return { id: x.id, name: x.name, orders: done.length, on_time: pct, rating: x.rating, status: x.vendor_status === "Blacklisted" ? "Blacklisted" : pct !== null && pct < 85 ? "At risk" : "Approved" }; }) };
}

// ═════════════ quotations ═════════════
const score = (q: { total: number; delivery: number; rating: number }, min: { total: number; delivery: number }) => Math.round(((min.total / q.total) * 50) + ((min.delivery > 0 ? min.delivery / Math.max(q.delivery, 1) : 1) * 25) + (q.rating / 5) * 25);
export async function rfqs(inst: string) {
  const [r, q, it, v] = await Promise.all([supabaseAdmin.from("inv_rfqs").select("id, code, item_id, qty, closes_on, status, award_reason, po_id").eq("institution_id", inst).order("code", { ascending: false }), supabaseAdmin.from("inv_quotes").select("id, rfq_id, supplier_id, unit_price, delivery_days, warranty, terms, r:rfq_id!inner(institution_id)").eq("r.institution_id", inst), items(inst), vendors(inst)]);
  const Q = check(q) as unknown as { id: string; rfq_id: string; supplier_id: string; unit_price: number; delivery_days: number; warranty: string; terms: string }[]; const I = new Map(it.items.map((x) => [x.id, x]));
  return { items_list: it.items.map((x) => ({ id: x.id, name: x.name })), vendors: v.items.filter((x) => x.vendor_status === "Verified").map((x) => ({ id: x.id, name: x.name })), items: (check(r) as { id: string; code: string; item_id: string; qty: number; closes_on: string; status: string; award_reason: string | null; po_id: string | null }[]).map((x) => {
    const qs = Q.filter((y) => y.rfq_id === x.id).map((y) => { const vn = v.items.find((z) => z.id === y.supplier_id); return { ...y, vendor: vn?.name ?? "", total: y.unit_price * x.qty, rating: vn?.rating ?? 3 }; });
    const min = { total: Math.min(...qs.map((y) => y.total), Infinity), delivery: Math.min(...qs.map((y) => y.delivery_days), Infinity) }; const scored = qs.map((y) => ({ ...y, score: score({ total: y.total, delivery: y.delivery_days, rating: y.rating }, min), l1: y.total === min.total })).sort((a, b) => b.score - a.score);
    const low = [...qs].sort((a, b) => a.total - b.total)[0];
    return { ...x, item: I.get(x.item_id)?.name ?? "", quotes: scored.map((y, k) => ({ ...y, recommended: k === 0 })), count: qs.length, lowest: low ? `${low.vendor} · ${low.unit_price}` : "—", state: x.status === "Awarded" ? "Awarded" : qs.length ? "Quotes in" : "Open" };
  }) };
}
export async function addRfq(inst: string, input: unknown) {
  const i = z.object({ item_id: uid, qty: z.number().int().min(1).max(1_000_000), closes_on: date }).strict().parse(input);
  if (!(await items(inst)).items.some((x) => x.id === i.item_id)) throw new HttpError(404, "Item not found.");
  return check(await supabaseAdmin.from("inv_rfqs").insert({ institution_id: inst, ...i }).select("id, code").single());
}
export async function addQuote(inst: string, input: unknown) {
  const i = z.object({ rfq_id: uid, supplier_id: uid, unit_price: z.number().int().min(1).max(10_000_000), delivery_days: z.number().int().min(0).max(365), warranty: z.string().trim().max(30).optional(), terms: z.string().trim().max(40).optional() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("inv_rfqs").select("id, status").eq("id", i.rfq_id).eq("institution_id", inst).maybeSingle()) as { id: string; status: string } | null; if (!r) throw new HttpError(404, "RFQ not found."); if (r.status === "Awarded") throw new HttpError(409, "That RFQ is already awarded.");
  const v = (await vendors(inst)).items.find((x) => x.id === i.supplier_id); if (!v) throw new HttpError(404, "Vendor not found."); if (v.vendor_status !== "Verified") throw new HttpError(409, "Only verified vendors can be asked for quotes.");
  if ((check(await supabaseAdmin.from("inv_quotes").select("id").eq("rfq_id", i.rfq_id).eq("supplier_id", i.supplier_id)) as unknown[]).length) throw new HttpError(409, "That vendor has already quoted.");
  return check(await supabaseAdmin.from("inv_quotes").insert({ ...i, warranty: i.warranty ?? "", terms: i.terms ?? "" }).select("id").single());
}
export async function award(inst: string, rfqId: string, input: unknown) {
  const i = z.object({ quote_id: uid, reason: z.string().trim().max(200).optional() }).strict().parse(input);
  const r = (await rfqs(inst)).items.find((x) => x.id === rfqId); if (!r) throw new HttpError(404, "RFQ not found."); if (r.status === "Awarded") throw new HttpError(409, "Already awarded.");
  const q = r.quotes.find((x) => x.id === i.quote_id); if (!q) throw new HttpError(404, "Quote not found.");
  if (q.total > 25000 && r.count < 3) throw new HttpError(409, "Purchases above ₹25,000 need at least three quotes.");
  if (!q.l1 && !i.reason) throw new HttpError(400, "Awarding to a vendor other than the lowest price needs a reason.");
  const po = check(await supabaseAdmin.from("inv_pos").insert({ institution_id: inst, supplier_id: q.supplier_id, delivery_by: new Date(Date.now() + q.delivery_days * 86400000).toISOString().slice(0, 10) }).select("id, code").single()) as { id: string; code: string };
  check(await supabaseAdmin.from("inv_po_lines").insert({ po_id: po.id, item_id: r.item_id, qty: r.qty, price: q.unit_price }).select("po_id"));
  check(await supabaseAdmin.from("inv_rfqs").update({ status: "Awarded", award_reason: i.reason ?? null, po_id: po.id }).eq("id", rfqId).eq("institution_id", inst).select("id")); return { po: po.code };
}

// ═════════════ three-way match ═════════════
export async function bills(inst: string) {
  const [b, o, g, gl] = await Promise.all([supabaseAdmin.from("inv_bills").select("id, po_id, bill_no, amount, billed_on, decision, pay_amount").eq("institution_id", inst).order("billed_on", { ascending: false }), orders(inst), supabaseAdmin.from("inv_grns").select("id, code, po_id").eq("institution_id", inst), supabaseAdmin.from("inv_grn_lines").select("grn_id, qty, price, g:grn_id!inner(institution_id)").eq("g.institution_id", inst)]);
  const G = check(g) as { id: string; code: string; po_id: string | null }[]; const L = check(gl) as unknown as { grn_id: string; qty: number; price: number }[]; const ms = today().slice(0, 7);
  const rows = (check(b) as { id: string; po_id: string; bill_no: string; amount: number; billed_on: string; decision: string; pay_amount: number | null }[]).map((x) => {
    const po = o.items.find((y) => y.id === x.po_id); const gs = G.filter((y) => y.po_id === x.po_id); const received = L.filter((l) => gs.some((y) => y.id === l.grn_id)).reduce((n, l) => n + l.qty * l.price, 0); const ordered = po?.amount ?? 0;
    const result = received < ordered && x.amount > received ? "Quantity short" : x.amount !== ordered ? "Price differs" : received < ordered ? "Part order billed" : "Matched";
    return { id: x.id, po: po?.code ?? "", po_id: x.po_id, vendor: po?.supplier ?? "", grn: gs.map((y) => y.code).join(", ") || "—", bill_no: x.bill_no, ordered, received, billed: x.amount, result, decision: x.decision, billed_on: x.billed_on, pay_amount: x.pay_amount };
  });
  const month = rows.filter((x) => x.billed_on.startsWith(ms));
  return { orders: o.items.filter((x) => ["Partly received", "Received"].includes(x.status)).map((x) => ({ id: x.id, name: `${x.code} · ${x.supplier}` })), items: rows, month: month.length, matched: month.filter((x) => x.result === "Matched").length, held: rows.filter((x) => x.decision === "Held" || (x.decision === "Open" && x.result !== "Matched")).length, saved: rows.filter((x) => x.decision === "Held" || x.pay_amount !== null).reduce((n, x) => n + Math.max(0, x.billed - (x.pay_amount ?? x.received)), 0) };
}
export async function addBill(inst: string, input: unknown) {
  const i = z.object({ po_id: uid, bill_no: z.string().trim().min(1, "Enter the bill number.").max(30), amount: z.number().int().min(1).max(100_000_000) }).strict().parse(input);
  if (!check(await supabaseAdmin.from("inv_pos").select("id").eq("id", i.po_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Order not found.");
  if ((check(await supabaseAdmin.from("inv_bills").select("id").eq("institution_id", inst).eq("bill_no", i.bill_no)) as unknown[]).length) throw new HttpError(409, "That bill number is already recorded.");
  return check(await supabaseAdmin.from("inv_bills").insert({ institution_id: inst, ...i, billed_on: today() }).select("id").single());
}
export async function decideBill(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["send", "hold", "pay_received"]) }).strict().parse(input);
  const b = (await bills(inst)).items.find((x) => x.id === id); if (!b) throw new HttpError(404, "Not found."); if (b.decision !== "Open" && b.decision !== "Held") throw new HttpError(409, "Already decided.");
  if (action === "send" && b.result !== "Matched") throw new HttpError(409, "Only matched bills go for payment.");
  check(await supabaseAdmin.from("inv_bills").update(action === "hold" ? { decision: "Held" } : { decision: "Sent for payment", pay_amount: action === "pay_received" ? b.received : b.billed }).eq("id", id).eq("institution_id", inst).select("id")); return { ok: true };
}

// ═════════════ school store ═════════════
export async function storeReport(inst: string) {
  const now = today(); const ys = `${Number(now.slice(5, 7)) >= 4 ? now.slice(0, 4) : Number(now.slice(0, 4)) - 1}-04-01`;
  const [b, l, it, ro] = await Promise.all([supabaseAdmin.from("store_bills").select("id, code, student_id, amount, paid_by, sold_at, sold_on").eq("institution_id", inst).order("sold_on", { ascending: false }).order("code", { ascending: false }).limit(5000), supabaseAdmin.from("store_bill_lines").select("bill_id, item_id, qty, price, b:bill_id!inner(institution_id)").eq("b.institution_id", inst), items(inst), roster(inst)]);
  const B = check(b) as { id: string; code: string; student_id: string | null; amount: number; paid_by: string; sold_at: string; sold_on: string }[]; const L = check(l) as unknown as { bill_id: string; item_id: string; qty: number; price: number }[]; const K = new Map(ro.items.map((x) => [x.id, x])); const I = new Map(it.items.map((x) => [x.id, x]));
  const yr = B.filter((x) => x.sold_on >= ys); const months: [string, number][] = [];
  for (let k = 0; k < 12; k++) { const d = new Date(Date.UTC(Number(ys.slice(0, 4)), 3 + k, 1)); const key = d.toISOString().slice(0, 7); if (key > now.slice(0, 7)) break; months.push([d.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), yr.filter((x) => x.sold_on.startsWith(key)).reduce((n, x) => n + x.amount, 0)]); }
  const sold = new Map<string, number>(); for (const x of L) if (yr.some((y) => y.id === x.bill_id)) sold.set(x.item_id, (sold.get(x.item_id) ?? 0) + x.qty);
  return { students: ro.items.filter((x) => x.status === "Enrolled").map((x) => ({ id: x.id, name: `${x.name} · ${x.class_label}` })), items_list: it.items.map((x) => ({ id: x.id, name: x.name, price: x.unit_price, in_stock: x.in_stock })), year_total: yr.reduce((n, x) => n + x.amount, 0), year_bills: yr.length, month_total: yr.filter((x) => x.sold_on.startsWith(now.slice(0, 7))).reduce((n, x) => n + x.amount, 0), month_bills: yr.filter((x) => x.sold_on.startsWith(now.slice(0, 7))).length, stock_value: it.items.reduce((n, x) => n + x.in_stock * x.unit_price, 0), low: it.items.filter((x) => x.in_stock <= x.reorder_at).length, by_month: months, fast: [...sold.entries()].map(([id, q]) => [I.get(id)?.name ?? "", q] as [string, number]).sort((a, b2) => b2[1] - a[1]).slice(0, 5),
    bills: B.slice(0, 50).map((x) => ({ ...x, student: x.student_id ? K.get(x.student_id)?.name ?? "" : "Walk-in", class_label: x.student_id ? K.get(x.student_id)?.class_label ?? "" : "", items: L.filter((y) => y.bill_id === x.id).map((y) => `${I.get(y.item_id)?.name ?? ""} × ${y.qty}`).join("; ") })) };
}
export async function addStoreBill(inst: string, input: unknown) {
  const i = z.object({ student_id: uid.nullable().optional(), paid_by: z.enum(["Cash", "UPI", "Card", "Online"]), sold_at: z.enum(["Counter", "Parent app"]), lines: z.array(z.object({ item_id: uid, qty: z.number().int().min(1).max(10000) }).strict()).min(1, "Add at least one item.").max(30) }).strict().parse(input);
  const it = new Map((await items(inst)).items.map((x) => [x.id, x])); if (i.lines.some((l) => !it.has(l.item_id))) throw new HttpError(404, "Item not found."); if (new Set(i.lines.map((l) => l.item_id)).size !== i.lines.length) throw new HttpError(400, "An item is listed twice.");
  for (const l of i.lines) if (it.get(l.item_id)!.in_stock < l.qty) throw new HttpError(409, `Only ${it.get(l.item_id)!.in_stock} of ${it.get(l.item_id)!.name} in stock.`);
  if (i.student_id && !(await roster(inst)).items.some((x) => x.id === i.student_id)) throw new HttpError(404, "Student not found.");
  const amount = i.lines.reduce((n, l) => n + l.qty * it.get(l.item_id)!.unit_price, 0);
  const b = check(await supabaseAdmin.from("store_bills").insert({ institution_id: inst, student_id: i.student_id ?? null, amount, paid_by: i.paid_by, sold_at: i.sold_at, sold_on: today() }).select("id, code").single()) as { id: string; code: string };
  check(await supabaseAdmin.from("store_bill_lines").insert(i.lines.map((l) => ({ bill_id: b.id, item_id: l.item_id, qty: l.qty, price: it.get(l.item_id)!.unit_price }))).select("bill_id"));
  for (const l of i.lines) check(await supabaseAdmin.from("inv_items").update({ in_stock: it.get(l.item_id)!.in_stock - l.qty }).eq("id", l.item_id).eq("institution_id", inst).select("id"));
  return { code: b.code, amount };
}
void one;
