import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { roster } from "./student-mgmt.service";
import { everyone } from "./fees2.service";
import { directory } from "./hr.service";
import { studentWise } from "./attendance3.service";
import { payments as feePayments } from "./fees.service";
import { payments as payPayments } from "./pay2.service";
import { issues as libIssues, items as invItems } from "./lib2.service";

/** Custom reports (a small builder over a few datasets), the export centre, and the school profile. */
type Row = Record<string, string | number>;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const DATASETS: Record<string, { label: string; columns: string[]; filter: string; load: (inst: string) => Promise<Row[]> }> = {
  students: { label: "Students", columns: ["Name", "Class", "Registration no.", "Roll no.", "Gender", "Status"], filter: "Class", load: async (i) => (await roster(i)).items.map((x) => ({ Name: x.name, Class: x.class_label, "Registration no.": x.registration_no, "Roll no.": x.roll_no, Gender: x.gender ?? "", Status: x.status })) },
  attendance: { label: "Attendance", columns: ["Student", "Class", "Days present", "Days marked", "Attendance %"], filter: "Class", load: async (i) => (await studentWise(i)).items.map((x) => ({ Student: x.name, Class: x.class_label, "Days present": x.days_present, "Days marked": x.days_marked, "Attendance %": x.pct ?? "" })) },
  fees: { label: "Fees pending", columns: ["Student", "Class", "Father", "Due", "Days overdue"], filter: "Class", load: async (i) => (await everyone(i)).rows.map((x) => ({ Student: x.student, Class: x.class_label, Father: x.father, Due: x.due, "Days overdue": x.days_overdue })) },
  staff: { label: "Staff", columns: ["Name", "Employee ID", "Department", "Designation", "Type", "Status"], filter: "Department", load: async (i) => (await directory(i)).items.map((x) => ({ Name: x.name, "Employee ID": x.emp_code, Department: x.department, Designation: x.designation, Type: x.type, Status: x.status })) },
  admissions: { label: "Admissions", columns: ["Application no.", "Child", "Class sought", "Source", "Applied on", "Status"], filter: "Class sought", load: async (i) => (check(await supabaseAdmin.from("adm_applications").select("code, child, class_sought, source, applied_on, status").eq("institution_id", i).limit(20000)) as { code: string; child: string; class_sought: string; source: string; applied_on: string; status: string }[]).map((x) => ({ "Application no.": x.code, Child: x.child, "Class sought": x.class_sought, Source: x.source, "Applied on": x.applied_on, Status: x.status })) },
};
export async function builderOptions() { return { datasets: Object.entries(DATASETS).map(([key, d]) => ({ key, label: d.label, columns: d.columns, filter: d.filter })) }; }
const spec = z.object({ dataset: z.string(), columns: z.array(z.string()).min(1, "Pick at least one column.").max(12), filter_value: z.string().trim().max(60).optional(), group_by: z.string().trim().max(40).optional() }).strict();
export async function runReport(inst: string, input: unknown) {
  const i = spec.parse(input); const d = DATASETS[i.dataset]; if (!d) throw new HttpError(400, "Unknown data."); if (i.columns.some((c) => !d.columns.includes(c))) throw new HttpError(400, "Unknown column.");
  if (i.group_by && !d.columns.includes(i.group_by)) throw new HttpError(400, "Cannot group by that.");
  let rows = await d.load(inst); const f = (i.filter_value ?? "").toLowerCase(); if (f) rows = rows.filter((r) => String(r[d.filter]).toLowerCase().startsWith(f));
  if (i.group_by) { const m = new Map<string, number>(); for (const r of rows) m.set(String(r[i.group_by]), (m.get(String(r[i.group_by])) ?? 0) + 1); return { head: [i.group_by, "Count"], rows: [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, n]), total: rows.length }; }
  return { head: i.columns, rows: rows.slice(0, 5000).map((r) => i.columns.map((c) => r[c])), total: rows.length };
}
export async function saveReport(inst: string, input: unknown, by: string) {
  const i = spec.extend({ name: z.string().trim().min(2, "Name the report.").max(100) }).strict().parse(input); await runReport(inst, { dataset: i.dataset, columns: i.columns, filter_value: i.filter_value, group_by: i.group_by });
  if ((check(await supabaseAdmin.from("saved_reports").select("id").eq("institution_id", inst).ilike("name", i.name)) as unknown[]).length) throw new HttpError(409, "You already have a report with that name.");
  return check(await supabaseAdmin.from("saved_reports").insert({ institution_id: inst, name: i.name, dataset: i.dataset, columns: i.columns.join("|"), filter_value: i.filter_value ?? "", group_by: i.group_by ?? "", created_by: by }).select("id").single());
}
export async function savedReports(inst: string) {
  return { items: (check(await supabaseAdmin.from("saved_reports").select("id, name, dataset, columns, filter_value, group_by, created_by, created_at").eq("institution_id", inst).order("created_at", { ascending: false })) as { id: string; name: string; dataset: string; columns: string; filter_value: string; group_by: string; created_by: string; created_at: string }[]).map((x) => ({ ...x, columns: x.columns.split("|"), data: DATASETS[x.dataset]?.label ?? x.dataset })) };
}
export async function runSaved(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("saved_reports").select("name, dataset, columns, filter_value, group_by").eq("id", id).eq("institution_id", inst).maybeSingle()) as { name: string; dataset: string; columns: string; filter_value: string; group_by: string } | null; if (!r) throw new HttpError(404, "Not found.");
  return { name: r.name, ...(await runReport(inst, { dataset: r.dataset, columns: r.columns.split("|"), filter_value: r.filter_value, group_by: r.group_by || undefined })) };
}
export async function deleteSaved(inst: string, id: string) {
  const r = check(await supabaseAdmin.from("saved_reports").delete().eq("id", id).eq("institution_id", inst).select("id")) as unknown[]; if (!r.length) throw new HttpError(404, "Not found."); return { ok: true };
}

