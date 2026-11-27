import type { Response } from "express";
import { ZodError } from "zod";

/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Shared controller error mapping: HttpError -> its status, ZodError -> 400, anything else -> 500. */
export function sendError(res: Response, err: unknown, fallback = "Request failed"): void {
  if (err instanceof HttpError) {
    // a plain 500 carries the database's own wording (table and column names): logged, not shown, in production
    if (err.status === 500 && process.env.NODE_ENV === "production") console.error(fallback, err.message);
    res.status(err.status).json({ error: err.status === 500 && process.env.NODE_ENV === "production" ? fallback : err.message });
  } else if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues[0]?.message || "Invalid request.", issues: err.issues });
  } else {
    console.error(fallback, err);
    res.status(500).json({ error: fallback });
  }
}
