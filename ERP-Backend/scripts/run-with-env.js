#!/usr/bin/env node
/**
 * Runs a command with one environment's settings loaded from env/.env.<name>.
 *
 *   node scripts/run-with-env.js <dev|uat|preprod|prod> -- <command...>
 *
 * Normally you use the npm scripts instead, for example:
 *   npm run dev:uat        start the API with the UAT settings (auto-restart on changes)
 *   npm run build          compile once (the same for every environment)
 *   npm run start:prod     run the compiled API with the production settings
 *   npm run migrate:prod   apply database migrations to the production database
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ENVS = ["dev", "uat", "preprod", "prod"];
// the API cannot start without these
const REQUIRED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "CORS_ORIGIN"];

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** KEY=value lines; # comments, blank lines and "quoted values" are understood. */
function parse(text) {
  const out = {};
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[key] = value;
  }
  return out;
}

const args = process.argv.slice(2);
const name = args[0];
const split = args.indexOf("--");
const command = split === -1 ? [] : args.slice(split + 1);

if (!ENVS.includes(name)) fail(`Choose an environment: ${ENVS.join(", ")}. Example: npm run dev:uat`);
if (!command.length) fail("Nothing to run. Use the npm scripts, for example: npm run dev:" + name);

const root = path.join(__dirname, "..");
const file = path.join(root, "env", `.env.${name}`);
if (!fs.existsSync(file)) {
  fail(`env/.env.${name} does not exist.\nCreate it from the template:  copy env\\.env.${name}.example env\\.env.${name}   (then fill in the values)`);
}

const values = parse(fs.readFileSync(file, "utf8"));
const missing = REQUIRED.filter((k) => !values[k]);
if (missing.length) fail(`env/.env.${name} is missing: ${missing.join(", ")}`);

if (name !== "dev") {
  const problems = [];
  if (values.NODE_ENV !== "production") problems.push("NODE_ENV must be production");
  if (/localhost|127\.0\.0\.1/i.test(values.CORS_ORIGIN)) problems.push("CORS_ORIGIN still points at localhost");
  if (!/^https:/i.test(values.APP_URL || "")) problems.push("APP_URL must be an https address");
  if (!/^https:/i.test(values.API_PUBLIC_URL || "")) problems.push("API_PUBLIC_URL must be an https address");
  if (problems.length) fail(`env/.env.${name} is not ready for a live environment:\n  - ${problems.join("\n  - ")}`);
}

if (fs.existsSync(path.join(root, ".env"))) {
  console.warn("⚠ A plain .env file also exists. Any setting missing from env/.env." + name + " falls back to it. Delete it once you no longer need it.");
}

// the chosen file wins over anything already set in the shell
for (const [k, v] of Object.entries(values)) process.env[k] = v;
process.env.APP_ENV = name;

console.log(`▶ Environment: ${name.toUpperCase()}  (${path.relative(root, file)})  ·  ${Object.keys(values).length} settings loaded`);
console.log(`  CORS_ORIGIN = ${values.CORS_ORIGIN}`);

const child = spawn(command.join(" "), { cwd: root, stdio: "inherit", shell: true, env: process.env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