// ═════════════ export centre ═════════════
export const EXPORTS = [["student-list", "Student list", "Students"], ["fee-collection", "Fee collection", "Fee & Finance"], ["outstanding-fees", "Outstanding fees", "Fee & Finance"], ["attendance-register", "Attendance register", "Attendance"], ["staff-list", "Staff list", "HR"], ["payroll-register", "Payroll register", "Payroll"], ["library-issues", "Library issues", "Library"], ["stock-register", "Stock register", "Inventory"]] as const;
const flat = (items: Record<string, unknown>[]) => { const keys = Object.keys(items[0] ?? {}).filter((k) => !/(^id$|_id$|^key$)/.test(k) && items.some((r) => ["string", "number", "boolean"].includes(typeof r[k]) || r[k] === null)); return { head: keys, rows: items.map((r) => keys.map((k) => (r[k] === null || r[k] === undefined ? "" : typeof r[k] === "object" ? "" : (r[k] as string | number)))) }; };
const listOf = (v: unknown) => (Array.isArray(v) ? v : ((v as { items?: unknown[] }).items ?? [])) as Record<string, unknown>[];
export async function exportCatalog(inst: string) {
  const [s, st, u] = await Promise.all([roster(inst), directory(inst), everyone(inst)]);
  const cover: Record<string, string> = { "student-list": `${s.items.length} rows`, "fee-collection": "This year", "outstanding-fees": `${u.rows.length} students`, "attendance-register": "This year", "staff-list": `${st.items.length} rows`, "payroll-register": "All runs", "library-issues": "All issues", "stock-register": "Today" };
  return { items: EXPORTS.map(([key, name, area]) => ({ key, name, area, covers: cover[key] })) };
}
export async function exportData(inst: string, key: string) {
  if (!EXPORTS.some((e) => e[0] === key)) throw new HttpError(404, "Not found.");
  const src: Record<string, () => Promise<unknown>> = { "student-list": async () => (await roster(inst)).items.map((x) => ({ Name: x.name, Class: x.class_label, "Registration no.": x.registration_no, "Roll no.": x.roll_no, Status: x.status })), "fee-collection": () => feePayments(inst), "outstanding-fees": async () => (await everyone(inst)).rows, "attendance-register": async () => (await studentWise(inst)).items, "staff-list": async () => (await directory(inst)).items, "payroll-register": () => payPayments(inst, false), "library-issues": () => libIssues(inst), "stock-register": () => invItems(inst) };
  const r = flat(listOf(await src[key]())); return { name: EXPORTS.find((e) => e[0] === key)![1], date: today(), ...r };
}

