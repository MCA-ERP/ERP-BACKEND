import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { parsePage, safeSearch } from "../../lib/query";
import { clearEntitlementCache } from "../../lib/entitlements";
import { createUser } from "./admin.service";
import { getSchool, setSchoolStatus } from "./schools.service";
import { assertRoomFor } from "../../lib/plan-limits";

export interface Actor {
  profileId?: string;
  name: string;
}

// ── event history ───────────────────────────────────────────
export async function logEvent(institutionId: string, type: string, summary: string, actor?: Actor, oldData?: unknown, newData?: unknown) {
  const res = await supabaseAdmin.from("school_events").insert({
    institution_id: institutionId,
    type,
    summary,
    actor_id: actor?.profileId ?? null,
    actor_name: actor?.name ?? null,
    old_data: oldData ?? null,
    new_data: newData ?? null,
  });
  // history must never block the action it describes
  if (res.error) console.error("School event not recorded:", res.error.message);
}

/** Only the fields that changed, as { before, after }. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const oldData: Record<string, unknown> = {};
  const newData: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      oldData[k] = before[k] ?? null;
      newData[k] = after[k] ?? null;
    }
  }
  return { oldData, newData, changed: Object.keys(newData) };
}

async function requireSchool(id: string) {
  const row = check(await supabaseAdmin.from("institutions").select("*").eq("id", id).is("deleted_at", null).maybeSingle()) as Record<string, unknown> | null;
  if (!row) throw new HttpError(404, "School not found.");
  return row;
}

export async function getHistory(id: string, type: string, query: Record<string, unknown>) {
  await requireSchool(id);
  const p = parsePage(query);
  if (type === "subscription") {
    const [subs, invoices] = await Promise.all([
      supabaseAdmin
        .from("subscriptions")
        .select("id, started_on, renews_on, trial_ends_on, ended_on, is_current, created_at, plans:plan_id(code, name, price_per_student_paise)")
        .eq("institution_id", id)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("platform_invoice_overview")
        .select("id, number, description, issue_date, due_on, total_paise, paid_paise, status")
        .eq("institution_id", id)
        .order("issue_date", { ascending: false })
        .limit(50),
    ]);
    return { subscriptions: check(subs), invoices: check(invoices) };
  }
  if (type === "audit") {
    // requests made against this school, from the platform audit log
    const rows = check(
      await supabaseAdmin
        .from("audit_logs")
        .select("id, actor_email, action, new_data, ip_address, created_at", { count: "exact" })
        .like("action", `% /api/v1/admin/schools/${id}%`)
        .order("created_at", { ascending: false })
        .range(p.from, p.to)
    );
    return { items: rows, page: p.page, pageSize: p.pageSize };
  }
  const res = await supabaseAdmin
    .from("school_events")
    .select("id, type, summary, actor_name, old_data, new_data, created_at", { count: "exact" })
    .eq("institution_id", id)
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

// ── profile & configuration ─────────────────────────────────
export const PROFILE_FIELDS = [
  "name", "type", "board", "established_year", "affiliation_number", "registration_number", "website", "gst_number",
  "address", "city", "state", "postal_code", "country", "contact_name", "contact_email", "contact_phone",
  "logo_url", "tagline", "primary_color", "secondary_color", "medium_of_instruction", "classes_offered", "student_estimate", "udise_code",
  "app_name", "receipt_header", "own_branding",
] as const;

export async function updateProfile(id: string, patch: Record<string, unknown>, actor: Actor) {
  const before = await requireSchool(id);
  const { oldData, newData, changed } = diff(before, patch);
  if (!changed.length) return getSchool(id);
  check(await supabaseAdmin.from("institutions").update(patch).eq("id", id).select("id").single());
  await logEvent(id, "profile_updated", `Updated ${changed.join(", ").replace(/_/g, " ")}`, actor, oldData, newData);
  return getSchool(id);
}

export async function getProfile(id: string) {
  const row = await requireSchool(id);
  const contacts = check(await supabaseAdmin.from("school_contacts").select("*").eq("institution_id", id).order("created_at"));
  return { profile: Object.fromEntries([...PROFILE_FIELDS, "code", "status"].map((k) => [k, row[k] ?? null])), contacts };
}

export async function addContact(id: string, input: { role: string; name: string; email?: string | null; phone?: string | null }, actor: Actor) {
  await requireSchool(id);
  const row = check(await supabaseAdmin.from("school_contacts").insert({ ...input, institution_id: id }).select().single());
  await logEvent(id, "contact_added", `Added contact ${input.name} (${input.role})`, actor);
  return row;
}

export async function removeContact(id: string, contactId: string, actor: Actor) {
  const row = check(await supabaseAdmin.from("school_contacts").delete().eq("id", contactId).eq("institution_id", id).select("name").maybeSingle()) as { name: string } | null;
  if (!row) throw new HttpError(404, "Contact not found.");
  await logEvent(id, "contact_removed", `Removed contact ${row.name}`, actor);
  return { success: true };
}

export interface SchoolConfig {
  academic?: {
    current_year?: string; year_start_month?: number; terms?: number; grading?: string; pass_mark?: number; working_days?: string;
    attendance_rule?: string; min_attendance_percent?: number; promote_auto?: boolean; lock_marks?: boolean;
  };
  regional?: { country?: string; state?: string; timezone?: string; currency?: string; number_format?: string; date_format?: string; week_start?: string };
  language?: { default?: string; report_card?: string; comms?: string; parents_choose?: boolean; enabled?: string[] };
}

const DEFAULT_CONFIG: Required<SchoolConfig> = {
  academic: {
    current_year: "", year_start_month: 4, terms: 2, grading: "Marks and percentage", pass_mark: 33, working_days: "Monday - Saturday",
    attendance_rule: "Daily", min_attendance_percent: 75, promote_auto: true, lock_marks: true,
  },
  regional: { country: "India", state: "", timezone: "Asia/Kolkata", currency: "INR", number_format: "1,00,000 (Indian)", date_format: "DD MMM YYYY", week_start: "Monday" },
  language: { default: "English", report_card: "English", comms: "English", parents_choose: true, enabled: ["English"] },
};

export async function getConfig(id: string) {
  const row = await requireSchool(id);
  const stored = (row.config ?? {}) as SchoolConfig;
  return {
    config: {
      academic: { ...DEFAULT_CONFIG.academic, ...stored.academic },
      regional: { ...DEFAULT_CONFIG.regional, ...stored.regional },
      language: { ...DEFAULT_CONFIG.language, ...stored.language },
    },
  };
}

export async function updateConfig(id: string, section: "academic" | "regional" | "language", values: Record<string, unknown>, actor: Actor) {
  const row = await requireSchool(id);
  const stored = (row.config ?? {}) as Record<string, Record<string, unknown>>;
  const before = stored[section] ?? {};
  const next = { ...stored, [section]: { ...before, ...values } };
  const { oldData, newData, changed } = diff(before, next[section]);
  if (!changed.length) return getConfig(id);
  check(await supabaseAdmin.from("institutions").update({ config: next }).eq("id", id).select("id").single());
  await logEvent(id, "config_updated", `Changed ${section} settings: ${changed.join(", ").replace(/_/g, " ")}`, actor, oldData, newData);
  return getConfig(id);
}

// ── campuses ────────────────────────────────────────────────
export async function listAllCampuses(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("campuses")
    .select("id, code, name, city, state, phone, principal_name, classes_offered, classrooms, opened_year, is_main, is_active, institution_id, institutions:institution_id(name, code, status)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  const search = safeSearch(query.search);
  if (search) q = q.or(`name.ilike.%${search}%,code.ilike.%${search}%,city.ilike.%${search}%`);
  if (typeof query.school === "string" && /^[0-9a-f-]{36}$/i.test(query.school)) q = q.eq("institution_id", query.school);
  const res = await q;
  const items = check(res) as unknown as { id: string }[];

  // enrolled students on each campus of this page, and the figures for the tiles
  const ids = items.map((c) => c.id);
  const [students, all] = await Promise.all([
    ids.length ? supabaseAdmin.from("students").select("campus_id").in("campus_id", ids).eq("status", "Enrolled").is("deleted_at", null).limit(100_000) : Promise.resolve({ data: [] }),
    supabaseAdmin.from("campuses").select("institution_id, is_active, institutions:institution_id(status)").limit(10_000),
  ]);
  const perCampus = new Map<string, number>();
  for (const r of ((students.data ?? []) as { campus_id: string }[])) perCampus.set(r.campus_id, (perCampus.get(r.campus_id) ?? 0) + 1);
  const rows = (check(all) as unknown as { institution_id: string; is_active: boolean; institutions: { status: string } | null }[]);
  const perSchool = new Map<string, number>();
  for (const r of rows) perSchool.set(r.institution_id, (perSchool.get(r.institution_id) ?? 0) + 1);

  return {
    items: items.map((c) => ({ ...c, students: perCampus.get(c.id) ?? 0 })),
    total: res.count ?? 0,
    page: p.page,
    pageSize: p.pageSize,
    summary: {
      campuses: rows.length,
      schools: perSchool.size,
      multi_campus_schools: [...perSchool.values()].filter((n) => n > 1).length,
      inactive: rows.filter((r) => !r.is_active || ["Suspended", "Expired", "Inactive"].includes(r.institutions?.status ?? "")).length,
    },
  };
}

export async function getCampus(id: string) {
  const campus = check(
    await supabaseAdmin.from("campuses").select("*, institutions:institution_id(id, name, code, status)").eq("id", id).maybeSingle()
  ) as (Record<string, unknown> & { institution_id: string }) | null;
  if (!campus) throw new HttpError(404, "Campus not found.");
  const [students, users, teachers] = await Promise.all([
    supabaseAdmin.from("students").select("*", { count: "exact", head: true }).eq("campus_id", id).eq("status", "Enrolled").is("deleted_at", null),
    supabaseAdmin.from("user_profiles").select("*", { count: "exact", head: true }).eq("campus_id", id).eq("status", "active"),
    supabaseAdmin.from("user_profiles").select("id, roles:role_id!inner(name)", { count: "exact", head: true }).eq("campus_id", id).eq("status", "active").in("roles.name", ["Faculty", "ClassTeacher", "HOD"]),
  ]);
  return { campus, counts: { students: students.count ?? 0, users: users.count ?? 0, teachers: teachers.count ?? 0 } };
}

export async function updateCampus(id: string, patch: Record<string, unknown>, actor: Actor) {
  const before = check(await supabaseAdmin.from("campuses").select("*").eq("id", id).maybeSingle()) as (Record<string, unknown> & { institution_id: string }) | null;
  if (!before) throw new HttpError(404, "Campus not found.");
  const { oldData, newData, changed } = diff(before, patch);
  if (!changed.length) return getCampus(id);
  if (patch.is_main === true) {
    await supabaseAdmin.from("campuses").update({ is_main: false }).eq("institution_id", before.institution_id).neq("id", id);
  }
  check(await supabaseAdmin.from("campuses").update(patch).eq("id", id).select("id").single());
  await logEvent(before.institution_id, "campus_updated", `Updated campus ${before.name}: ${changed.join(", ").replace(/_/g, " ")}`, actor, oldData, newData);
  return getCampus(id);
}

export async function addCampus(institutionId: string, input: Record<string, unknown>, actor: Actor) {
  await requireSchool(institutionId);
  await assertRoomFor(institutionId, "campus");
  const count = await supabaseAdmin.from("campuses").select("*", { count: "exact", head: true }).eq("institution_id", institutionId);
  const res = await supabaseAdmin.from("campuses").insert({ ...input, institution_id: institutionId, is_main: (count.count ?? 0) === 0 }).select().single();
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, `A campus with code '${input.code}' already exists in this school.`);
    throw new HttpError(500, res.error.message);
  }
  await logEvent(institutionId, "campus_added", `Added campus ${input.name}`, actor);
  return res.data;
}

// ── school admins ───────────────────────────────────────────
interface AdminRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  status: string;
  roles: { name: string } | null;
}

export async function listAdmins(id: string) {
  const school = await requireSchool(id);
  const rows = check(
    await supabaseAdmin
      .from("user_profiles")
      .select("id, email, first_name, last_name, phone, status, last_login_at, created_at, must_change_password, campus_id, roles:role_id(name, display_name)")
      .eq("institution_id", id)
      .order("created_at")
  ) as unknown as AdminRow[];
  const admins = rows.filter((r) => r.roles?.name === "InstitutionAdmin");
  return { admins, primary_admin_id: (school.primary_admin_id as string | null) ?? admins[0]?.id ?? null };
}

export async function createAdmin(
  id: string,
  input: { first_name: string; last_name: string; email: string; phone?: string; password: string; make_primary?: boolean; designation?: string; require_2fa?: boolean },
  actor: Actor
) {
  await requireSchool(id);
  const { make_primary, designation, require_2fa, ...user } = input;
  const created = (await createUser({ ...user, role: "InstitutionAdmin", institution_id: id, must_change_password: true })) as unknown as { id: string };
  if (designation || require_2fa) {
    await supabaseAdmin.from("user_profiles").update({ ...(designation ? { designation } : {}), ...(require_2fa ? { otp_enabled: true } : {}) }).eq("id", created.id);
  }
  const first = !(await listAdmins(id)).admins.some((a) => a.id !== created.id);
  if (make_primary || first) await supabaseAdmin.from("institutions").update({ primary_admin_id: created.id }).eq("id", id);
  await logEvent(id, "admin_created", `Created administrator ${input.first_name} ${input.last_name} (${input.email})`, actor);
  return created;
}

export async function assignPrimaryAdmin(id: string, adminId: string, actor: Actor) {
  const { admins } = await listAdmins(id);
  const target = admins.find((a) => a.id === adminId);
  if (!target) throw new HttpError(400, "That person is not an administrator of this school.");
  if (target.status !== "active") throw new HttpError(400, "Choose an active administrator.");
  check(await supabaseAdmin.from("institutions").update({ primary_admin_id: adminId }).eq("id", id).select("id").single());
  // the primary administrator can always do everything
  await supabaseAdmin.from("user_profiles").update({ admin_access: {} }).eq("id", adminId);
  await logEvent(id, "primary_admin_changed", `Primary administrator is now ${target.first_name} ${target.last_name}`, actor);
  return listAdmins(id);
}

/** What a school administrator can do in the school portal: their role's permissions and the school's modules. */
export async function getAdminAccess(id: string) {
  await requireSchool(id);
  const role = check(await supabaseAdmin.from("roles").select("id, display_name").eq("name", "InstitutionAdmin").maybeSingle()) as { id: string; display_name: string } | null;
  const perms = role
    ? (check(await supabaseAdmin.from("role_permissions").select("permissions:permission_id(code, module, description)").eq("role_id", role.id)) as unknown as {
        permissions: { code: string; module: string; description: string | null } | null;
      }[])
    : [];
  const { getSchoolModules } = await import("./modules.service");
  const mods = await getSchoolModules(id);
  return {
    role: role?.display_name ?? "School administrator",
    permissions: perms.map((p) => p.permissions).filter(Boolean),
    modules: mods.modules.filter((m) => m.effective).map((m) => ({ code: m.code, name: m.name })),
  };
}

