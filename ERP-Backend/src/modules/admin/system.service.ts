import { readFileSync } from "fs";
import path from "path";
import { supabaseAdmin, testDbConnection } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

const packageVersion = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(__dirname, "../../../package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

/** What is running right now. */
export async function systemInfo() {
  const [db, migrations, latest] = await Promise.all([
    testDbConnection(),
    supabaseAdmin.from("schema_migrations").select("*", { count: "exact", head: true }),
    supabaseAdmin.from("schema_migrations").select("version, applied_at").order("version", { ascending: false }).limit(1),
  ]);
  const last = ((latest.data ?? [])[0] ?? null) as { version: string; applied_at: string } | null;
  return {
    platform_version: packageVersion,
    api_version: "v1",
    node: process.version,
    environment: process.env.NODE_ENV || "development",
    started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    database: db.ok ? "Connected" : "Not reachable",
    migrations: migrations.count ?? 0,
    last_migration: last,
  };
}

// ── release history ─────────────────────────────────────────
export const versionOk = (v: string) => /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i.test(v);

export async function listReleases() {
  return check(await supabaseAdmin.from("platform_releases").select("id, version, released_on, notes").order("released_on", { ascending: false }).order("created_at", { ascending: false }).limit(100));
}

export async function addRelease(input: { version: string; released_on?: string; notes?: string }, actorProfileId?: string) {
  if (!versionOk(input.version)) throw new HttpError(400, "Use a version like 4.12.0.");
  const dup = check(await supabaseAdmin.from("platform_releases").select("id").eq("version", input.version).maybeSingle());
  if (dup) throw new HttpError(409, `Version ${input.version} is already listed.`);
  return check(
    await supabaseAdmin
      .from("platform_releases")
      .insert({ version: input.version, released_on: input.released_on ?? new Date().toISOString().slice(0, 10), notes: input.notes ?? "", created_by: actorProfileId ?? null })
      .select("id, version, released_on, notes")
      .single()
  );
}

export async function deleteRelease(id: string) {
  check(await supabaseAdmin.from("platform_releases").delete().eq("id", id).select("id"));
  return { success: true };
}
