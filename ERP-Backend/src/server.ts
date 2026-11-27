import fetch, { Headers, Request as FetchRequest, Response as FetchResponse } from "cross-fetch";
import { flushTelemetry, telemetry } from "./lib/telemetry";

if (typeof (globalThis as any).fetch === "undefined") {
  (globalThis as any).fetch = fetch;
  (globalThis as any).Headers = Headers;
  (globalThis as any).Request = FetchRequest;
  (globalThis as any).Response = FetchResponse;
}

import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { testDbConnection } from "../db/client";
import { authRouter } from "./modules/auth/auth.routes";
import { institutionRouter } from "./modules/institution/institution.routes";
import { sisRouter } from "./modules/sis/sis.routes";
import { academicsRouter } from "./modules/academics/academics.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { schoolRouter } from "./modules/school/school.routes";
import { teacherRouter } from "./modules/teacher/teacher.routes";
import { accountsRouter } from "./modules/accounts/accounts.routes";
import { admissionsRouter } from "./modules/admissions/admissions.routes";
import { principalRouter } from "./modules/principal/principal.routes";
import { hrRouter } from "./modules/hr/hr.routes";
import { transportRouter } from "./modules/transport/transport.routes";
import { parentRouter } from "./modules/parent/parent.routes";
import { applicantRouter, applicantPublicRouter } from "./modules/applicant/applicant.routes";
import { publicRouter } from "./modules/public/public.routes";
import { webhookRouter } from "./modules/billing/billing.routes";
import { partnerRouter } from "./modules/integrations/partner.routes";
import { startScheduler } from "./modules/messaging/scheduler";
import { auditLogger } from "./middleware/auditLogger";
import { HttpError } from "./lib/http-error";
import { apiLimiter, corsOptions, loginLimiter, publicLimiter, securityHeaders, webhookLimiter, partnerLimiter } from "./middleware/security";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Behind a reverse proxy you control, trust one hop so client addresses (rate limits, IP allowlist) are real.
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.disable("x-powered-by");
// Production safety checks: refuse to start with settings that would expose the API.
if (process.env.NODE_ENV === "production") {
  const problems: string[] = [];
  const origins = (process.env.CORS_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!origins.length) problems.push("CORS_ORIGIN is empty");
  if (origins.some((o) => o === "*" || !o.startsWith("https://"))) problems.push("CORS_ORIGIN must list https:// origins only, never *");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || /^(secret|changeme|test|dev)/i.test(process.env.SUPABASE_SERVICE_ROLE_KEY)) problems.push("SUPABASE_SERVICE_ROLE_KEY is missing or weak");
  if (process.env.DEBUG === "true") problems.push("DEBUG must not be true");
  if (problems.length) { console.error("Refusing to start in production: " + problems.join("; ")); process.exit(1); }
  // HTTPS only (the proxy sets X-Forwarded-Proto); health checks stay reachable.
  app.use((req, res, next) => { if (req.path === "/health" || req.secure || req.headers["x-forwarded-proto"] === "https") return next(); return res.redirect(308, "https://" + req.headers.host + req.originalUrl); });
}

app.use(securityHeaders);
app.use(cors(corsOptions));
// counts requests, speed, server errors and refusals for the System and Security reports
app.use(telemetry);

// Rate limits: general, plus tighter ones for sign-in, public lookups and webhooks.
app.use("/api", apiLimiter);
app.use("/api/v1/auth/login", loginLimiter);
app.use("/api/v1/public", publicLimiter);
app.use("/api/v1/institution/by-code", publicLimiter);
app.use("/api/v1/webhooks", webhookLimiter);
app.use("/api/v1/partner", partnerLimiter);

app.use(
  express.json({
    limit: "1mb",
    // the payment webhook signature is computed over the exact bytes received
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Global Audit Logger for State Mutations
app.use(auditLogger);

// Health Check Endpoints
app.get("/health", async (_req: Request, res: Response) => {
  const dbHealth = await testDbConnection();
  res.json({
    status: "healthy",
    service: "Education ERP Backend API",
    version: "1.0.0",
    database: dbHealth,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1/health", async (_req: Request, res: Response) => {
  const dbHealth = await testDbConnection();
  res.json({
    status: "ok",
    database: dbHealth,
    modules: ["auth", "institution", "sis", "admissions", "academics", "finance", "hr"],
  });
});

// Mount Module Routers
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/institution", institutionRouter);
app.use("/api/v1/sis", sisRouter);
app.use("/api/v1/academics", academicsRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/school", schoolRouter);
app.use("/api/v1/teacher", teacherRouter);
app.use("/api/v1/accounts", accountsRouter);
app.use("/api/v1/admissions", admissionsRouter);
app.use("/api/v1/principal", principalRouter);
app.use("/api/v1/hr", hrRouter);
app.use("/api/v1/transport", transportRouter);
app.use("/api/v1/parent", parentRouter);
app.use("/api/v1/applicant", applicantRouter);
app.use("/api/v1/public/applicant", applicantPublicRouter);
app.use("/api/v1/public", publicRouter);
app.use("/api/v1/webhooks", webhookRouter);
app.use("/api/v1/partner", partnerRouter);

// Root Welcome Endpoint
app.get("/", (_req: Request, res: Response) => {
  res.json({
    message: "Education ERP Modular API-First Backend Gateway",
    documentation: "/api/v1/docs",
    health: "/health",
  });
});

// 404 Route Handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: `Cannot ${req.method} ${req.originalUrl}`,
    status: 404,
  });
});

// Global Error Handler
app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    if (err.status >= 500) res.locals.errorMessage = err.message;
    const hide = err.status === 500 && process.env.NODE_ENV === "production";
    if (hide) console.error("Request failed:", err.message);
    res.status(err.status).json({ error: hide ? "Internal Server Error" : err.message });
    return;
  }
  res.locals.errorMessage = err.message;
  console.error("Unhandled API Error:", err.stack);
  res.status(500).json({
    error: "Internal Server Error",
    ...(process.env.NODE_ENV === "production" ? {} : { message: err.message }),
  });
});

// Start Server
app.listen(PORT, async () => {
  console.log(`====================================================`);
  console.log(`🚀 Education ERP Backend API running on port ${PORT}`);
  console.log(`🌐 API Base URL: http://localhost:${PORT}/api/v1`);
  console.log(`🩺 Health check: http://localhost:${PORT}/health`);
  console.log(`====================================================`);

  startScheduler();
  const dbHealth = await testDbConnection();
  console.log(`🗄️ Database status: ${dbHealth.ok ? "Connected ✅" : "Notice ⚠️ (" + dbHealth.message + ")"}`);
});

// write what has been counted before the process stops
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void flushTelemetry().finally(() => process.exit(0));
  });
}

export default app;
