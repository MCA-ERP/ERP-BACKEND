import { supabaseAdmin, supabasePublic } from "../../../db/client";

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────
export interface LoginPayload {
  email: string;
  password: string;
}

export interface AuthSession {
  token: string;
  refreshToken: string;
  expiresAt: number | undefined;
  user: {
    id: string;
    email: string | undefined;
    profileId: string | undefined;
    fullName: string;
    role: string;
    roleDisplayName: string;
    institutionId: string | undefined;
    campusId: string | undefined;
  };
}

export interface RoleItem {
  name: string;
  display_name: string;
  description?: string;
}

// ─────────────────────────────────────────────
//  Service Methods
// ─────────────────────────────────────────────

/**
 * Authenticate user with email + password via Supabase Auth.
 */
export async function loginUser(payload: LoginPayload): Promise<AuthSession> {
  const { email, password } = payload;

  const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(error?.message ?? "Invalid credentials.");
  }

  const { data: profile } = await supabaseAdmin
    .from("user_profiles")
    .select("id, role_id, institution_id, campus_id, first_name, last_name, roles:role_id(name, display_name)")
    .eq("auth_user_id", data.user.id)
    .single();

  const roleData = (profile?.roles as unknown as { name?: string; display_name?: string }) ?? {};

  return {
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: {
      id: data.user.id,
      email: data.user.email,
      profileId: profile?.id,
      fullName: profile ? `${profile.first_name} ${profile.last_name}` : email.split("@")[0],
      role: roleData.name ?? "SuperAdmin",
      roleDisplayName: roleData.display_name ?? "Super Administrator",
      institutionId: profile?.institution_id,
      campusId: profile?.campus_id,
    },
  };
}

/**
 * Fetch role + permissions for the currently logged-in user.
 */
export async function getUserProfile(roleName: string) {
  const { data: rolePermissions } = await supabaseAdmin
    .from("roles")
    .select("id, name, display_name, role_permissions(permissions(code, module))")
    .eq("name", roleName)
    .single();

  return rolePermissions ?? null;
}

/**
 * List all ERP roles from the DB; falls back to static defaults.
 */
export async function listRoles(): Promise<RoleItem[]> {
  const { data: roles, error } = await supabaseAdmin
    .from("roles")
    .select("id, name, display_name, description")
    .order("name", { ascending: true });

  if (error || !roles?.length) {
    return [
      { name: "SuperAdmin", display_name: "Super Administrator" },
      { name: "InstitutionAdmin", display_name: "Institution Administrator" },
      { name: "Principal", display_name: "Principal / Director" },
      { name: "Registrar", display_name: "Registrar / Academic Office" },
      { name: "Faculty", display_name: "Faculty / Teacher" },
      { name: "Student", display_name: "Student" },
      { name: "Parent", display_name: "Parent / Guardian" },
      { name: "Accountant", display_name: "Accountant" },
    ];
  }

  return roles;
}
