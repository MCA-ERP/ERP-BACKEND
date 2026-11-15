import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { parsePage } from "../../lib/query";
import { clearPermissionCache } from "../../lib/permissions";
import { PAGES, clearPageCache } from "../../lib/role-pages";
import { clearEntitlementCache } from "../../lib/entitlements";
import type { Actor } from "./school-mgmt.service";

interface RoleRow {
  id: string; name: string; display_name: string; description: string | null; is_system_default: boolean;
  scope: "platform" | "school"; data_scope: "school" | "campus"; institution_id: string | null; created_at: string;
}
const ROLE_COLS = "id, name, display_name, description, is_system_default, scope, data_scope, institution_id, created_at";

async function getRole(id: string): Promise<RoleRow> {
  const r = check(await supabaseAdmin.from("roles").select(ROLE_COLS).eq("id", id).maybeSingle()) as RoleRow | null;
  if (!r) throw new HttpError(404, "Role not found.");
  return r;
}

// ═════════════ snapshots & history ═════════════
export interface Snapshot { permissions: string[]; modules: string[]; denied_pages: string[]; data_scope: string }

async function codesFor(roleId: string): Promise<string[]> {
  const rows = check(await supabaseAdmin.from("role_permissions").select("permissions(code)").eq("role_id", roleId)) as unknown as { permissions: { code: string } | null }[];
  return rows.map((r) => r.permissions?.code).filter((c): c is string => !!c).sort();
}
async function snapshot(role: RoleRow): Promise<Snapshot> {
  const [permissions, mods, pages] = await Promise.all([
    codesFor(role.id),
    supabaseAdmin.from("role_modules").select("module_code").eq("role_id", role.id),
    supabaseAdmin.from("role_page_denials").select("page_key").eq("role_id", role.id),
  ]);
  return {
    permissions,
    modules: (check(mods) as { module_code: string }[]).map((m) => m.module_code).sort(),
    denied_pages: (check(pages) as { page_key: string }[]).map((p) => p.page_key).sort(),
    data_scope: role.data_scope,
  };
}

async function record(role: { id: string | null; name: string }, type: string, summary: string, actor: Actor, diff: { added?: string[]; removed?: string[] } = {}) {
  let snap: Snapshot | null = null;
  if (role.id && type !== "deleted") {
    const r = check(await supabaseAdmin.from("roles").select(ROLE_COLS).eq("id", role.id).maybeSingle()) as RoleRow | null;
    if (r) snap = await snapshot(r);
  }
  const res = await supabaseAdmin.from("role_changes").insert({
    role_id: role.id, role_name: role.name, change_type: type, summary, added: diff.added ?? [], removed: diff.removed ?? [],
    snapshot: snap, actor_id: actor.profileId ?? null, actor_name: actor.name,
  });
  if (res.error) console.error("Role change not recorded:", res.error.message);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const delta = (before: string[], after: string[]) => ({ added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) });

