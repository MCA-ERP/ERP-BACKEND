#!/usr/bin/env node
/**
 * Forward-only SQL migration runner.
 *
 *   node db/migrate.js            apply pending migrations
 *   node db/migrate.js status     show applied / pending migrations
 *   node db/migrate.js --dry-run  apply everything in one transaction, then roll back
 *   node db/migrate.js seed dev   run db/seeds/dev/*.sql (development data only)
 *
 * Migrations live in db/migrations as NNN_name.sql and are applied in filename order,
 * each inside its own transaction. Applied files are recorded with a checksum; editing an
 * applied file is an error — add a new migration instead.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
require("dotenv").config();

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const SEEDS_DIR = path.join(__dirname, "seeds");
const LOCK_KEY = 727401; // arbitrary constant for pg_advisory_xact_lock

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const command = args.find((a) => !a.startsWith("--")) || "up";

function listSql(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
}

function read(dir, file) {
  const sql = fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n");
  return { sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
}

async function connect() {
  const candidates = [process.env.DATABASE_URL, process.env.DATABASE_POOLER_URL].filter(Boolean);
  for (const cs of candidates) {
    const client = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
    try {
      await client.connect();
      return client;
    } catch (err) {
      console.warn(`Connection failed (${err.message}); trying next connection string...`);
      await client.end().catch(() => {});
    }
  }
  throw new Error("Could not connect: set DATABASE_URL or DATABASE_POOLER_URL.");
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

async function loadApplied(client) {
  const { rows } = await client.query("SELECT version, checksum FROM public.schema_migrations");
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

async function applyOne(client, file, sql, checksum) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
  await client.query(sql);
  await client.query("INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)", [file, checksum]);
}

async function warnMissingRls(client) {
  const { rows } = await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1`);
  if (rows.length) {
    console.warn(`\nWARNING: tables without row level security: ${rows.map((r) => r.relname).join(", ")}`);
    console.warn("Every public table must have RLS enabled (see 005_enable_rls.sql).");
    return false;
  }
  return true;
}

async function up(client) {
  const files = listSql(MIGRATIONS_DIR);
  if (dryRun) await client.query("BEGIN");
  await ensureTable(client);
  const applied = await loadApplied(client);

  for (const [version, checksum] of applied) {
    if (!files.includes(version)) throw new Error(`Applied migration ${version} is missing from db/migrations.`);
    if (read(MIGRATIONS_DIR, version).checksum !== checksum) {
      throw new Error(`Migration ${version} was modified after being applied. Add a new migration instead.`);
    }
  }

  const pending = files.filter((f) => !applied.has(f));
  if (!pending.length) console.log("Database is up to date.");

  for (const file of pending) {
    const { sql, checksum } = read(MIGRATIONS_DIR, file);
    process.stdout.write(`-> ${file} ... `);
    try {
      if (!dryRun) await client.query("BEGIN");
      await applyOne(client, file, sql, checksum);
      if (!dryRun) await client.query("COMMIT");
      console.log("ok");
    } catch (err) {
      if (!dryRun) await client.query("ROLLBACK").catch(() => {});
      console.log("FAILED");
      throw err;
    }
  }

  const rlsOk = await warnMissingRls(client);
  if (dryRun) {
    await client.query("ROLLBACK");
    console.log(`\nDry run complete: ${pending.length} migration(s) would be applied. Nothing was changed.`);
  }
  if (!rlsOk && !dryRun) process.exitCode = 1;
}

async function status(client) {
  await ensureTable(client);
  const applied = await loadApplied(client);
  for (const f of listSql(MIGRATIONS_DIR)) {
    const state = !applied.has(f) ? "pending" : applied.get(f) === read(MIGRATIONS_DIR, f).checksum ? "applied" : "MODIFIED";
    console.log(`${state.padEnd(8)} ${f}`);
  }
}

async function seed(client, name) {
  const dir = path.join(SEEDS_DIR, name || "");
  const files = listSql(dir);
  if (!name || !files.length) throw new Error(`No seed files found for '${name}' in db/seeds.`);
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to run seeds with NODE_ENV=production.");
  for (const f of files) {
    process.stdout.write(`-> seed ${name}/${f} ... `);
    await client.query("BEGIN");
    try {
      await client.query(read(dir, f).sql);
      await client.query("COMMIT");
      console.log("ok");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.log("FAILED");
      throw err;
    }
  }
}

(async () => {
  const client = await connect();
  try {
    if (command === "status") await status(client);
    else if (command === "seed") await seed(client, args.filter((a) => !a.startsWith("--"))[1]);
    else await up(client);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