// ═════════════ school profile ═════════════
const FIELDS = ["name", "short_name", "board", "affiliation_no", "udise_code", "year_established", "principal", "email", "phone", "website", "address", "city", "state", "pin_code", "map_link"] as const;
export async function profile(inst: string) {
  let p = check(await supabaseAdmin.from("school_profile").select("*").eq("institution_id", inst).maybeSingle()) as Record<string, unknown> | null;
  if (!p) { const i = check(await supabaseAdmin.from("institutions").select("name, contact_email, contact_phone").eq("id", inst).maybeSingle()) as { name: string; contact_email: string | null; contact_phone: string | null } | null; p = { name: i?.name ?? "", email: i?.contact_email ?? "", phone: i?.contact_phone ?? "" }; }
  return { ...Object.fromEntries(FIELDS.map((f) => [f, p![f] ?? (f === "year_established" ? null : "")])), has_logo: !!p.logo, logo: (p.logo as string | null) ?? null, signature: (p.signature as string | null) ?? null, seal: (p.seal as string | null) ?? null };
}
const GEN = z.object({ name: z.string().trim().min(2, "Enter the school name.").max(160), short_name: z.string().trim().max(20), board: z.string().trim().max(40), affiliation_no: z.string().trim().max(40), udise_code: z.string().trim().regex(/^\d{0,11}$/, "UDISE+ code is up to 11 digits.").max(20), year_established: z.number().int().min(1800).max(2100).nullable(), principal: z.string().trim().max(80), email: z.string().trim().max(120).regex(/^([^\s@]+@[^\s@]+\.[^\s@]+)?$/, "Enter a valid email."), phone: z.string().trim().max(30), website: z.string().trim().max(160) }).strict();
const ADR = z.object({ address: z.string().trim().max(500), city: z.string().trim().max(60), state: z.string().trim().max(60), pin_code: z.string().trim().regex(/^(\d{6})?$/, "PIN code is 6 digits."), map_link: z.string().trim().max(300).regex(/^(https?:\/\/.+)?$/, "Use a link that starts with https://") }).strict();
export async function saveProfile(inst: string, part: string, input: unknown) {
  const i = part === "address" ? ADR.parse(input) : part === "general" ? GEN.parse(input) : (() => { throw new HttpError(404, "Not found."); })();
  const cur = await profile(inst); check(await supabaseAdmin.from("school_profile").upsert({ institution_id: inst, ...Object.fromEntries(FIELDS.map((f) => [f, (cur as Record<string, unknown>)[f]])), ...i, logo: cur.logo, updated_at: new Date().toISOString() }).select("institution_id")); return { ok: true };
}
export async function saveLogo(inst: string, input: unknown) {
  const { logo, kind } = z.object({ kind: z.enum(["logo", "signature", "seal"]).optional(), logo: z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, "Use a PNG or JPG image.").max(200_000, "Keep the logo under 150 KB").nullable() }).strict().parse(input);
  const cur = await profile(inst); check(await supabaseAdmin.from("school_profile").upsert({ institution_id: inst, ...Object.fromEntries(FIELDS.map((f) => [f, (cur as Record<string, unknown>)[f]])), [kind ?? "logo"]: logo, updated_at: new Date().toISOString() }).select("institution_id")); return { ok: true };
}