// ═════════════ catalogue ═════════════
export async function listRoles() {
  const [roles, users, perms, mods, denials, schools] = await Promise.all([
    supabaseAdmin.from("roles").select(ROLE_COLS).order("created_at"),
    supabaseAdmin.from("user_profiles").select("role_id").limit(50000),
    supabaseAdmin.from("role_permissions").select("role_id"),
    supabaseAdmin.from("role_modules").select("role_id"),
    supabaseAdmin.from("role_page_denials").select("role_id"),
    supabaseAdmin.from("institutions").select("id, name").is("deleted_at", null),
  ]);
  const count = (rows: { role_id: string }[]) => { const m = new Map<string, number>(); rows.forEach((r) => m.set(r.role_id, (m.get(r.role_id) ?? 0) + 1)); return m; };
  const u = count(check(users) as { role_id: string }[]);
  const p = count(check(perms) as { role_id: string }[]);
  const m = count(check(mods) as { role_id: string }[]);
  const d = count(check(denials) as { role_id: string }[]);
  const schoolName = new Map((check(schools) as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  return (check(roles) as RoleRow[]).map((r) => ({
    ...r, user_count: u.get(r.id) ?? 0, permission_count: p.get(r.id) ?? 0, restricted_modules: m.get(r.id) ?? 0, denied_pages: d.get(r.id) ?? 0,
    school_name: r.institution_id ? schoolName.get(r.institution_id) ?? null : null,
  }));
}

function slug(display: string): string {
  const s = display.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return s.slice(0, 40);
}

export const roleSchema = z.object({
  display_name: z.string().trim().min(3, "Give the role a name of at least 3 letters.").max(100),
  description: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
  scope: z.enum(["platform", "school"]),
  institution_id: z.string().uuid().nullable().optional(),
  data_scope: z.enum(["school", "campus"]).optional(),
  copy_from: z.string().uuid().nullable().optional(),
});

export async function createRole(input: z.infer<typeof roleSchema>, actor: Actor) {
  let { scope, data_scope } = input;
  let source: RoleRow | null = null;
  if (input.copy_from) {
    source = await getRole(input.copy_from);
    if (source.name === "SuperAdmin") throw new HttpError(400, "The Super Administrator role cannot be copied.");
    scope = source.scope;
    data_scope = data_scope ?? source.data_scope;
  }
  if (scope === "platform" && input.institution_id) throw new HttpError(400, "A platform role cannot belong to one school.");
  if (input.institution_id) {
    const s = check(await supabaseAdmin.from("institutions").select("id").eq("id", input.institution_id).is("deleted_at", null).maybeSingle());
    if (!s) throw new HttpError(404, "School not found.");
  }
  const base = slug(input.display_name);
  if (base.length < 3) throw new HttpError(400, "Use letters or digits in the role's name.");

  let name = base;
  for (let n = 2; n < 50; n++) {
    const clash = check(await supabaseAdmin.from("roles").select("id").eq("name", name).maybeSingle());
    if (!clash) break;
    name = `${base}${n}`;
  }
  const dupName = check(await supabaseAdmin.from("roles").select("id").ilike("display_name", input.display_name).maybeSingle());
  if (dupName) throw new HttpError(409, `A role called "${input.display_name}" already exists.`);

  const created = check(
    await supabaseAdmin.from("roles").insert({
      name, display_name: input.display_name, description: input.description, is_system_default: false, scope,
      data_scope: data_scope ?? "school", institution_id: scope === "school" ? input.institution_id ?? null : null, created_by: actor.profileId ?? null,
    }).select(ROLE_COLS).single()
  ) as RoleRow;

  if (source) {
    const [perms, mods, pages] = await Promise.all([
      supabaseAdmin.from("role_permissions").select("permission_id").eq("role_id", source.id),
      supabaseAdmin.from("role_modules").select("module_code").eq("role_id", source.id),
      supabaseAdmin.from("role_page_denials").select("page_key").eq("role_id", source.id),
    ]);
    const pr = check(perms) as { permission_id: string }[];
    const mr = check(mods) as { module_code: string }[];
    const gr = check(pages) as { page_key: string }[];
    if (pr.length) check(await supabaseAdmin.from("role_permissions").insert(pr.map((x) => ({ role_id: created.id, permission_id: x.permission_id }))).select("role_id"));
    if (mr.length) check(await supabaseAdmin.from("role_modules").insert(mr.map((x) => ({ role_id: created.id, module_code: x.module_code }))).select("role_id"));
    if (gr.length) check(await supabaseAdmin.from("role_page_denials").insert(gr.map((x) => ({ role_id: created.id, page_key: x.page_key }))).select("role_id"));
  }
  clearPermissionCache();
  await record(created, source ? "copied" : "created", source ? `Copied from ${source.display_name}` : "Role created", actor);
  return created;
}

export async function updateRole(id: string, patch: { display_name?: string; description?: string | null; data_scope?: "school" | "campus" }, actor: Actor) {
  const role = await getRole(id);
  if (role.name === "SuperAdmin") throw new HttpError(400, "The Super Administrator role is fixed.");
  if (role.is_system_default && patch.display_name && patch.display_name !== role.display_name) throw new HttpError(400, "A default role keeps its name. You can change its description and data scope.");
  if (patch.data_scope && role.scope === "platform") throw new HttpError(400, "Data scope applies to school roles.");
  if (patch.display_name) {
    const clash = check(await supabaseAdmin.from("roles").select("id").ilike("display_name", patch.display_name).neq("id", id).maybeSingle());
    if (clash) throw new HttpError(409, `A role called "${patch.display_name}" already exists.`);
  }
  const row = check(await supabaseAdmin.from("roles").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select(ROLE_COLS).single()) as RoleRow;
  const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== (role as unknown as Record<string, unknown>)[k]);
  if (changed.length) await record(row, patch.data_scope && patch.data_scope !== role.data_scope ? "data_scope" : "updated", `Changed ${changed.join(", ").replace(/_/g, " ")}${patch.data_scope && patch.data_scope !== role.data_scope ? `: ${role.data_scope} → ${patch.data_scope}` : ""}`, actor);
  return row;
}

export async function deleteRole(id: string, actor: Actor) {
  const role = await getRole(id);
  if (role.is_system_default) throw new HttpError(400, "A default role cannot be deleted.");
  const n = await supabaseAdmin.from("user_profiles").select("*", { count: "exact", head: true }).eq("role_id", id);
  if ((n.count ?? 0) > 0) throw new HttpError(409, `${n.count} user(s) still have this role. Move them to another role first.`);
  check(await supabaseAdmin.from("roles").delete().eq("id", id).select("id"));
  clearPermissionCache();
  await record({ id: null, name: role.name }, "deleted", `Deleted role ${role.display_name}`, actor);
  return { success: true };
}

// ═════════════ permissions ═════════════
export async function setPermissions(roleId: string, permissionIds: string[], actor: Actor, note = "Permissions changed") {
  const role = await getRole(roleId);
  if (role.name === "SuperAdmin") throw new HttpError(400, "SuperAdmin permissions are fixed.");
  const unique = Array.from(new Set(permissionIds));
  const found = unique.length ? (check(await supabaseAdmin.from("permissions").select("id, code").in("id", unique)) as { id: string; code: string }[]) : [];
  if (found.length !== unique.length) throw new HttpError(400, "One or more permissions do not exist.");

  // a platform role holds only platform permissions; a school role holds none of them
  const wrong = found.filter((p) => p.code.startsWith("platform.") !== (role.scope === "platform")).map((p) => p.code);
  if (wrong.length) throw new HttpError(400, `${role.scope === "platform" ? "A platform role can only hold platform permissions" : "A school role cannot hold platform permissions"}: ${wrong.slice(0, 3).join(", ")}.`);

  const before = await codesFor(roleId);
  check(await supabaseAdmin.from("role_permissions").delete().eq("role_id", roleId).select("role_id"));
  if (unique.length) check(await supabaseAdmin.from("role_permissions").insert(unique.map((permission_id) => ({ role_id: roleId, permission_id }))).select("role_id"));
  clearPermissionCache();

  const after = found.map((p) => p.code).sort();
  const d = delta(before, after);
  if (d.added.length || d.removed.length) await record(role, "permissions", `${note}: ${d.added.length} added, ${d.removed.length} removed`, actor, d);
  return { id: roleId, permission_ids: unique };
}

// ═════════════ module access per role ═════════════
export async function getModuleAccess() {
  const [roles, mods, rows] = await Promise.all([
    supabaseAdmin.from("roles").select("id, name, display_name, scope, is_system_default").eq("scope", "school").order("created_at"),
    supabaseAdmin.from("modules").select("code, name, category, is_core, sort_order").order("sort_order"),
    supabaseAdmin.from("role_modules").select("role_id, module_code"),
  ]);
  const access: Record<string, string[]> = {};
  (check(rows) as { role_id: string; module_code: string }[]).forEach((r) => (access[r.role_id] = [...(access[r.role_id] ?? []), r.module_code]));
  return { roles: check(roles), modules: check(mods), access };
}

/** An empty list means the role can open every module its school has. */
export async function setModuleAccess(roleId: string, codes: string[], actor: Actor) {
  const role = await getRole(roleId);
  if (role.scope !== "school") throw new HttpError(400, "Module access applies to school roles.");
  if (role.name === "InstitutionAdmin" && codes.length) throw new HttpError(400, "School administrators always have every module their school has.");
  const known = new Set((check(await supabaseAdmin.from("modules").select("code")) as { code: string }[]).map((m) => m.code));
  const bad = codes.filter((c) => !known.has(c));
  if (bad.length) throw new HttpError(400, `Unknown module(s): ${bad.join(", ")}`);
  const before = (check(await supabaseAdmin.from("role_modules").select("module_code").eq("role_id", roleId)) as { module_code: string }[]).map((r) => r.module_code);
  const after = Array.from(new Set(codes));
  check(await supabaseAdmin.from("role_modules").delete().eq("role_id", roleId).select("role_id"));
  if (after.length) check(await supabaseAdmin.from("role_modules").insert(after.map((module_code) => ({ role_id: roleId, module_code }))).select("role_id"));
  clearPermissionCache();
  clearEntitlementCache();
  if (!sameSet(before, after)) await record(role, "modules", after.length ? `Module access limited to ${after.length} module(s)` : "Module access opened to every module", actor, delta(before, after));
  return { role_id: roleId, modules: after };
}

// ═════════════ page access (platform roles) ═════════════
export async function getPageAccess() {
  const [roles, rows] = await Promise.all([
    supabaseAdmin.from("roles").select("id, name, display_name").eq("scope", "platform").neq("name", "SuperAdmin").order("created_at"),
    supabaseAdmin.from("role_page_denials").select("role_id, page_key"),
  ]);
  const denied: Record<string, string[]> = {};
  (check(rows) as { role_id: string; page_key: string }[]).forEach((r) => (denied[r.role_id] = [...(denied[r.role_id] ?? []), r.page_key]));
  return { pages: PAGES, roles: check(roles), denied };
}

export async function setPageAccess(roleId: string, deniedKeys: string[], actor: Actor) {
  const role = await getRole(roleId);
  if (role.scope !== "platform" || role.name === "SuperAdmin") throw new HttpError(400, "Page access applies to platform roles other than Super Administrator.");
  const valid = new Set(PAGES.map((p) => p.key));
  const bad = deniedKeys.filter((k) => !valid.has(k));
  if (bad.length) throw new HttpError(400, `Unknown page(s): ${bad.join(", ")}`);
  const before = (check(await supabaseAdmin.from("role_page_denials").select("page_key").eq("role_id", roleId)) as { page_key: string }[]).map((r) => r.page_key);
  const after = Array.from(new Set(deniedKeys));
  check(await supabaseAdmin.from("role_page_denials").delete().eq("role_id", roleId).select("role_id"));
  if (after.length) check(await supabaseAdmin.from("role_page_denials").insert(after.map((page_key) => ({ role_id: roleId, page_key }))).select("role_id"));
  clearPageCache();
  if (!sameSet(before, after)) await record(role, "pages", `${after.length} page(s) blocked`, actor, { added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) });
  return { role_id: roleId, denied: after };
}

