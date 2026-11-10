import { supabaseAdmin } from "../../../db/client";
import { assertRoomFor } from "../../lib/plan-limits";
import { clearPermissionCache } from "../../lib/permissions";
import { HttpError } from "../../lib/http-error";
import { checkPassword } from "../../lib/password-policy";
import { check } from "../../lib/db";
import { getSetting } from "./settings.service";
import { parsePage, safeSearch } from "../../lib/query";

export { HttpError };

// ─────────────────────────────────────────────
//  Campuses
// ─────────────────────────────────────────────
export async function listCampuses(institutionId: string) {
  return check(
    await supabaseAdmin
      .from("campuses")
      .select("*")
      .eq("institution_id", institutionId)
      .order("created_at", { ascending: true })
  );
}

export async function createCampus(institutionId: string, input: Record<string, any>) {
  await assertRoomFor(institutionId, "campus");
  return check(
    await supabaseAdmin
      .from("campuses")
      .insert({ ...input, institution_id: institutionId })
      .select()
      .single()
  );
}

// ─────────────────────────────────────────────
//  Users
// ─────────────────────────────────────────────
const USER_SELECT =
  "id, auth_user_id, email, first_name, last_name, phone, status, last_login_at, created_at, " +
  "institution_id, campus_id, role_id, roles:role_id(name, display_name), institutions:institution_id(name, code)";

export async function listUsers(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("user_profiles")
    .select(USER_SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);

  const search = safeSearch(query.search);
  if (search) q = q.or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);
  if (query.status) q = q.eq("status", String(query.status));
  if (query.role) {
    const role = check(
      await supabaseAdmin.from("roles").select("id").eq("name", String(query.role)).maybeSingle()
    ) as { id: string } | null;
    if (!role) return { items: [], total: 0, page: p.page, pageSize: p.pageSize };
    q = q.eq("role_id", role.id);
  }

  const res = await q;
  const data = check(res);
  return { items: data, total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}

async function roleIdByName(name: string): Promise<string> {
  const role = check(
    await supabaseAdmin.from("roles").select("id").eq("name", name).maybeSingle()
  ) as { id: string } | null;
  if (!role) throw new HttpError(400, `Unknown role '${name}'.`);
  return role.id;
}

export async function createUser(input: {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  phone?: string;
  role: string;
  institution_id?: string | null;
  campus_id?: string | null;
  must_change_password?: boolean;
}, actorRole?: string) {
  if (input.role === "SuperAdmin" && actorRole !== "SuperAdmin") throw new HttpError(403, "Only a Super Administrator can create another Super Administrator.");
  if (input.institution_id && !["SuperAdmin", "Student", "Parent"].includes(input.role)) await assertRoomFor(input.institution_id, "staff");
  await checkPassword(input.password, [input.email, input.email.split("@")[0]]);
  const roleId = await roleIdByName(input.role);
  const email = input.email.toLowerCase();

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: `${input.first_name} ${input.last_name}`.trim() },
  });
  if (authError || !authData.user) {
    const exists = /already|registered|exists/i.test(authError?.message ?? "");
    throw new HttpError(exists ? 409 : 400, authError?.message ?? "Failed to create auth user.");
  }

  const res = await supabaseAdmin
    .from("user_profiles")
    .insert({
      auth_user_id: authData.user.id,
      email,
      first_name: input.first_name,
      last_name: input.last_name,
      phone: input.phone || null,
      role_id: roleId,
      institution_id: input.institution_id || null,
      campus_id: input.campus_id || null,
      must_change_password: input.must_change_password ?? false,
      status: "active",
    })
    .select(USER_SELECT)
    .single();

  if (res.error) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    check({ data: null, error: res.error });
  }
  return res.data;
}

