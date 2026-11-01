"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabaseAdmin = exports.supabasePublic = void 0;
exports.testDbConnection = testDbConnection;
const supabase_js_1 = require("@supabase/supabase-js");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!supabaseUrl) {
    console.warn("⚠️ Warning: SUPABASE_URL is not set in environment.");
}
const ws_1 = __importDefault(require("ws"));
// Public client for user-authenticated operations
exports.supabasePublic = (0, supabase_js_1.createClient)(supabaseUrl, supabaseAnonKey || "dummy-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
        transport: ws_1.default,
    },
});
// Admin client with service-role permissions for elevated operations, RBAC enforcement, and background jobs
exports.supabaseAdmin = (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceKey || supabaseAnonKey || "dummy-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
        transport: ws_1.default,
    },
});
/**
 * Health check to verify database connectivity
 */
async function testDbConnection() {
    try {
        const { error } = await exports.supabaseAdmin.from("roles").select("count", { count: "exact", head: true });
        // If the table doesn't exist yet, try basic auth status or system ping
        if (error && !error.message.includes("relation \"public.roles\" does not exist")) {
            return { ok: false, message: error.message, timestamp: new Date().toISOString() };
        }
        return {
            ok: true,
            message: "Database connection verified successfully.",
            timestamp: new Date().toISOString(),
        };
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown connection failure";
        return { ok: false, message: errorMessage, timestamp: new Date().toISOString() };
    }
}
