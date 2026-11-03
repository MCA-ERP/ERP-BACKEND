import { HttpError } from "./http-error";

/** Unwrap a Supabase response, mapping Postgres errors onto HTTP errors. */
export function check<T>(res: { data: T | null; error: { code?: string; message: string } | null }): T {
  if (res.error) {
    if (res.error.code === "23505") throw new HttpError(409, "A record with the same unique value already exists.");
    if (res.error.code === "23503") throw new HttpError(400, "Referenced record does not exist or is still in use.");
    if (res.error.code === "23514") throw new HttpError(400, "A value violates a database rule.");
    throw new HttpError(500, res.error.message);
  }
  return res.data as T;
}