// ═════════════ assignment ═════════════
async function assertAssignable(role: RoleRow, users: { id: string; institution_id: string | null; first_name: string }[], actor: Actor, actorRole?: string) {
  if (role.name === "SuperAdmin" && actorRole !== "SuperAdmin") throw new HttpError(403, "Only a Super Administrator can give the Super Administrator role.");
  for (const u of users) {
    if (u.id === actor.profileId) throw new HttpError(400, "You cannot change your own role.");
    if (role.scope === "platform" && u.institution_id) throw new HttpError(400, `${u.first_name} belongs to a school, so cannot hold a platform role.`);
    if (role.scope === "school" && !u.institution_id) throw new HttpError(400, `${u.first_name} is on the platform team, so cannot hold a school role.`);
    if (role.institution_id && u.institution_id !== role.institution_id) throw new HttpError(400, `This role belongs to one school and ${u.first_name} is not in it.`);
  }
}

/** The last active Super Administrator can never be moved off the role. */
async function assertSuperAdminRemains(leaving: { id: string }[], fromRole: RoleRow, toRole: RoleRow) {
  if (fromRole.name !== "SuperAdmin" || toRole.name === "SuperAdmin") return;
  const rows = check(await supabaseAdmin.from("user_profiles").select("id").eq("role_id", fromRole.id).eq("status", "active")) as { id: string }[];
  const remaining = rows.filter((r) => !leaving.some((l) => l.id === r.id));
  if (!remaining.length) throw new HttpError(409, "At least one active Super Administrator must remain.");
}

