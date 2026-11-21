import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { directory } from "./hr.service";
import { items } from "./lib2.service";

/** Inventory: suppliers, purchase requests, purchase orders, goods receipt, stock changes, issues, assets and maintenance. */
const uid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-01.");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const nameOf = async (inst: string) => new Map((await items(inst)).items.map((x) => [x.id, x]));
async function staff(inst: string) { return (await directory(inst)).items.map((s) => ({ id: s.id, name: s.name, department: s.department })); }
async function stock(inst: string, itemId: string, delta: number) {
  const i = check(await supabaseAdmin.from("inv_items").select("in_stock").eq("id", itemId).eq("institution_id", inst).maybeSingle()) as { in_stock: number } | null; if (!i) throw new HttpError(404, "Item not found.");
  if (i.in_stock + delta < 0) throw new HttpError(409, `Only ${i.in_stock} in stock.`);
  check(await supabaseAdmin.from("inv_items").update({ in_stock: i.in_stock + delta }).eq("id", itemId).eq("institution_id", inst).select("id"));
}

// ═════════════ suppliers ═════════════
export async function suppliers(inst: string) {
  const [s, p] = await Promise.all([supabaseAdmin.from("inv_suppliers").select("id, name, supplies, gstin, contact, status").eq("institution_id", inst).order("name"), supabaseAdmin.from("inv_pos").select("supplier_id, raised_on").eq("institution_id", inst).gte("raised_on", `${today().slice(0, 4)}-01-01`)]);
  const P = check(p) as { supplier_id: string }[]; return { items: (check(s) as { id: string; name: string; supplies: string; gstin: string; contact: string; status: string }[]).map((x) => ({ ...x, orders: P.filter((y) => y.supplier_id === x.id).length })) };
}
export async function addSupplier(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the supplier.").max(120), supplies: z.string().trim().max(160).optional(), gstin: z.string().trim().toUpperCase().regex(/^([0-9]{2}[A-Z0-9]{13})?$/, "GSTIN has 15 characters.").optional(), contact: z.string().trim().max(40).optional() }).strict().parse(input);
  if ((check(await supabaseAdmin.from("inv_suppliers").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[]).length) throw new HttpError(409, "That supplier exists.");
  return check(await supabaseAdmin.from("inv_suppliers").insert({ institution_id: inst, name: i.name, supplies: i.supplies ?? "", gstin: i.gstin ?? "", contact: i.contact ?? "" }).select("id").single());
}
export async function setSupplier(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Active", "Inactive"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("inv_suppliers").update({ status }).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ purchase requests ═════════════
export async function requests(inst: string) {
  const [r, it, st] = await Promise.all([supabaseAdmin.from("inv_requests").select("id, code, item_id, qty, department, requested_by, requested_on, status").eq("institution_id", inst).order("requested_on", { ascending: false }).order("code", { ascending: false }), nameOf(inst), staff(inst)]);
  return { items_list: [...it.values()].map((x) => ({ id: x.id, name: x.name })), staff: st, items: (check(r) as { id: string; code: string; item_id: string; qty: number; department: string; requested_by: string; requested_on: string; status: string }[]).map((x) => ({ ...x, item: it.get(x.item_id)?.name ?? "" })) };
}
export async function addRequest(inst: string, input: unknown) {
  const i = z.object({ item_id: uid, qty: z.number().int().min(1).max(1_000_000), department: z.string().trim().max(60).optional(), requested_by: z.string().trim().max(120).optional(), requested_on: date.optional() }).strict().parse(input);
  if (!(await nameOf(inst)).has(i.item_id)) throw new HttpError(404, "Item not found.");
  return check(await supabaseAdmin.from("inv_requests").insert({ institution_id: inst, item_id: i.item_id, qty: i.qty, department: i.department ?? "", requested_by: i.requested_by ?? "", requested_on: i.requested_on ?? today() }).select("id, code").single());
}
export async function decideRequest(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Approved", "Rejected"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("inv_requests").update({ status }).eq("id", id).eq("institution_id", inst).eq("status", "Pending approval").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That was already decided."); return { ok: true };
}

// ═════════════ purchase orders ═════════════
export async function orders(inst: string) {
  const [o, l, s, it] = await Promise.all([supabaseAdmin.from("inv_pos").select("id, code, supplier_id, raised_on, delivery_by, status").eq("institution_id", inst).order("raised_on", { ascending: false }).order("code", { ascending: false }), supabaseAdmin.from("inv_po_lines").select("po_id, item_id, qty, price, received, po:po_id!inner(institution_id)").eq("po.institution_id", inst), suppliers(inst), nameOf(inst)]);
  const L = check(l) as unknown as { po_id: string; item_id: string; qty: number; price: number; received: number }[];
  return { suppliers: s.items.filter((x) => x.status === "Active").map((x) => ({ id: x.id, name: x.name })), items_list: [...it.values()].map((x) => ({ id: x.id, name: x.name, price: x.unit_price })), items: (check(o) as { id: string; code: string; supplier_id: string; raised_on: string; delivery_by: string | null; status: string }[]).map((x) => { const ls = L.filter((y) => y.po_id === x.id); return { ...x, supplier: s.items.find((y) => y.id === x.supplier_id)?.name ?? "", lines: ls.map((y) => ({ ...y, item: it.get(y.item_id)?.name ?? "" })), summary: ls.map((y) => `${it.get(y.item_id)?.name ?? ""} × ${y.qty}`).join(", "), amount: ls.reduce((n, y) => n + y.qty * y.price, 0) }; }) };
}
export async function createOrder(inst: string, input: unknown) {
  const i = z.object({ supplier_id: uid, delivery_by: date.nullable().optional(), lines: z.array(z.object({ item_id: uid, qty: z.number().int().min(1).max(1_000_000), price: z.number().int().min(0).max(10_000_000) }).strict()).min(1, "Add at least one item.").max(50) }).strict().parse(input);
  if (!check(await supabaseAdmin.from("inv_suppliers").select("id").eq("id", i.supplier_id).eq("institution_id", inst).maybeSingle())) throw new HttpError(404, "Supplier not found.");
  const it = await nameOf(inst); if (i.lines.some((l) => !it.has(l.item_id))) throw new HttpError(404, "Item not found."); if (new Set(i.lines.map((l) => l.item_id)).size !== i.lines.length) throw new HttpError(400, "An item is listed twice.");
  const po = check(await supabaseAdmin.from("inv_pos").insert({ institution_id: inst, supplier_id: i.supplier_id, delivery_by: i.delivery_by ?? null }).select("id, code").single()) as { id: string; code: string };
  check(await supabaseAdmin.from("inv_po_lines").insert(i.lines.map((l) => ({ po_id: po.id, ...l }))).select("po_id")); return po;
}
export async function decideOrder(inst: string, id: string, input: unknown) {
  const { action } = z.object({ action: z.enum(["approve", "reject"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("inv_pos").update({ status: action === "approve" ? "Sent" : "Rejected" }).eq("id", id).eq("institution_id", inst).eq("status", "Pending approval").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That was already decided."); return { ok: true };
}

// ═════════════ goods receipt ═════════════
export async function receipts(inst: string) {
  const [g, l, o, s, it] = await Promise.all([supabaseAdmin.from("inv_grns").select("id, code, po_id, supplier_id, received_on").eq("institution_id", inst).order("received_on", { ascending: false }).order("code", { ascending: false }), supabaseAdmin.from("inv_grn_lines").select("grn_id, item_id, qty, price, g:grn_id!inner(institution_id)").eq("g.institution_id", inst), orders(inst), suppliers(inst), nameOf(inst)]);
  const L = check(l) as unknown as { grn_id: string; item_id: string; qty: number; price: number }[];
  return { open_orders: o.items.filter((x) => ["Sent", "Partly received"].includes(x.status)), items: (check(g) as { id: string; code: string; po_id: string | null; supplier_id: string | null; received_on: string }[]).map((x) => { const ls = L.filter((y) => y.grn_id === x.id); return { ...x, po: o.items.find((y) => y.id === x.po_id)?.code ?? "—", supplier: s.items.find((y) => y.id === x.supplier_id)?.name ?? "", item_name: ls.length ? `${it.get(ls[0].item_id)?.name ?? ""}${ls.length > 1 ? ` +${ls.length - 1} more` : ""}` : "", qty: ls.reduce((n, y) => n + y.qty, 0), total: ls.reduce((n, y) => n + y.qty * y.price, 0), status: "Accepted" }; }) };
}
export async function receive(inst: string, input: unknown) {
  const i = z.object({ po_id: uid, lines: z.array(z.object({ item_id: uid, qty: z.number().int().min(1).max(1_000_000) }).strict()).min(1, "Enter what arrived.") }).strict().parse(input);
  const po = check(await supabaseAdmin.from("inv_pos").select("id, supplier_id, status").eq("id", i.po_id).eq("institution_id", inst).maybeSingle()) as { id: string; supplier_id: string; status: string } | null; if (!po) throw new HttpError(404, "Order not found.");
  if (!["Sent", "Partly received"].includes(po.status)) throw new HttpError(409, "That order is not waiting for goods.");
  const pl = check(await supabaseAdmin.from("inv_po_lines").select("item_id, qty, price, received").eq("po_id", i.po_id)) as { item_id: string; qty: number; price: number; received: number }[];
  for (const l of i.lines) { const p = pl.find((x) => x.item_id === l.item_id); if (!p) throw new HttpError(400, "That item is not on the order."); if (l.qty > p.qty - p.received) throw new HttpError(409, `Only ${p.qty - p.received} still to come for one item.`); }
  const g = check(await supabaseAdmin.from("inv_grns").insert({ institution_id: inst, po_id: i.po_id, supplier_id: po.supplier_id, received_on: today() }).select("id, code").single()) as { id: string; code: string };
  check(await supabaseAdmin.from("inv_grn_lines").insert(i.lines.map((l) => ({ grn_id: g.id, item_id: l.item_id, qty: l.qty, price: pl.find((x) => x.item_id === l.item_id)!.price }))).select("grn_id"));
  for (const l of i.lines) { const p = pl.find((x) => x.item_id === l.item_id)!; check(await supabaseAdmin.from("inv_po_lines").update({ received: p.received + l.qty }).eq("po_id", i.po_id).eq("item_id", l.item_id).select("po_id")); await stock(inst, l.item_id, l.qty); p.received += l.qty; }
  const full = pl.every((p) => p.received >= p.qty); check(await supabaseAdmin.from("inv_pos").update({ status: full ? "Received" : "Partly received" }).eq("id", i.po_id).eq("institution_id", inst).select("id"));
  return { code: g.code, complete: full };
}

// ═════════════ stock adjustments and issues ═════════════
export async function adjustments(inst: string) {
  const [a, it, st] = await Promise.all([supabaseAdmin.from("inv_adjustments").select("id, code, item_id, change, kind, reason, by_name, adj_on, status").eq("institution_id", inst).order("adj_on", { ascending: false }).order("code", { ascending: false }), nameOf(inst), staff(inst)]);
  return { items_list: [...it.values()].map((x) => ({ id: x.id, name: x.name })), staff: st, items: (check(a) as { id: string; code: string; item_id: string; change: number; kind: string; reason: string; by_name: string; adj_on: string; status: string }[]).map((x) => ({ ...x, item: it.get(x.item_id)?.name ?? "", label: `${x.change > 0 ? "+" : "−"}${Math.abs(x.change)} (${x.kind})` })) };
}
export async function addAdjustment(inst: string, input: unknown) {
  const i = z.object({ item_id: uid, change: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "Enter the change."), kind: z.enum(["lost", "damaged", "broken", "expired", "found in store", "other"]), reason: z.string().trim().max(160).optional(), by_name: z.string().trim().max(120).optional() }).strict().parse(input);
  if (!(await nameOf(inst)).has(i.item_id)) throw new HttpError(404, "Item not found.");
  return check(await supabaseAdmin.from("inv_adjustments").insert({ institution_id: inst, ...i, reason: i.reason ?? "", by_name: i.by_name ?? "", adj_on: today() }).select("id, code").single());
}
export async function decideAdjustment(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Approved", "Rejected"]) }).strict().parse(input);
  const a = check(await supabaseAdmin.from("inv_adjustments").select("id, item_id, change, status").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; item_id: string; change: number; status: string } | null; if (!a) throw new HttpError(404, "Not found."); if (a.status !== "Pending") throw new HttpError(409, "That was already decided.");
  if (status === "Approved") await stock(inst, a.item_id, a.change);
  check(await supabaseAdmin.from("inv_adjustments").update({ status }).eq("id", id).eq("institution_id", inst).select("id")); return { ok: true };
}
export async function stockIssues(inst: string, kind: string) {
  const k = z.enum(["Department", "Staff"]).parse(kind);
  const [r, it, st] = await Promise.all([supabaseAdmin.from("inv_issues").select("id, code, item_id, qty, issued_to, person, issued_on, status").eq("institution_id", inst).eq("to_kind", k).order("issued_on", { ascending: false }).order("code", { ascending: false }), nameOf(inst), staff(inst)]);
  return { items_list: [...it.values()].map((x) => ({ id: x.id, name: `${x.name} (${x.in_stock} ${x.unit})` })), staff: st, departments: [...new Set(st.map((x) => x.department).filter(Boolean))], items: (check(r) as { id: string; code: string; item_id: string; qty: number; issued_to: string; person: string; issued_on: string; status: string }[]).map((x) => ({ ...x, item: it.get(x.item_id)?.name ?? "" })) };
}
export async function issueStock(inst: string, input: unknown) {
  const i = z.object({ item_id: uid, qty: z.number().int().min(1).max(1_000_000), to_kind: z.enum(["Department", "Staff"]), issued_to: z.string().trim().min(1, "Say who it goes to.").max(80), person: z.string().trim().max(120).optional() }).strict().parse(input);
  await stock(inst, i.item_id, -i.qty);
  return check(await supabaseAdmin.from("inv_issues").insert({ institution_id: inst, ...i, person: i.person ?? "", issued_on: today() }).select("id, code").single());
}

// ═════════════ assets and maintenance ═════════════
export async function assets(inst: string) {
  const a = check(await supabaseAdmin.from("inv_assets").select("id, tag, name, category, location, custodian, book_value, status").eq("institution_id", inst).order("tag")) as { id: string; tag: string; name: string; category: string; location: string; custodian: string; book_value: number; status: string }[];
  return { staff: await staff(inst), categories: [...new Set(a.map((x) => x.category).filter(Boolean))], items: a };
}
export async function addAsset(inst: string, input: unknown) {
  const i = z.object({ name: z.string().trim().min(2, "Enter the asset.").max(120), category: z.string().trim().max(60).optional(), location: z.string().trim().max(80).optional(), custodian: z.string().trim().max(120).optional(), book_value: z.number().int().min(0).max(100_000_000), status: z.enum(["In use", "In store", "Under repair"]) }).strict().parse(input);
  return check(await supabaseAdmin.from("inv_assets").insert({ institution_id: inst, ...i, category: i.category ?? "", location: i.location || "Main store", custodian: i.custodian ?? "" }).select("id, tag").single());
}
export async function updateAsset(inst: string, id: string, input: unknown) {
  const i = z.object({ location: z.string().trim().max(80).optional(), custodian: z.string().trim().max(120).optional(), status: z.enum(["In use", "In store", "Under repair"]).optional() }).strict().parse(input);
  const r = check(await supabaseAdmin.from("inv_assets").update(i).eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}
export async function upkeep(inst: string, kind: string) {
  const k = z.enum(["Repairs", "Service schedule"]).parse(kind); const now = today();
  const m = check(await supabaseAdmin.from("inv_maintenance").select("id, kind, job, asset, vendor, every, next_due, status").eq("institution_id", inst).eq("kind", k).order("next_due")) as { id: string; kind: string; job: string; asset: string; vendor: string; every: string; next_due: string; status: string }[];
  return { items: m.map((x) => ({ ...x, status: x.status === "Done" ? "Done" : x.next_due <= addDays(now, 7) ? "Due soon" : "Scheduled" })) };
}
export async function addUpkeep(inst: string, input: unknown) {
  const i = z.object({ kind: z.enum(["Repairs", "Service schedule"]), job: z.string().trim().min(2, "Enter the job.").max(120), asset: z.string().trim().max(120).optional(), vendor: z.string().trim().max(100).optional(), every: z.string().trim().max(30).optional(), next_due: date }).strict().parse(input);
  return check(await supabaseAdmin.from("inv_maintenance").insert({ institution_id: inst, ...i, asset: i.asset ?? "", vendor: i.vendor ?? "", every: i.every ?? "" }).select("id").single());
}
export async function finishUpkeep(inst: string, id: string) {
  const m = check(await supabaseAdmin.from("inv_maintenance").select("id, kind, every, next_due").eq("id", id).eq("institution_id", inst).maybeSingle()) as { id: string; kind: string; every: string; next_due: string } | null; if (!m) throw new HttpError(404, "Not found.");
  const n = /year/i.test(m.every) ? 365 : /6 months/i.test(m.every) ? 182 : /3 months/i.test(m.every) ? 91 : /month/i.test(m.every) ? 30 : 0;
  if (n && m.kind === "Service schedule") check(await supabaseAdmin.from("inv_maintenance").update({ next_due: addDays(m.next_due > today() ? m.next_due : today(), n) }).eq("id", id).eq("institution_id", inst).select("id"));
  else check(await supabaseAdmin.from("inv_maintenance").update({ status: "Done" }).eq("id", id).eq("institution_id", inst).select("id"));
  return { ok: true, repeats: !!n && m.kind === "Service schedule" };
}
void one;
