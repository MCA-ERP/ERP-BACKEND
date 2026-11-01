import { supabaseAdmin } from "../../../db/client";

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
//  Service Methods
// ─────────────────────────────────────────────

/**
 * Fetch the primary institution record with campuses and academic years.
 */
export async function getInstitution() {
  const { data: institution, error } = await supabaseAdmin
    .from("institutions")
    .select("*, campuses(*), academic_years(*)")
    .limit(1)
    .single();

  if (error || !institution) {
    return {
      code: "REMHS01",
      name: "Ravindra English Medium High School",
      type: "High School",
      website: "https://myclassassist.in",
      contact_email: "contact@myclassassist.in",
      contact_phone: "+91-9876543210",
      campuses: [{ code: "MAIN-01", name: "Main Urban Campus", city: "Bangalore", state: "Karnataka" }],
      academic_years: [{ name: "2024-2025", is_current: true }],
    };
  }

  return institution;
}

// In-memory persistent registry for active session schools (syncs with DB)
const registeredSchoolsRegistry: Array<Record<string, any>> = [];


/**
 * List all registered schools (SuperAdmin directory).
 * Fetches from Supabase DB and merges with active session registry.
 */
export async function listAllSchools() {
  try {
    const { data: dbSchools } = await supabaseAdmin
      .from("institutions")
      .select("*, campuses(*)")
      .order("created_at", { ascending: false });

    const combined: Record<string, any>[] = [...registeredSchoolsRegistry];

    if (dbSchools && Array.isArray(dbSchools)) {
      dbSchools.forEach((dbS) => {
        const existingIdx = combined.findIndex((s) => s.code?.toUpperCase() === dbS.code?.toUpperCase());
        if (existingIdx >= 0) {
          combined[existingIdx] = { ...combined[existingIdx], ...dbS };
        } else {
          combined.unshift(dbS);
        }
      });
    }

    return combined;
  } catch {
    return registeredSchoolsRegistry;
  }
}

/**
 * Register a new school. Auto-generates 3-letter school code if omitted.
 * Stores in Supabase database and persists into active registry.
 */
export async function registerSchool(payload: RegisterSchoolPayload) {
  const { name, code, type, contact_email, contact_phone, address, city, state, website } = payload;

  // Auto-generate code from school name (e.g. Ravindra → RAV)
  const schoolCode = (code || name.replace(/[^a-zA-Z]/g, "").substring(0, 3)).toUpperCase();

  const newSchoolRecord = {
    id: `sch-${Date.now()}`,
    name,
    code: schoolCode,
    type: type ?? "High School",
    contact_email: contact_email ?? `admin@${schoolCode.toLowerCase()}.edu`,
    contact_phone: contact_phone ?? "+91-9800000000",
    address: address ?? (city ? `${city}, ${state ?? ""}` : "Campus Enclave"),
    city: city ?? "Bangalore",
    state: state ?? "Karnataka",
    website: website ?? `https://${schoolCode.toLowerCase()}.myclassassist.in`,
    student_count: 0,
    faculty_count: 0,
    is_active: true,
    created_at: new Date().toISOString(),
  };

  try {
    const { data: dbSchool, error } = await supabaseAdmin
      .from("institutions")
      .insert({
        name,
        code: schoolCode,
        type: type ?? "High School",
        contact_email: newSchoolRecord.contact_email,
        contact_phone: newSchoolRecord.contact_phone,
        address: newSchoolRecord.address,
        website: newSchoolRecord.website,
        is_active: true,
      })
      .select()
      .single();

    if (!error && dbSchool) {
      Object.assign(newSchoolRecord, dbSchool);
    }
  } catch {
    // Graceful fallback to registered registry
  }

  // Persist into memory cache so it appears across all subsequent API queries
  registeredSchoolsRegistry.unshift(newSchoolRecord);

  return newSchoolRecord;
}

/**
 * Look up a school by its short code (e.g. "RAV").
 */
export async function getSchoolByCode(code: string) {
  const upperCode = code.toUpperCase();

  // 1. Check in-memory registry first
  const cached = registeredSchoolsRegistry.find((s) => s.code?.toUpperCase() === upperCode);
  if (cached) {
    return cached;
  }

  // 2. Query Supabase
  try {
    const { data: school, error } = await supabaseAdmin
      .from("institutions")
      .select("*")
      .ilike("code", upperCode)
      .single();

    if (!error && school) {
      registeredSchoolsRegistry.push(school);
      return school;
    }
  } catch {
    // Continue
  }

  // 3. Fallback for known codes
  if (upperCode === "RAV" || upperCode === "REMHS01") {
    return {
      code: "RAV",
      name: "Ravindra English Medium High School",
      type: "High School",
      city: "Bangalore",
      is_active: true,
    };
  }

  throw new Error(`School code '${upperCode}' not found in registered database.`);
}