async function move(userIds: string[], to: RoleRow, actor: Actor, actorRole: string | undefined, from?: RoleRow) {
  if (!userIds.length) throw new HttpError(400, "Choose at least one user.");
  const users = check(await supabaseAdmin.from("user_profiles").select("id, institution_id, first_name, role_id").in("id", userIds)) as { id: string; institution_id: string | null; first_name: string; role_id: string }[];
  if (users.length !== new Set(userIds).size) throw new HttpError(404, "One or more users were not found.");
  await assertAssignable(to, users, actor, actorRole);
  const fromIds = Array.from(new Set(users.map((u) => u.role_id)));
  const fromRoles = check(await supabaseAdmin.from("roles").select(ROLE_COLS).in("id", fromIds)) as RoleRow[];
  for (const fr of fromRoles) {
    if (fr.name === "SuperAdmin" && actorRole !== "SuperAdmin") throw new HttpError(403, "Only a Super Administrator can change a Super Administrator.");
    await assertSuperAdminRemains(users.filter((u) => u.role_id === fr.id), fr, to);
  }
  check(await supabaseAdmin.from("user_profiles").update({ role_id: to.id, updated_at: new Date().toISOString() }).in("id", users.map((u) => u.id)).select("id"));
  clearPermissionCache();
  const names = fromRoles.map((r) => r.display_name).join(", ");
  await record(to, "assigned", `${users.length} user(s) given this role${names ? ` (from ${names})` : ""}`, actor);
  for (const fr of fromRoles) if (fr.id !== to.id) await record(fr, "assigned", `${users.filter((u) => u.role_id === fr.id).length} user(s) moved to ${to.display_name}`, actor);
  void from;
  return { moved: users.length };
}

