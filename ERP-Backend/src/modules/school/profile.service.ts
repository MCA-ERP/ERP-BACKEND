import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** The signed-in person's own record: who they are, where they work, and the details they keep. */
export async function getMyProfile(profileId: string) {
  const p = check(
    await supabaseAdmin
      .from("user_profiles")
      .select("id, first_name, last_name, email, phone, created_at, status, roles:role_id(name, display_name), campuses:campus_id(name), institutions:institution_id(name)")
      .eq("id", profileId)
      .maybeSingle()
  ) as unknown as {
    id: string; first_name: string; last_name: string; email: string; phone: string | null; created_at: string; status: string | null;
    roles: { name: string; display_name: string } | { name: string; display_name: string }[] | null;
    campuses: { name: string } | { name: string }[] | null;
    institutions: { name: string } | { name: string }[] | null;
  } | null;
  if (!p) throw new HttpError(404, "Profile not found.");
  const details = check(await supabaseAdmin.from("staff_contact_details").select("*").eq("profile_id", profileId).maybeSingle()) as Record<string, string | null> | null;
  const role = one(p.roles);
  return {
    id: p.id,
    name: `${p.first_name} ${p.last_name}`.trim(),
    first_name: p.first_name,
    last_name: p.last_name,
    email: p.email,
    mobile: p.phone,
    designation: role?.display_name ?? "",
    joined_on: p.created_at,
    campus: one(p.campuses)?.name ?? null,
    school: one(p.institutions)?.name ?? null,
    status: p.status === "active" || !p.status ? "Active" : "Inactive",
    contact: {
      alt_phone: details?.alt_phone ?? "", personal_email: details?.personal_email ?? "", date_of_birth: details?.date_of_birth ?? "", blood_group: details?.blood_group ?? "",
      home_address: details?.home_address ?? "", emergency_name: details?.emergency_name ?? "", emergency_relation: details?.emergency_relation ?? "", emergency_phone: details?.emergency_phone ?? "",
    },
  };
}

export interface ContactInput {
  mobile?: string; alt_phone?: string; personal_email?: string; date_of_birth?: string; blood_group?: string;
  home_address?: string; emergency_name?: string; emergency_relation?: string; emergency_phone?: string;
}

/** Saves the contact details. The official email is set by the school and cannot be changed here. */
export async function saveContact(profileId: string, input: ContactInput) {
  if (input.mobile !== undefined) check(await supabaseAdmin.from("user_profiles").update({ phone: input.mobile || null, updated_at: new Date().toISOString() }).eq("id", profileId).select("id"));
  const row = {
    profile_id: profileId,
    alt_phone: input.alt_phone || null, personal_email: input.personal_email || null, date_of_birth: input.date_of_birth || null, blood_group: input.blood_group || null,
    home_address: input.home_address || null, emergency_name: input.emergency_name || null, emergency_relation: input.emergency_relation || null, emergency_phone: input.emergency_phone || null,
    updated_at: new Date().toISOString(),
  };
  check(await supabaseAdmin.from("staff_contact_details").upsert(row, { onConflict: "profile_id" }).select("profile_id"));
  return getMyProfile(profileId);
}

export async function listQualifications(profileId: string) {
  return check(await supabaseAdmin.from("staff_qualifications").select("id, title, institution, year, result, status, created_at").eq("profile_id", profileId).order("year", { ascending: false })) as unknown[];
}

export async function addQualification(profileId: string, input: { title: string; institution: string; year: number; result?: string }) {
  return check(
    await supabaseAdmin.from("staff_qualifications").insert({ profile_id: profileId, title: input.title, institution: input.institution, year: input.year, result: input.result || null }).select("id, title, institution, year, result, status").single()
  );
}
