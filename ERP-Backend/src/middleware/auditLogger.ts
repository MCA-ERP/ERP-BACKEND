import { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../../db/client";

const SENSITIVE_KEYS = /pass(word)?|secret|token|api[_-]?key/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) ? "[REDACTED]" : redact(v)])
    );
  }
  return value;
}

/**
 * Middleware that logs state-mutating requests (POST, PUT, PATCH, DELETE) to audit_logs
 */
export async function auditLogger(req: Request, res: Response, next: NextFunction): Promise<void> {
  const mutatingMethods = ["POST", "PUT", "PATCH", "DELETE"];
  
  if (!mutatingMethods.includes(req.method)) {
    return next();
  }

  // Intercept completion of request
  res.on("finish", async () => {
    // Only log successful operations
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        const actorId = req.user?.profileId || null;
        const actorEmail = req.user?.email || "anonymous";
        const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
        const userAgent = req.headers["user-agent"] || "";

        await supabaseAdmin.from("audit_logs").insert({
          actor_id: actorId,
          actor_email: actorEmail,
          institution_id: req.user?.institutionId || null,
          action: `${req.method} ${req.baseUrl}${req.path}`,
          entity_name: req.baseUrl.replace("/api/v1/", "") || "general",
          new_data: req.body ? redact(req.body) : null,
          ip_address: ipAddress,
          user_agent: userAgent,
        });
      } catch (logErr) {
        // Audit logger failure should not break the response cycle
        console.error("Audit log recording failed:", logErr);
      }
    }
  });

  next();
}
