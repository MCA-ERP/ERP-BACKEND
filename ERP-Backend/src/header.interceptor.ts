import { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../db/client";

/**
 * Header interceptor that logs mutation events to the audit table
 */
export async function HeaderInterceptor(req: Request, res: Response, next: NextFunction): Promise<void> {
  const mutatingMethods = ["POST", "PUT", "PATCH", "DELETE"];

  if (!mutatingMethods.includes(req.method)) {
    return next();
  }

  res.on("finish", async () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        const actorId = req.user?.profileId || null;
        const actorEmail = req.user?.email || "anonymous";
        const ipAddress = (req.headers["x-forwarded-for"] as string) || req.socket.remoteAddress || "";
        const userAgent = (req.headers["user-agent"] as string) || "";

        await supabaseAdmin.from("audit_logs").insert({
          actor_id: actorId,
          actor_email: actorEmail,
          action: `${req.method} ${req.baseUrl}${req.path}`,
          entity_name: req.baseUrl.replace("/api/", "") || "general",
          new_data: req.body ? req.body : null,
          ip_address: ipAddress,
          user_agent: userAgent,
        });
      } catch (logErr) {
        console.error("Audit log record failed:", logErr);
      }
    }
  });

  next();
}
