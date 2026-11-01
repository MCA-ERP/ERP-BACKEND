import fetch, { Headers, Request as FetchRequest, Response as FetchResponse } from "cross-fetch";

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
import { auditLogger } from "./middleware/auditLogger";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// Standard Middlewares
app.use(
  cors({
    origin: [CORS_ORIGIN, "http://localhost:3000", "http://127.0.0.1:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

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
  console.error("Unhandled API Error:", err.stack);
  res.status(500).json({
    error: "Internal Server Error",
    message: err.message,
  });
});

// Start Server
app.listen(PORT, async () => {
  console.log(`====================================================`);
  console.log(`🚀 Education ERP Backend API running on port ${PORT}`);
  console.log(`🌐 API Base URL: http://localhost:${PORT}/api/v1`);
  console.log(`🩺 Health check: http://localhost:${PORT}/health`);
  console.log(`====================================================`);

  const dbHealth = await testDbConnection();
  console.log(`🗄️ Database status: ${dbHealth.ok ? "Connected ✅" : "Notice ⚠️ (" + dbHealth.message + ")"}`);
});

export default app;
