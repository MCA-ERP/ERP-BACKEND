import fetch, { Headers, Request, Response } from "cross-fetch";

if (typeof (globalThis as any).fetch === "undefined") {
  (globalThis as any).fetch = fetch;
  (globalThis as any).Headers = Headers;
  (globalThis as any).Request = Request;
  (globalThis as any).Response = Response;
}

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl) {
  console.warn("⚠️ Warning: SUPABASE_URL is not set in environment.");
}

import WebSocket from "ws";

// Public client for user-authenticated operations
export const supabasePublic: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey || "dummy-key", {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: {
    transport: WebSocket as unknown as any,
  },
});

// Admin client with service-role permissions for elevated operations, RBAC enforcement, and background jobs
export const supabaseAdmin: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey || supabaseAnonKey || "dummy-key",
  {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
      transport: WebSocket as unknown as any,
    },
  }
);

/**
 * Health check to verify database connectivity
 */
export async function testDbConnection(): Promise<{ ok: boolean; message: string; timestamp: string }> {
  try {
    const { error } = await supabaseAdmin.from("roles").select("count", { count: "exact", head: true });
    
    // If the table doesn't exist yet, try basic auth status or system ping
    if (error && !error.message.includes("relation \"public.roles\" does not exist")) {
      return { ok: false, message: error.message, timestamp: new Date().toISOString() };
    }

    return {
      ok: true,
      message: "Database connection verified successfully.",
      timestamp: new Date().toISOString(),
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Unknown connection failure";
    return { ok: false, message: errorMessage, timestamp: new Date().toISOString() };
  }
}
