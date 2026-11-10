import type { CorsOptions } from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const isProduction = process.env.NODE_ENV === "production";

/** Origins allowed to call the API from a browser: CORS_ORIGIN (comma separated), plus localhost when developing. */
export function allowedOrigins(): string[] {
  const configured = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const dev = isProduction ? [] : ["http://localhost:3000", "http://127.0.0.1:3000"];
  return Array.from(new Set([...configured, ...dev]));
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // no Origin header: server-to-server calls such as payment webhooks, curl, health checks
    if (!origin) return callback(null, true);
    callback(null, allowedOrigins().includes(origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600,
};

/** Standard hardening headers. This is a JSON API, so the page-oriented defaults are deliberately strict. */
export const securityHeaders = helmet({
  // the public CMS and branding endpoints are fetched by the marketing website (CORS still applies)
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
});

const limiter = (windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message },
  });

/** Everything under /api. Generous: a dashboard page makes several calls. */
export const apiLimiter = limiter(60_000, 300, "Too many requests. Please slow down.");
/** Password login attempts. */
export const loginLimiter = limiter(15 * 60_000, 30, "Too many sign-in attempts. Try again in a few minutes.");
/** Unauthenticated, enumerable endpoints (school code lookup, public CMS). */
export const publicLimiter = limiter(60_000, 60, "Too many requests. Please slow down.");
/** A school asking to join from the public website. */
export const applicationLimiter = limiter(60 * 60_000, 5, "Too many applications from this address. Please try again later.");

/** Partner API (API-key authenticated). */
export const partnerLimiter = limiter(60_000, 120, "Too many requests. Please slow down.");
/** Payment gateway webhooks. */
export const webhookLimiter = limiter(60_000, 120, "Too many requests.");