// ── documents ───────────────────────────────────────────────
export interface DocumentInput {
  category: "registration" | "affiliation";
  doc_type: string;
  number?: string | null;
  issued_by?: string | null;
  issue_date?: string | null;
  expiry_date?: string | null;
  file_url?: string | null;
  notes?: string | null;
}

export async function listDocuments(id: string, category?: string) {
  await requireSchool(id);
  let q = supabaseAdmin.from("school_documents").select("*").eq("institution_id", id).order("created_at", { ascending: false });
  if (category === "registration" || category === "affiliation") q = q.eq("category", category);
  return { documents: check(await q) };
}

export async function addDocument(id: string, input: DocumentInput, actor: Actor) {
  await requireSchool(id);
  if (input.issue_date && input.expiry_date && input.expiry_date < input.issue_date) throw new HttpError(400, "The expiry date is before the issue date.");
  const row = check(await supabaseAdmin.from("school_documents").insert({ ...input, institution_id: id }).select().single());
  await logEvent(id, "document_added", `Added ${input.category} document: ${input.doc_type}`, actor);
  return row;
}

export async function reviewDocument(id: string, docId: string, status: "verified" | "rejected" | "pending", notes: string | null | undefined, actor: Actor) {
  if (status === "rejected" && !notes?.trim()) throw new HttpError(400, "Say why the document was rejected.");
  const row = check(
    await supabaseAdmin
      .from("school_documents")
      .update({
        status,
        notes: notes ?? null,
        verified_by: status === "pending" ? null : actor.profileId ?? null,
        verified_at: status === "pending" ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId)
      .eq("institution_id", id)
      .select("doc_type")
      .maybeSingle()
  ) as { doc_type: string } | null;
  if (!row) throw new HttpError(404, "Document not found.");
  await logEvent(id, "document_" + status, `Marked ${row.doc_type} as ${status}`, actor);
  return { success: true };
}

export async function removeDocument(id: string, docId: string, actor: Actor) {
  const row = check(await supabaseAdmin.from("school_documents").delete().eq("id", docId).eq("institution_id", id).select("doc_type").maybeSingle()) as { doc_type: string } | null;
  if (!row) throw new HttpError(404, "Document not found.");
  await logEvent(id, "document_removed", `Removed document ${row.doc_type}`, actor);
  return { success: true };
}

// ── readiness & approval ────────────────────────────────────
export async function getReadiness(id: string) {
  const school = await requireSchool(id);
  const [campuses, sub, admins, docs, mods] = await Promise.all([
    supabaseAdmin.from("campuses").select("*", { count: "exact", head: true }).eq("institution_id", id),
    supabaseAdmin.from("subscriptions").select("id, plans:plan_id(name)").eq("institution_id", id).eq("is_current", true).maybeSingle(),
    listAdmins(id),
    supabaseAdmin.from("school_documents").select("status").eq("institution_id", id),
    import("./modules.service").then((m) => m.getSchoolModules(id)),
  ]);
  const documents = check(docs) as { status: string }[];
  const planName = ((check(sub) as unknown as { plans: { name: string } | null } | null)?.plans?.name) ?? null;
  const checks = [
    { key: "documents", label: "Documents verified", done: documents.some((d) => d.status === "verified"), required: false, detail: `${documents.filter((d) => d.status === "verified").length} of ${documents.length} verified`, tab: "documents" },
    { key: "campus", label: "Campus created", done: (campuses.count ?? 0) > 0, required: true, detail: `${campuses.count ?? 0} campus(es)`, tab: "campuses" },
    { key: "plan", label: "Plan assigned", done: !!planName, required: true, detail: planName ?? "No plan", tab: "subscription" },
    { key: "admin", label: "School admin created", done: admins.admins.length > 0, required: true, detail: `${admins.admins.length} admin(s)`, tab: "admins" },
    { key: "modules", label: "Modules configured", done: mods.modules.some((m) => m.effective), required: false, detail: `${mods.modules.filter((m) => m.effective).length} modules on`, tab: "modules" },
  ];
  return { status: school.status as string, checks, ready: checks.filter((c) => c.required).every((c) => c.done) };
}

export async function approveSchool(id: string, target: "Trial" | "Active", force: boolean, actor: Actor) {
  const r = await getReadiness(id);
  if (r.status !== "Pending") throw new HttpError(409, "Only a school waiting for approval can be approved.");
  const missing = r.checks.filter((c) => c.required && !c.done).map((c) => c.label);
  if (missing.length) throw new HttpError(400, `Not ready yet: ${missing.join(", ").toLowerCase()}.`);
  if (!r.checks[0].done && !force) throw new HttpError(400, "No document has been verified. Verify one, or approve without documents.");
  const result = await setSchoolStatus(id, target);
  await logEvent(id, "approved", `Approved and moved to ${target}${r.checks[0].done ? "" : " without verified documents"}`, actor);
  return result;
}

// ── status actions (with a reason) ──────────────────────────
const ALLOWED: Record<string, string[]> = {
  activate: ["Pending", "Trial", "Expired", "Overdue"],
  deactivate: ["Trial", "Active", "Overdue"],
  suspend: ["Trial", "Active", "Overdue", "Inactive", "Expired"],
  reactivate: ["Suspended", "Expired", "Inactive"],
};
const TARGET: Record<string, "Active" | "Inactive" | "Suspended"> = { activate: "Active", deactivate: "Inactive", suspend: "Suspended", reactivate: "Active" };

export async function statusAction(id: string, action: "activate" | "deactivate" | "suspend" | "reactivate", reason: string | undefined, actor: Actor) {
  const school = await requireSchool(id);
  const from = school.status as string;
  if (!ALLOWED[action].includes(from)) throw new HttpError(409, `A school that is ${from.toLowerCase()} cannot be ${action}d.`);
  if ((action === "suspend" || action === "deactivate") && !reason?.trim()) throw new HttpError(400, "Give a reason. It is kept in the school's history.");
  if (action === "activate" && from === "Pending") {
    const r = await getReadiness(id);
    if (!r.ready) throw new HttpError(400, "A new school must be approved first, once its campus, plan and admin are set up.");
  }
  const to = TARGET[action];
  const result = await setSchoolStatus(id, to);
  check(await supabaseAdmin.from("institutions").update({ status_reason: reason?.trim() || null }).eq("id", id).select("id").single());
  clearEntitlementCache(id);
  await logEvent(id, "status_" + action, `${action[0].toUpperCase() + action.slice(1)}d: ${from} → ${to}${reason ? `. Reason: ${reason.trim()}` : ""}`, actor, { status: from }, { status: to });
  return result;
}

// ── applications ────────────────────────────────────────────
const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v || null);
export const applicationSchema = z.object({
  school_name: z.string().trim().min(2, "Enter the school's name.").max(255),
  contact_name: z.string().trim().min(2, "Enter a contact name.").max(150),
  contact_email: z.string().trim().email("Enter a valid email."),
  contact_phone: optText(50),
  city: optText(100),
  state: optText(100),
  board: optText(50),
  student_estimate: z.number().int().min(0).max(100000).nullable().optional(),
  plan_interest: optText(50),
  message: optText(1000),
});

