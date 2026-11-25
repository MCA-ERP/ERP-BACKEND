import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

/** HR keeps everyone's records except those of the people it answers to: only the School Admin side changes these. */
export const SENIOR_ROLES = ["InstitutionAdmin", "Principal", "VicePrincipal"];
export const isSeniorRole = (role: string) => SENIOR_ROLES.includes(role);
export const SENIOR_MESSAGE = "HR can't change this person's record. Ask the School Admin.";

/** Refuses when HR tries to change the record of a School Admin, Principal or Vice Principal of this school. */
export async function assertHrMayChange(actorRole: string | undefined, inst: string, staffId: string) {
  if (actorRole !== "HR") return;
  const p = check(await supabaseAdmin.from("user_profiles").select("roles:role_id(name)").eq("id", staffId).eq("institution_id", inst).maybeSingle()) as unknown as { roles: { name: string } | { name: string }[] | null } | null;
  const role = (Array.isArray(p?.roles) ? p?.roles[0]?.name : p?.roles?.name) ?? "";
  if (isSeniorRole(role)) throw new HttpError(403, SENIOR_MESSAGE);
}
