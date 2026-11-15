import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../../db/client";

/**
 * Counts every request by route group and hour, keeps server errors, and notes refused (403) requests.
 * Counts are held in memory and written once a minute, so this adds no database work to a request.
 */

const BOUNDS = [50, 100, 250, 500, 1000, 2500];
interface Bucket { hour: string; route_group: string; module_code: string | null; requests: number; errors: number; sum_ms: number; max_ms: number; buckets: number[] }

let pending = new Map<string, Bucket>();
let errors: { route_group: string; module_code: string | null; method: string; path: string; status: number; message: string | null }[] = [];
let denied: { email: string | null; profile_id: string | null; method: string; path: string; needed: string | null; ip_address: string | null }[] = [];

const MODULE_OF: Record<string, string> = { sis: "student_information", academics: "timetable" };

/** "/api/v1/admin/schools/123/status" -> "admin/schools"; ids and long tails are dropped so the groups stay few. */
export function routeGroup(path: string): string {
  const parts = path.replace(/^\/api\/v1\//, "").split("?")[0].split("/").filter(Boolean);
  if (!parts.length) return "root";
  const take = ["admin", "school"].includes(parts[0]) ? 2 : 1;
  return parts.slice(0, take).filter((p) => !/^[0-9a-f-]{8,}$/i.test(p)).join("/") || parts[0];
}
export const moduleOfPath = (path: string): string | null => MODULE_OF[routeGroup(path).split("/")[0]] ?? null;

export function bucketIndex(ms: number): number {
  const i = BOUNDS.findIndex((b) => ms <= b);
  return i === -1 ? BOUNDS.length : i;
}

/** Latency at a percentile, estimated from the bucket counts (the upper edge of the bucket it falls in). */
export function percentile(buckets: number[], p: number): number {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i];
    if (seen / total >= p) return i < BOUNDS.length ? BOUNDS[i] : BOUNDS[BOUNDS.length - 1] * 2;
  }
  return BOUNDS[BOUNDS.length - 1] * 2;
}

export function telemetry(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    try {
      const path = req.originalUrl.split("?")[0];
      if (!path.startsWith("/api/") || path.includes("/health")) return;
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const group = routeGroup(path);
      const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
      const key = `${hour}|${group}`;
      const b = pending.get(key) ?? { hour, route_group: group, module_code: moduleOfPath(path), requests: 0, errors: 0, sum_ms: 0, max_ms: 0, buckets: [0, 0, 0, 0, 0, 0, 0] };
      b.requests++;
      b.sum_ms += ms;
      b.max_ms = Math.max(b.max_ms, ms);
      b.buckets[bucketIndex(ms)]++;
      if (res.statusCode >= 500) {
        b.errors++;
        if (errors.length < 200) errors.push({ route_group: group, module_code: moduleOfPath(path), method: req.method, path: path.slice(0, 300), status: res.statusCode, message: typeof res.locals.errorMessage === "string" ? res.locals.errorMessage.slice(0, 400) : null });
      }
      pending.set(key, b);
      if (res.statusCode === 403 && denied.length < 200) {
        denied.push({ email: req.user?.email ?? null, profile_id: req.user?.profileId ?? null, method: req.method, path: path.slice(0, 300), needed: typeof res.locals.denied === "string" ? res.locals.denied.slice(0, 200) : null, ip_address: req.ip ?? null });
      }
    } catch {
      /* measuring must never break a request */
    }
  });
  next();
}

/** Writes what has been counted so far. Called every minute, and on shutdown. */
export async function flushTelemetry(): Promise<void> {
  if (!pending.size && !errors.length && !denied.length) return;
  const rows = [...pending.values()];
  const errs = errors;
  const den = denied;
  pending = new Map();
  errors = [];
  denied = [];
  try {
    if (rows.length) {
      const r = await supabaseAdmin.rpc("add_request_metrics", { p_rows: rows });
      if (r.error) throw new Error(r.error.message);
    }
    if (errs.length) await supabaseAdmin.from("error_events").insert(errs);
    if (den.length) await supabaseAdmin.from("access_denied_events").insert(den);
  } catch (err) {
    console.error("Telemetry not saved:", err instanceof Error ? err.message : err);
  }
}

/** Keeps 90 days of hourly counts and 30 days of errors and refusals. */
export async function pruneTelemetry(): Promise<void> {
  const d = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  await Promise.all([
    supabaseAdmin.from("request_metrics").delete().lt("hour", d(90)),
    supabaseAdmin.from("error_events").delete().lt("at", d(30)),
    supabaseAdmin.from("access_denied_events").delete().lt("at", d(30)),
  ]);
}
