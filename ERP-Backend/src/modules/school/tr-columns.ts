import { HttpError } from "../../lib/http-error";

/** Transport columns added by migration 121. Until it is applied, reads fall back to the older columns and saves that
 *  need the new ones say so, so the School Admin's transport screens keep working. */
export const NEEDS_121 = "This needs a database update (migration 121) that has not been applied yet.";

type Res = { data: unknown; error: { code?: string; message: string } | null };
const missing = (e: Res["error"]) => !!e && (e.code === "42703" || e.code === "PGRST204" || /column .* does not exist|could not find the .* column/i.test(e.message));

/** The full read, or the older one when the new columns are not there yet. */
export async function newOr<T>(full: () => PromiseLike<Res>, older: () => PromiseLike<Res>): Promise<{ rows: T[]; upgraded: boolean }> {
  let r = await full();
  const upgraded = !missing(r.error);
  if (!upgraded) r = await older();
  if (r.error) throw new Error(r.error.message);
  return { rows: (r.data ?? []) as T[], upgraded };
}

/** A save that uses the new columns. */
export function saved<T>(r: Res): T {
  if (missing(r.error)) throw new HttpError(409, NEEDS_121);
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}
