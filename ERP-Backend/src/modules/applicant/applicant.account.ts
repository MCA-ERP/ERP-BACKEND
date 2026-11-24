import { z } from "zod";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getEntitlements } from "../../lib/entitlements";
import { createUser } from "../admin/admin.service";
import { normalizePhone } from "../../lib/sms";

/**
 * How a family gets an account: it signs up itself on the public page with the school's code. The account is an Applicant
 * (never Parent or Student), which can see nothing but what carries its own family id. A family that already applied at the
 * front desk links that application with its number and the mobile the office has on file.
 */
const tail10 = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-10);

async function openSchool(code: string) {
  const s = check(await supabaseAdmin.from("institutions").select("id, name, code, is_active").eq("code", z.string().trim().min(2).max(50).parse(code).toUpperCase()).maybeSingle()) as { id: string; name: string; code: string; is_active: boolean } | null;
  if (!s || !s.is_active) throw new HttpError(404, "We could not find that school. Check the code the school gave you.");
  const ent = await getEntitlements(s.id);
  if (["Pending", "Suspended", "Inactive", "Expired"].includes(ent.status) || !ent.modules.includes("online_admissions")) throw new HttpError(403, "This school is not taking online applications right now.");
  return s;
}
export async function schoolForSignup(code: string) { const s = await openSchool(code); return { name: s.name, code: s.code }; }

export async function register(body: unknown) {
  const i = z.object({
    school_code: z.string().trim().min(2).max(50), first_name: z.string().trim().min(1, "Enter your first name.").max(100), last_name: z.string().trim().min(1, "Enter your last name.").max(100),
    email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(150), mobile: z.string().trim().min(10, "Enter your mobile number.").max(20), password: z.string().min(8).max(128),
  }).strict().parse(body);
  const school = await openSchool(i.school_code);
  const phone = normalizePhone(i.mobile);
  if (!phone) throw new HttpError(400, "Enter a valid mobile number.");
  try {
    await createUser({ email: i.email, password: i.password, first_name: i.first_name, last_name: i.last_name, phone, role: "Applicant", institution_id: school.id, must_change_password: false });
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) throw new HttpError(409, "There is already an account with this email. Sign in instead.");
    throw e;
  }
  return { ok: true };
}

/** Links an application (or enquiry) the office made to the signed-in family. The number and the mobile on file must both match. */
export async function link(inst: string, me: string, body: unknown) {
  const i = z.object({ code: z.string().trim().toUpperCase().regex(/^(APP|AE)-[A-Z0-9-]{3,20}$/, "Enter the application number, like APP-2027-1001.").max(30), mobile: z.string().trim().min(10).max(20) }).strict().parse(body);
  const table = i.code.startsWith("AE-") ? "adm_enquiries" : "adm_applications";
  const row = check(await supabaseAdmin.from(table).select("id, mobile, family_id").eq("institution_id", inst).eq("code", i.code).maybeSingle()) as { id: string; mobile: string | null; family_id: string | null } | null;
  // one answer for every failure, so numbers cannot be probed
  const wrong = new HttpError(404, "We could not match that number and mobile. Check them, or ask the admissions office.");
  if (!row || !row.mobile || tail10(row.mobile) !== tail10(i.mobile) || (row.family_id && row.family_id !== me)) throw wrong;
  check(await supabaseAdmin.from(table).update({ family_id: me }).eq("id", row.id).eq("institution_id", inst).select("id"));
  return { ok: true };
}
