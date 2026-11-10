import type { Request } from "express";
import { supabaseAdmin } from "../../db/client";
import { HttpError } from "./http-error";

/**
 * Decide which institution a request may act on.
 *  - SuperAdmin: any institution (`requested`), or null meaning "all institutions".
 *  - Everyone else: only their own institution; asking for another one is rejected.
 */
export function resolveInstitutionId(req: Request, requested?: string | null): string | null {
  const user = req.user;
  if (!user) throw new HttpError(401, "Authentication required.");

  if (user.role === "SuperAdmin") return requested || null;

  if (!user.institutionId) throw new HttpError(403, "Your account is not linked to an institution.");
  if (requested && requested !== user.institutionId) throw new HttpError(403, "You cannot access another institution.");
  return user.institutionId;
}

/** Same as resolveInstitutionId, but the caller must end up with exactly one institution. */
export function requireInstitutionId(req: Request, requested?: string | null): string {
  const id = resolveInstitutionId(req, requested);
  if (!id) throw new HttpError(400, "An institution must be specified.");
  return id;
}

/** Look up an institution id from its short code (e.g. "RAV"). */
export async function institutionIdByCode(code: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("institutions")
    .select("id, is_active")
    .eq("code", code.trim().toUpperCase())
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, `School code '${code.toUpperCase()}' not found.`);
  if (!data.is_active) throw new HttpError(403, "This school is inactive.");
  return data.id;
}
