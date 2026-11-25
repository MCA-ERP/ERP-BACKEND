import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { mayManage } from "./staff-roles";
import { getSettings, saveSettings } from "./settings.service";
import { profile } from "./custom.service";
import { roster } from "./student-mgmt.service";
import { createRole, deleteRole } from "../admin/roles-mgmt.service";

/** Communication settings, integrations, users, roles, approvals, notification rules, numbering, audit and DPDP. */
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const uid = z.string().uuid();

// ═════════════ key/value groups kept here ═════════════
const KV: Record<string, { schema: z.ZodTypeAny; defaults: () => Promise<unknown> | unknown }> = {
  sms: { schema: z.object({ provider: z.enum(["MSG91", "Textlocal", "Twilio", "Other"]), sender_id: z.string().trim().max(6).regex(/^[A-Za-z]{0,6}$/, "A sender ID is up to 6 letters."), dlt_entity_id: z.string().trim().regex(/^\d{0,20}$/, "The DLT entity ID is digits only.") }).strict(), defaults: () => ({ provider: "MSG91", sender_id: "", dlt_entity_id: "" }) },
  email: { schema: z.object({ from_name: z.string().trim().max(120), from_address: z.string().trim().max(120).regex(/^([^\s@]+@[^\s@]+\.[^\s@]+)?$/, "Enter a valid email."), reply_to: z.string().trim().max(120).regex(/^([^\s@]+@[^\s@]+\.[^\s@]+)?$/, "Enter a valid email.") }).strict(), defaults: () => ({ from_name: "", from_address: "", reply_to: "" }) },
  whatsapp: { schema: z.object({ business_number: z.string().trim().max(30), provider: z.enum(["Interakt", "Meta Cloud API", "Gupshup", "Other"]) }).strict(), defaults: () => ({ business_number: "", provider: "Interakt" }) },
  result_rules: { schema: z.object({ publish_to_parents: z.boolean(), show: z.enum(["Marks and grades", "Grades only", "Marks only"]), withhold_overdue: z.boolean(), reeval_days: z.enum(["2", "3", "5", "7"]) }).strict(), defaults: () => ({ publish_to_parents: true, show: "Marks and grades", withhold_overdue: false, reeval_days: "3" }) },
  approval_routing: { schema: z.object({ on_leave: z.enum(["Send to their backup", "Skip to next level", "Wait"]), escalate_days: z.enum(["1", "2", "3", "5"]), mobile: z.boolean(), digest: z.boolean() }).strict(), defaults: () => ({ on_leave: "Send to their backup", escalate_days: "2", mobile: true, digest: true }) },
  triggers: { schema: z.object({ absent: z.boolean(), fee_due: z.boolean(), fee_overdue: z.boolean(), homework: z.boolean(), report_card: z.boolean(), bus_delayed: z.boolean(), birthday: z.boolean() }).strict(), defaults: () => ({ absent: true, fee_due: true, fee_overdue: true, homework: true, report_card: true, bus_delayed: true, birthday: false }) },
  numbering: { schema: z.object({ admission: z.string().trim().max(40), receipt: z.string().trim().max(40), certificate: z.string().trim().max(40), transfer: z.string().trim().max(40), employee: z.string().trim().max(40), accession: z.string().trim().max(40), restart: z.boolean() }).strict(), defaults: () => ({ admission: "BGPS/{year}/{0000}", receipt: "RCT-{00000}", certificate: "BG/CRT/{year}/{0000}", transfer: "BG/TC/{year}/{000}", employee: "EMP-{0000}", accession: "ACC-{00000}", restart: true }) },
};
export async function kvGet(inst: string, key: string) {
  const g = KV[key]; if (!g) throw new HttpError(404, "Not found.");
  const r = check(await supabaseAdmin.from("school_settings").select("value").eq("institution_id", inst).eq("key", key).maybeSingle()) as { value: Record<string, unknown> } | null;
  let d = await g.defaults(); if (key === "email") { const p = (await profile(inst)) as unknown as { name: string; email: string }; d = { from_name: p.name, from_address: "", reply_to: p.email }; }
  return { ...(d as object), ...(r?.value ?? {}) };
}
export async function kvSave(inst: string, key: string, input: unknown) {
  const g = KV[key]; if (!g) throw new HttpError(404, "Not found.");
  const merged = { ...(await kvGet(inst, key)), ...(z.object({}).passthrough().parse(input)) }; const v = (g.schema as z.ZodObject<z.ZodRawShape>).parse(merged);
  check(await supabaseAdmin.from("school_settings").upsert({ institution_id: inst, key, value: v, updated_at: new Date().toISOString() }).select("key")); return v;
}