export async function assignUsers(roleId: string, userIds: string[], actor: Actor, actorRole?: string) {
  return move(userIds, await getRole(roleId), actor, actorRole);
}

/** Moves everyone (or the chosen people) from one role to another. */
export async function reassign(fromId: string, toId: string, userIds: string[] | undefined, actor: Actor, actorRole?: string) {
  if (fromId === toId) throw new HttpError(400, "Choose two different roles.");
  const [from, to] = [await getRole(fromId), await getRole(toId)];
  let ids = userIds;
  if (!ids?.length) ids = (check(await supabaseAdmin.from("user_profiles").select("id").eq("role_id", fromId)) as { id: string }[]).map((u) => u.id);
  if (!ids.length) throw new HttpError(400, `Nobody has the ${from.display_name} role.`);
  return move(ids, to, actor, actorRole, from);
}

export async function roleUsers(roleId: string, search?: string) {
  let q = supabaseAdmin.from("user_profiles").select("id, email, first_name, last_name, status, institutions:institution_id(name)").eq("role_id", roleId).order("first_name").limit(200);
  if (search) q = q.or(`email.ilike.%${search.replace(/[,()%*\\]/g, " ")}%,first_name.ilike.%${search.replace(/[,()%*\\]/g, " ")}%`);
  return check(await q);
}

// ═════════════ audit ═════════════
export async function listChanges(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("role_changes")
    .select("id, role_id, role_name, change_type, summary, added, removed, actor_name, created_at, roles:role_id(display_name)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);
  if (typeof query.role === "string" && /^[0-9a-f-]{36}$/i.test(query.role)) q = q.eq("role_id", query.role);
  if (typeof query.type === "string" && /^[a-z_]{1,20}$/.test(query.type)) q = q.eq("change_type", query.type);
  const res = await q;
  return { items: check(res), total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

export async function history(roleId: string) {
  const role = await getRole(roleId);
  const versions = check(
    await supabaseAdmin.from("role_changes").select("id, change_type, summary, added, removed, snapshot, actor_name, created_at").eq("role_id", roleId).not("snapshot", "is", null).order("created_at", { ascending: false }).limit(100)
  );
  return { role, versions };
}

/** Puts a role back to how it was in an earlier version. */
export async function restore(roleId: string, changeId: string, actor: Actor) {
  const role = await getRole(roleId);
  if (role.name === "SuperAdmin") throw new HttpError(400, "The Super Administrator role is fixed.");
  const ver = check(await supabaseAdmin.from("role_changes").select("snapshot, created_at").eq("id", changeId).eq("role_id", roleId).maybeSingle()) as { snapshot: Snapshot | null; created_at: string } | null;
  if (!ver?.snapshot) throw new HttpError(404, "That version was not found.");
  const snap = ver.snapshot;

  // permissions that no longer exist are skipped rather than failing the whole restore
  const perms = snap.permissions.length ? (check(await supabaseAdmin.from("permissions").select("id, code").in("code", snap.permissions)) as { id: string; code: string }[]) : [];
  await setPermissions(roleId, perms.map((p) => p.id), actor, "Restored permissions");
  if (role.scope === "school") {
    await setModuleAccess(roleId, snap.modules, actor).catch(() => undefined);
    if (snap.data_scope && snap.data_scope !== role.data_scope) await updateRole(roleId, { data_scope: snap.data_scope as "school" | "campus" }, actor);
  } else {
    await setPageAccess(roleId, snap.denied_pages, actor).catch(() => undefined);
  }
  await record(role, "restored", `Restored the version from ${new Date(ver.created_at).toISOString().slice(0, 16).replace("T", " ")}`, actor);
  return { success: true, skipped: snap.permissions.length - perms.length };
}
