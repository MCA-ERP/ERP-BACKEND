import { supabaseAdmin } from "../../../db/client";
import { HttpError } from "../../lib/http-error";

export interface RegisterSchoolPayload {
  name: string;
  code?: string;
  type?: string;
  contact_email?: string;
  contact_phone?: string;
  address?: string;
  city?: string;
  state?: string;
  website?: string;
}

/** One institution with its campuses and academic years. `null` means "the first one" (SuperAdmin view). */
export async function getInstitution(institutionId: string | null) {
  let q = supabaseAdmin.from("institutions").select("*, campuses(*), academic_years(*)");
  q = institutionId ? q.eq("id", institutionId) : q.order("created_at", { ascending: true }).limit(1);

  const { data, error } = await q.maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Institution not found.");
  return data;
}

/** All institutions (SuperAdmin directory). */
export async function listAllSchools() {
  const { data, error } = await supabaseAdmin
    .from("institutions")
    .select("*, campuses(*)")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}

/** Register a new school. The short code defaults to the first 3 letters of the name. */
export async function registerSchool(payload: RegisterSchoolPayload) {
  const code = (payload.code || payload.name.replace(/[^a-zA-Z]/g, "").substring(0, 3)).toUpperCase();
  if (code.length < 2) throw new HttpError(400, "School code must be at least 2 characters.");

  const { data, error } = await supabaseAdmin
    .from("institutions")
    .insert({
      name: payload.name.trim(),
      code,
      type: payload.type || "High School",
      contact_email: payload.contact_email || null,
      contact_phone: payload.contact_phone || null,
      address: payload.address || null,
      city: payload.city || null,
      state: payload.state || null,
      website: payload.website || null,
      status: "Trial",
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") throw new HttpError(409, `School code '${code}' is already in use.`);
    throw new HttpError(500, error.message);
  }
  return data;
}

/** Look up a school by its short code (e.g. "RAV"). */
export async function getSchoolByCode(code: string) {
  const { data, error } = await supabaseAdmin
    .from("institutions")
    .select("*")
    .eq("code", code.trim().toUpperCase())
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, `School code '${code.toUpperCase()}' not found in registered database.`);
  return data;
}