// ═════════════ approval levels and role menus (tables of settings) ═════════════
const LEVELS_DEFAULT = [["Admission", "Admissions counsellor", "Principal", ""], ["Fee concession", "Accountant", "Principal", "School admin (above ₹25,000)"], ["Leave (staff)", "HOD", "Principal", ""], ["Expense", "Accountant", "Principal (above ₹10,000)", "School admin (above ₹1 lakh)"], ["Purchase order", "Store in-charge", "Principal", ""], ["Transfer certificate", "Class teacher", "Accountant (dues)", "Principal"]];
export async function levels(inst: string) {
  const r = check(await supabaseAdmin.from("school_settings").select("value").eq("institution_id", inst).eq("key", "approval_levels").maybeSingle()) as { value: { rows: string[][] } } | null;
  return { rows: r?.value.rows ?? LEVELS_DEFAULT };
}
export async function saveLevels(inst: string, input: unknown) {
  const { rows } = z.object({ rows: z.array(z.array(z.string().trim().max(60)).length(4)).length(LEVELS_DEFAULT.length) }).strict().parse(input);
  if (rows.some((r, k) => r[0] !== LEVELS_DEFAULT[k][0] || !r[1])) throw new HttpError(400, "Every item needs a first-level approver.");
  check(await supabaseAdmin.from("school_settings").upsert({ institution_id: inst, key: "approval_levels", value: { rows }, updated_at: new Date().toISOString() }).select("key")); return { rows };
}
const MENU_ROLES = ["School Admin", "Principal", "Accountant", "Receptionist", "Teacher", "Librarian", "Transport Manager"];
type RoleRow = { id: string; name: string; display_name: string; description: string | null; is_system_default: boolean; institution_id: string | null; scope: string };
/** Roles this school can use: the platform's school roles and the ones made for this school (never another school's, never platform roles). */
async function schoolRoles(inst: string) {
  const r = check(await supabaseAdmin.from("roles").select("id, name, display_name, description, is_system_default, institution_id, scope").eq("scope", "school").order("display_name")) as RoleRow[];
  return r.filter((x) => STAFF_ROLE(x.name) && (x.institution_id === null || x.institution_id === inst));
}
/** A role the school (or the platform team) added: not one of the built-in menu roles. It gets a menu column of its own. */
const isCustom = (x: RoleRow) => !x.is_system_default && !MENU_ROLES.includes(x.display_name);
export async function roleMenus(inst: string) {
  const [r, rs] = await Promise.all([supabaseAdmin.from("school_settings").select("value").eq("institution_id", inst).eq("key", "role_menu").maybeSingle(), schoolRoles(inst)]);
  const map = (check(r) as { value: Record<string, string[]> } | null)?.value ?? null;
  const custom = rs.filter(isCustom).map((x) => x.display_name);
  return { roles: [...MENU_ROLES, ...custom], custom, map };
}
export async function saveRoleMenus(inst: string, input: unknown) {
  const { map } = z.object({ map: z.record(z.string(), z.array(z.string().max(40)).max(60)) }).strict().parse(input);
  const known = new Set((await roleMenus(inst)).roles);
  if (Object.keys(map).some((k) => !known.has(k))) throw new HttpError(400, "Unknown role."); map["School Admin"] = map["School Admin"] ?? [];
  check(await supabaseAdmin.from("school_settings").upsert({ institution_id: inst, key: "role_menu", value: map, updated_at: new Date().toISOString() }).select("key")); return { ok: true };
}
/** The menus the signed-in person may see. null means all of them (built-in roles keep their usual access); a custom role sees only what its column allows once its menus have been saved. */
export async function myMenu(inst: string, roleDisplay: string) {
  const { custom, map } = await roleMenus(inst);
  if (!custom.includes(roleDisplay)) return { allowed: null as string[] | null };
  return { allowed: (map?.[roleDisplay] ?? null) as string[] | null };
}