export async function updateUser(id: string, actorProfileId: string | undefined, patch: Record<string, any>, actorRole?: string) {
  const { role, ...rest } = patch;
  if (role === "SuperAdmin" && actorRole !== "SuperAdmin") throw new HttpError(403, "Only a Super Administrator can assign the Super Administrator role.");
  const update: Record<string, any> = { ...rest, updated_at: new Date().toISOString() };

  if (id === actorProfileId) {
    if (role !== undefined || (rest.status !== undefined && rest.status !== "active")) {
      throw new HttpError(400, "You cannot change your own role or suspend your own account.");
    }
  }
  if (role !== undefined) update.role_id = await roleIdByName(role);

  const data = check(
    await supabaseAdmin.from("user_profiles").update(update).eq("id", id).select(USER_SELECT).maybeSingle()
  ) as { auth_user_id?: string | null } | null;
  if (!data) throw new HttpError(404, "User not found.");

  // Suspending also blocks new sign-ins at the identity provider.
  if (rest.status && data.auth_user_id) {
    await supabaseAdmin.auth.admin.updateUserById(data.auth_user_id, {
      ban_duration: rest.status === "active" ? "none" : "876000h",
    });
  }
  return data;
}

// ─────────────────────────────────────────────
//  Roles & permissions
// ─────────────────────────────────────────────
export async function listRolesWithPermissions() {
  const roles = check(
    await supabaseAdmin
      .from("roles")
      .select("id, name, display_name, description, is_system_default, scope, data_scope, institution_id, role_permissions(permission_id)")
      .order("name", { ascending: true })
  ) as any[];

  const counts = check(await supabaseAdmin.from("user_profiles").select("role_id")) as { role_id: string }[];
  const userCount = new Map<string, number>();
  counts.forEach((c) => userCount.set(c.role_id, (userCount.get(c.role_id) ?? 0) + 1));

  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    display_name: r.display_name,
    description: r.description,
    is_system_default: r.is_system_default,
    scope: r.scope,
    data_scope: r.data_scope,
    institution_id: r.institution_id,
    permission_ids: (r.role_permissions ?? []).map((rp: { permission_id: string }) => rp.permission_id),
    user_count: userCount.get(r.id) ?? 0,
  }));
}

export async function listPermissions() {
  return check(
    await supabaseAdmin.from("permissions").select("id, code, module, description").order("code", { ascending: true })
  );
}

export async function setRolePermissions(roleId: string, permissionIds: string[]) {
  const role = check(
    await supabaseAdmin.from("roles").select("id, name").eq("id", roleId).maybeSingle()
  ) as { id: string; name: string } | null;
  if (!role) throw new HttpError(404, "Role not found.");
  if (role.name === "SuperAdmin") throw new HttpError(400, "SuperAdmin permissions are fixed.");

  const unique = Array.from(new Set(permissionIds));
  if (unique.length) {
    const found = check(await supabaseAdmin.from("permissions").select("id").in("id", unique)) as { id: string }[];
    if (found.length !== unique.length) throw new HttpError(400, "One or more permissions do not exist.");
  }

  check(await supabaseAdmin.from("role_permissions").delete().eq("role_id", roleId));
  if (unique.length) {
    check(
      await supabaseAdmin
        .from("role_permissions")
        .insert(unique.map((permission_id) => ({ role_id: roleId, permission_id })))
    );
  }
  clearPermissionCache();
  return { id: roleId, permission_ids: unique };
}

// ─────────────────────────────────────────────
//  Audit logs
// ─────────────────────────────────────────────
export async function listAuditLogs(query: Record<string, unknown>) {
  const p = parsePage(query);
  let q = supabaseAdmin
    .from("audit_logs")
    .select("id, actor_email, action, entity_name, entity_id, new_data, ip_address, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(p.from, p.to);

  const search = safeSearch(query.search);
  if (search) q = q.or(`actor_email.ilike.%${search}%,action.ilike.%${search}%,entity_name.ilike.%${search}%`);

  const res = await q;
  const data = check(res);
  return { items: data, total: res.count ?? 0, page: p.page, pageSize: p.pageSize };
}
