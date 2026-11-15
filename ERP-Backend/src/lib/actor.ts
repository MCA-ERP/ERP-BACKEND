import type { Request } from "express";
import { supabaseAdmin } from "../../db/client";

/** Display name of the signed-in user (for ticket threads and similar records). */
export async function actorName(req: Request): Promise<{ profileId?: string; name: string }> {
  const profileId = req.user?.profileId;
  if (profileId) {
    const { data } = await supabaseAdmin.from("user_profiles").select("first_name, last_name").eq("id", profileId).maybeSingle();
    if (data) return { profileId, name: `${data.first_name} ${data.last_name}`.trim() };
  }
  return { profileId, name: req.user?.email ?? "Unknown" };
}