// ═════════════ users and roles ═════════════
const STAFF_ROLE = (n: string) => !["Parent", "Student", "SuperAdmin", "PlatformAdmin"].includes(n);
export async function users(inst: string) {
  const u = check(await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, email, status, last_login_at, roles:role_id(name, display_name)").eq("institution_id", inst).order("first_name").limit(3000)) as unknown as { id: string; first_name: string; last_name: string; email: string; status: string | null; last_login_at: string | null; roles: { name: string; display_name: string } | { name: string; display_name: string }[] | null }[];
  return { items: u.filter((x) => STAFF_ROLE(one(x.roles)?.name ?? "")).map((x) => ({ id: x.id, name: `${x.first_name} ${x.last_name}`.trim(), role: one(x.roles)?.display_name ?? "", login: x.email, last_login: x.last_login_at, status: (x.status ?? "active").toLowerCase() === "active" ? "Active" : (x.status ?? "").toLowerCase() === "locked" ? "Locked" : "Inactive" })) };
}
export async function setUser(inst: string, id: string, input: unknown, actor?: string, actorRole?: string) {
  const { active } = z.object({ active: z.boolean() }).strict().parse(input); if (!active && actor === id) throw new HttpError(409, "You can't deactivate your own account.");
  const t = check(await supabaseAdmin.from("user_profiles").select("id, roles:role_id(name)").eq("id", id).eq("institution_id", inst).maybeSingle()) as unknown as { id: string; roles: { name: string } | { name: string }[] | null } | null; if (!t) throw new HttpError(404, "Not found.");
  if (!STAFF_ROLE(one(t.roles)?.name ?? "")) throw new HttpError(403, "That account isn't a school user.");
  if (!mayManage(actorRole ?? "", one(t.roles)?.name ?? "")) throw new HttpError(403, "You can't change this account. Ask the School Admin.");
  check(await supabaseAdmin.from("user_profiles").update({ status: active ? "active" : "suspended" }).eq("id", id).eq("institution_id", inst).select("id"));
  await supabaseAdmin.from("audit_logs").insert({ actor_id: actor ?? null, action: active ? "ACTIVATE_USER" : "DEACTIVATE_USER", entity_name: "user", entity_id: id, institution_id: inst }); return { ok: true };
}
export async function roles(inst: string) {
  const [rs, u] = await Promise.all([schoolRoles(inst), users(inst)]);
  return { items: rs.map((x) => ({ id: x.id, name: x.name, display_name: x.display_name, description: x.description, users: u.items.filter((y) => y.role === x.display_name).length, custom: isCustom(x), own: x.institution_id === inst })) };
}
export async function addRole(inst: string, actor: { profileId?: string; name: string }, input: unknown) {
  const i = z.object({ display_name: z.string().trim().min(3, "Give the role a name of at least 3 letters.").max(100), description: z.string().trim().max(500).optional(), copy_menus_from: z.string().trim().max(100).optional() }).strict().parse(input);
  const role = await createRole({ display_name: i.display_name, description: i.description || null, scope: "school", institution_id: inst, data_scope: "school" } as never, actor as never);
  // the new role starts with the Dashboard only, or with the menus of the role it was copied from
  const { map } = await roleMenus(inst);
  const base = i.copy_menus_from ? map?.[i.copy_menus_from] ?? [] : [];
  const next = { ...(map ?? {}), [i.display_name]: base.length ? base : ["dashboard"] };
  check(await supabaseAdmin.from("school_settings").upsert({ institution_id: inst, key: "role_menu", value: next, updated_at: new Date().toISOString() }).select("key"));
  return { id: (role as { id: string }).id, display_name: i.display_name };
}
export async function removeRole(inst: string, actor: { profileId?: string; name: string }, id: string) {
  const own = (await schoolRoles(inst)).find((x) => x.id === id);
  if (!own || own.institution_id !== inst) throw new HttpError(403, "Only a role added for this school can be deleted here.");
  const r = await deleteRole(id, actor as never);
  const { map } = await roleMenus(inst);
  if (map && own.display_name in map) { const next = { ...map }; delete next[own.display_name]; check(await supabaseAdmin.from("school_settings").upsert({ institution_id: inst, key: "role_menu", value: next, updated_at: new Date().toISOString() }).select("key")); }
  return r;
}

// ═════════════ integrations ═════════════
export async function integrations() {
  const razor = !!process.env.RAZORPAY_KEY_ID;
  const items = [["Online fee payments", "Razorpay · UPI, cards, net banking", "Fee payments from parents", razor], ["SMS", "Set under Communication Settings", "Fee reminders, absence and bus alerts", false], ["WhatsApp", "Set under Communication Settings", "Circulars, bus delays, fee links", false], ["Email", "Platform mail service", "Receipts, report cards, circulars", !!process.env.SMTP_HOST || !!process.env.RESEND_API_KEY], ["Biometric attendance", "Devices from Attendance", "Staff attendance sync", false], ["RFID and QR attendance", "Gate readers from Attendance", "Student attendance from gate scans", false], ["Bus GPS tracking", "Vehicle GPS devices from Transport", "Live bus location in the parent app", false], ["Accounting export", "Tally Prime (XML export)", "Ask Super Admin to switch it on", false]] as const;
  return { items: items.map(([service, provider, used, on]) => ({ service, provider, used, status: on ? "Connected" : "Not set up" })) };
}

// ═════════════ audit and change history ═════════════
export async function audit(inst: string) {
  const r = check(await supabaseAdmin.from("audit_logs").select("id, actor_email, action, entity_name, entity_id, old_data, new_data, ip_address, created_at").eq("institution_id", inst).order("created_at", { ascending: false }).limit(1000)) as { id: string; actor_email: string | null; action: string; entity_name: string; entity_id: string | null; old_data: unknown; new_data: unknown; ip_address: string | null; created_at: string }[];
  const words = (a: string) => a.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const shape = (x: (typeof r)[number]) => ({ id: x.id, time: x.created_at, user: x.actor_email ?? "System", action: words(x.action), record: [x.entity_name, x.entity_id].filter(Boolean).join(" · "), ip: x.ip_address ?? "", status: "Logged" });
  return { items: r.map(shape), changes: r.filter((x) => x.old_data || x.new_data).map((x) => { const o = (x.old_data ?? {}) as Record<string, unknown>; const n = (x.new_data ?? {}) as Record<string, unknown>; const k = Object.keys({ ...o, ...n }).find((f) => JSON.stringify(o[f]) !== JSON.stringify(n[f])) ?? ""; return { id: x.id, when: x.created_at, by: x.actor_email ?? "System", area: x.entity_name, field: k, before: k && o[k] !== undefined ? String(o[k]) : "", after: k && n[k] !== undefined ? String(n[k]) : "" }; }) };
}

// ═════════════ DPDP ═════════════
export async function dpdp(inst: string) {
  const [c, q, g, pc, ro] = await Promise.all([supabaseAdmin.from("consent_records").select("id, parent_name, purpose, choice, source, recorded_at").eq("institution_id", inst).order("recorded_at", { ascending: false }).limit(3000), supabaseAdmin.from("data_requests").select("id, parent_name, kind, details, requested_on, status").eq("institution_id", inst).order("requested_on", { ascending: false }).limit(2000), supabaseAdmin.from("guardians").select("id", { count: "exact", head: true }).eq("institution_id", inst), supabaseAdmin.from("gallery_consent").select("id", { count: "exact", head: true }).eq("institution_id", inst), roster(inst)]);
  void ro; const Q = check(q) as { id: string; parent_name: string; kind: string; details: string; requested_on: string; status: string }[];
  return { families: g.count ?? 0, photo_withdrawn: pc.count ?? 0, open: Q.filter((x) => x.status === "Open").length, consents: check(c) as { id: string; parent_name: string; purpose: string; choice: string; source: string; recorded_at: string }[], requests: Q };
}
export async function decideRequest(inst: string, id: string, input: unknown) {
  const { status } = z.object({ status: z.enum(["Done", "Declined"]) }).strict().parse(input);
  const r = check(await supabaseAdmin.from("data_requests").update({ status }).eq("id", id).eq("institution_id", inst).eq("status", "Open").select("id")) as unknown[]; if (!r.length) throw new HttpError(409, "That was already decided."); return { ok: true };
}
void uid; void getSettings; void saveSettings;