export interface ApplicationInput {
  source?: "website" | "demo" | "referral";
  school_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone?: string | null;
  city?: string | null;
  state?: string | null;
  board?: string | null;
  student_estimate?: number | null;
  plan_interest?: string | null;
  message?: string | null;
}

export async function createApplication(input: ApplicationInput) {
  return check(await supabaseAdmin.from("school_applications").insert(input).select("id").single());
}

/** APP-0012 from the number the database gave the application. */
export const applicationCode = (seq: number) => "APP-" + String(seq).padStart(4, "0");

export async function listApplications(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("school_applications")
    .select("*, institutions:institution_id(name, code)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (["new", "in_review", "documents_pending", "converted", "rejected"].includes(String(query.status))) q = q.eq("status", String(query.status));
  if (["website", "demo", "referral"].includes(String(query.source))) q = q.eq("source", String(query.source));
  const search = safeSearch(query.search);
  if (search) q = q.or(`school_name.ilike.%${search}%,contact_name.ilike.%${search}%,contact_email.ilike.%${search}%`);
  const res = await q;
  const open = await supabaseAdmin.from("school_applications").select("*", { count: "exact", head: true }).in("status", ["new", "in_review", "documents_pending"]);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const count = (status: string, recent = false) => {
    let c = supabaseAdmin.from("school_applications").select("*", { count: "exact", head: true }).eq("status", status);
    if (recent) c = c.gte("decided_at", since);
    return c;
  };
  const [fresh, review, docs, rejected] = await Promise.all([count("new"), count("in_review"), count("documents_pending"), count("rejected", true)]);
  const items = (check(res) as unknown as { seq: number }[]).map((a) => ({ ...a, code: applicationCode(a.seq) }));
  return {
    items, total: res.count ?? 0, page: p.page, pageSize: p.pageSize, open: open.count ?? 0,
    counts: { new: fresh.count ?? 0, in_review: review.count ?? 0, documents_pending: docs.count ?? 0, rejected_30d: rejected.count ?? 0 },
  };
}

export async function updateApplication(id: string, patch: { status?: "new" | "in_review" | "documents_pending" | "rejected"; notes?: string | null }, actor: Actor) {
  const current = check(await supabaseAdmin.from("school_applications").select("status").eq("id", id).maybeSingle()) as { status: string } | null;
  if (!current) throw new HttpError(404, "Application not found.");
  if (current.status === "converted") throw new HttpError(409, "This application has already become a school.");
  const update: Record<string, unknown> = { ...patch };
  if (patch.status === "rejected") {
    if (!patch.notes?.trim()) throw new HttpError(400, "Say why the application was rejected.");
    update.decided_by = actor.profileId ?? null;
    update.decided_at = new Date().toISOString();
  }
  return check(await supabaseAdmin.from("school_applications").update(update).eq("id", id).select().single());
}

/** Turns an application into a school waiting for approval. */
export async function convertApplication(id: string, planCode: string | undefined, actor: Actor) {
  const app = check(await supabaseAdmin.from("school_applications").select("*").eq("id", id).maybeSingle()) as (ApplicationInput & { status: string }) | null;
  if (!app) throw new HttpError(404, "Application not found.");
  if (app.status === "converted") throw new HttpError(409, "This application has already become a school.");
  if (app.status === "rejected") throw new HttpError(409, "A rejected application cannot be converted.");
  const { createSchool } = await import("./schools.service");
  const created = await createSchool(
    {
      name: app.school_name, board: app.board ?? null, city: app.city ?? null, state: app.state ?? null,
      contact_name: app.contact_name, contact_email: app.contact_email, contact_phone: app.contact_phone ?? null,
      plan_code: planCode ?? app.plan_interest ?? "standard", status: "Pending",
    },
    actor.profileId
  );
  check(
    await supabaseAdmin
      .from("school_applications")
      .update({ status: "converted", institution_id: created.school.id, decided_by: actor.profileId ?? null, decided_at: new Date().toISOString() })
      .eq("id", id)
      .select("id")
      .single()
  );
  await logEvent(created.school.id, "created", `Registered from a ${app.source ?? "website"} application`, actor);
  return created;
}

// ── approval ────────────────────────────────────────────────
/** The numbers above the approval cards: what waits, and what was decided this month. */
export async function getApprovalStats() {
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const [waiting, approved, rejected] = await Promise.all([
    supabaseAdmin.from("institutions").select("created_at").eq("status", "Pending").is("deleted_at", null).order("created_at").limit(500),
    supabaseAdmin.from("school_events").select("created_at, institutions:institution_id(created_at)").eq("type", "approved").gte("created_at", monthStart).limit(1000),
    supabaseAdmin.from("school_events").select("summary").eq("type", "rejected").gte("created_at", monthStart).limit(1000),
  ]);
  const w = (check(waiting) as { created_at: string }[]);
  const a = check(approved) as unknown as { created_at: string; institutions: { created_at: string } | null }[];
  const days = a.map((e) => (Date.parse(e.created_at) - Date.parse(e.institutions?.created_at ?? e.created_at)) / 86_400_000).filter((d) => d >= 0);
  const reasons = (check(rejected) as { summary: string }[]).map((r) => r.summary.replace(/^Rejected: ?/, ""));
  return {
    waiting: w.length,
    oldest: w[0]?.created_at ?? null,
    approved_this_month: a.length,
    average_days: days.length ? Math.round((days.reduce((x, y) => x + y, 0) / days.length) * 10) / 10 : null,
    rejected_this_month: reasons.length,
    rejected_reason: reasons[0] ?? null,
  };
}

/** Turns a school that is waiting for approval down. Its data is kept, and nobody can sign in. */
export async function rejectSchool(id: string, reason: string, actor: Actor) {
  const school = await requireSchool(id);
  if (school.status !== "Pending") throw new HttpError(409, "Only a school waiting for approval can be rejected.");
  if (!reason.trim()) throw new HttpError(400, "Say why the school is being rejected.");
  const { setSchoolStatus } = await import("./schools.service");
  const result = await setSchoolStatus(id, "Inactive");
  await logEvent(id, "rejected", `Rejected: ${reason.trim()}`, actor);
  return result;
}

// ── every school administrator ──────────────────────────────
export const ACCESS_AREAS = ["users", "fees", "settings", "reports", "data_export"] as const;
export type AccessArea = (typeof ACCESS_AREAS)[number];

/** Administrators of every school, with who is primary and what each may open. */
export async function listAllAdmins(query: Record<string, unknown>) {
  const search = safeSearch(query.search);
  let q = supabaseAdmin
    .from("user_profiles")
    .select("id, email, first_name, last_name, status, designation, admin_access, institution_id, last_login_at, roles:role_id!inner(name), institutions:institution_id(id, name, code, status, primary_admin_id)")
    .eq("roles.name", "InstitutionAdmin")
    .not("institution_id", "is", null)
    .order("created_at")
    .limit(2000);
  if (search) q = q.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
  const rows = check(await q) as unknown as {
    id: string; email: string; first_name: string; last_name: string; status: string; designation: string | null; admin_access: Record<string, boolean>; institution_id: string;
    last_login_at: string | null; institutions: { id: string; name: string; code: string; status: string; primary_admin_id: string | null } | null;
  }[];
  const perSchool = new Map<string, number>();
  for (const r of rows) perSchool.set(r.institution_id, (perSchool.get(r.institution_id) ?? 0) + 1);
  return {
    admins: rows.map((r) => {
      const primary = r.institutions?.primary_admin_id ? r.institutions.primary_admin_id === r.id : rows.find((x) => x.institution_id === r.institution_id)?.id === r.id;
      const access = Object.fromEntries(ACCESS_AREAS.map((k) => [k, primary ? (k === "data_export" ? r.admin_access?.data_export !== false : true) : r.admin_access?.[k] !== false])) as Record<AccessArea, boolean>;
      return { id: r.id, name: `${r.first_name} ${r.last_name}`.trim(), email: r.email, status: r.status, designation: r.designation, is_primary: primary, school: r.institutions, access, others: (perSchool.get(r.institution_id) ?? 1) - 1 };
    }),
  };
}

/** Turns areas on or off for one school administrator. The primary administrator keeps everything except data export. */
export async function setAdminAccess(profileId: string, access: Partial<Record<AccessArea, boolean>>, actor: Actor) {
  const row = check(
    await supabaseAdmin.from("user_profiles").select("id, first_name, last_name, institution_id, admin_access, roles:role_id!inner(name)").eq("id", profileId).eq("roles.name", "InstitutionAdmin").maybeSingle()
  ) as unknown as { id: string; first_name: string; last_name: string; institution_id: string | null; admin_access: Record<string, boolean> } | null;
  if (!row?.institution_id) throw new HttpError(404, "School administrator not found.");
  const school = await requireSchool(row.institution_id);
  const primary = school.primary_admin_id === row.id;
  const next: Record<string, boolean> = { ...(row.admin_access ?? {}) };
  for (const [k, v] of Object.entries(access)) {
    if (!(ACCESS_AREAS as readonly string[]).includes(k)) throw new HttpError(400, `'${k}' is not an area.`);
    if (primary && k !== "data_export") throw new HttpError(400, "The primary administrator can always open everything except data export.");
    next[k] = !!v;
  }
  check(await supabaseAdmin.from("user_profiles").update({ admin_access: next }).eq("id", profileId).select("id").single());
  await logEvent(row.institution_id, "admin_access_changed", `Changed what ${row.first_name} ${row.last_name} can open`, actor, row.admin_access, next);
  return { success: true, access: next };
}

// ── documents across every school ───────────────────────────
export const REQUIRED_DOCS = {
  registration: ["Registration certificate", "Trust / society deed", "PAN of the trust", "State recognition certificate"],
  affiliation: ["Board affiliation certificate", "Affiliation renewal letter", "No-objection certificate (NOC)"],
} as const;
const NO_BOARD_DOCS = ["Play school", "Montessori"];

export type DocStatus = "verified" | "review" | "missing" | "expired" | "rejected";

/** The status a document shows: expired wins over verified, and a document nobody uploaded is missing. Pure, so it is easy to test. */
export function documentStatus(doc: { status: string; expiry_date: string | null } | null, today = new Date().toISOString().slice(0, 10)): DocStatus {
  if (!doc) return "missing";
  if (doc.status === "rejected") return "rejected";
  if (doc.expiry_date && doc.expiry_date < today) return "expired";
  return doc.status === "verified" ? "verified" : "review";
}

/** Every school's documents of one kind, with the ones that are still missing, for the Documents pages. */
export async function listDocumentOverview(category: "registration" | "affiliation") {
  const [schools, docs] = await Promise.all([
    supabaseAdmin.from("platform_school_overview").select("id, code, name, board, status").order("name").limit(2000),
    supabaseAdmin.from("school_documents").select("id, institution_id, doc_type, file_url, expiry_date, status, created_at").eq("category", category).order("created_at", { ascending: false }).limit(20_000),
  ]);
  const rows = check(docs) as { id: string; institution_id: string; doc_type: string; file_url: string | null; expiry_date: string | null; status: string; created_at: string }[];
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const d of rows) if (!byKey.has(d.institution_id + "|" + d.doc_type)) byKey.set(d.institution_id + "|" + d.doc_type, d);
  const fileName = (u: string | null) => (u ? decodeURIComponent(u.split("?")[0].split("/").pop() ?? "") || null : null);

  const out: { document_id: string | null; school: { id: string; code: string; name: string; status: string }; doc_type: string; file_name: string | null; uploaded_at: string | null; valid_until: string | null; status: DocStatus }[] = [];
  for (const s of check(schools) as { id: string; code: string; name: string; board: string | null; status: string }[]) {
    const required: string[] = category === "affiliation" && NO_BOARD_DOCS.includes(s.board ?? "") ? [] : [...REQUIRED_DOCS[category]];
    const types = [...new Set([...required, ...rows.filter((d) => d.institution_id === s.id).map((d) => d.doc_type)])];
    for (const t of types) {
      const d = byKey.get(s.id + "|" + t) ?? null;
      out.push({ document_id: d?.id ?? null, school: { id: s.id, code: s.code, name: s.name, status: s.status }, doc_type: t, file_name: fileName(d?.file_url ?? null), uploaded_at: d?.created_at ?? null, valid_until: d?.expiry_date ?? null, status: documentStatus(d) });
    }
  }
  const count = (st: DocStatus) => out.filter((r) => r.status === st).length;
  return { items: out, counts: { verified: count("verified"), review: count("review"), missing: count("missing"), expired: count("expired"), rejected: count("rejected") } };
}

/** Records that the school was asked for a document. It shows in the school's history. */
export async function requestDocument(id: string, docType: string, actor: Actor) {
  await requireSchool(id);
  await logEvent(id, "document_requested", `Asked the school to upload: ${docType}`, actor);
  return { success: true };
}
