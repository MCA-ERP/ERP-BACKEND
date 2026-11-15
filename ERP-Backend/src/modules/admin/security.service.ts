import type { Request } from "express";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";

// ── client address ──────────────────────────────────────────
/** Caller address as Express sees it (X-Forwarded-For is only used when the app trusts its proxy). */
export function clientIp(req: Request): string {
  let ip = req.ip || req.socket.remoteAddress || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip === "::1" ? "127.0.0.1" : ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

export function normalizeCidr(input: string): string {
  const value = input.trim();
  const [addr, bits, extra] = value.split("/");
  if (extra !== undefined) throw new HttpError(400, "Invalid address.");
  if (ipv4ToInt(addr) !== null) {
    const b = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(b) || b < 0 || b > 32) throw new HttpError(400, "The prefix length must be between 0 and 32.");
    return b === 32 ? addr : `${addr}/${b}`;
  }
  // IPv6 is matched exactly only
  if (/^[0-9a-fA-F:]+$/.test(addr) && addr.includes(":") && bits === undefined) return addr.toLowerCase();
  throw new HttpError(400, "Enter an IPv4 address, an IPv4 range like 203.0.113.0/24, or an exact IPv6 address.");
}

export function ipMatches(ip: string, cidr: string): boolean {
  const [addr, bits] = cidr.split("/");
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(addr);
  if (a === null || b === null) return ip.toLowerCase() === cidr.toLowerCase();
  const prefix = bits === undefined ? 32 : Number(bits);
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

// ── allowlist ───────────────────────────────────────────────
const TTL_MS = 30_000;
let cache: { at: number; list: string[] } | null = null;

async function loadList(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.list;
  const rows = check(await supabaseAdmin.from("ip_allowlist").select("cidr")) as { cidr: string }[];
  cache = { at: Date.now(), list: rows.map((r) => r.cidr) };
  return cache.list;
}

/** An empty allowlist means no restriction. */
export async function isIpAllowed(ip: string): Promise<boolean> {
  const list = await loadList();
  return list.length === 0 || list.some((c) => ipMatches(ip, c));
}

export async function listAllowlist() {
  return check(await supabaseAdmin.from("ip_allowlist").select("id, cidr, label, created_at").order("created_at"));
}

export async function addAllowlist(cidrInput: string, label: string | null, requesterIp: string, actorProfileId?: string) {
  const cidr = normalizeCidr(cidrInput);
  const current = (check(await supabaseAdmin.from("ip_allowlist").select("cidr")) as { cidr: string }[]).map((r) => r.cidr);
  if (![...current, cidr].some((c) => ipMatches(requesterIp, c))) {
    throw new HttpError(400, `This would lock you out: your current address (${requesterIp}) is not covered. Add a range that includes it first.`);
  }
  const row = check(
    await supabaseAdmin.from("ip_allowlist").insert({ cidr, label, created_by: actorProfileId ?? null }).select("id, cidr, label, created_at").single()
  );
  cache = null;
  return row;
}

export async function removeAllowlist(id: string, requesterIp: string) {
  const rows = check(await supabaseAdmin.from("ip_allowlist").select("id, cidr")) as { id: string; cidr: string }[];
  if (!rows.some((r) => r.id === id)) throw new HttpError(404, "Entry not found.");
  const remaining = rows.filter((r) => r.id !== id);
  if (remaining.length > 0 && !remaining.some((r) => ipMatches(requesterIp, r.cidr))) {
    throw new HttpError(400, `This would lock you out: your current address (${requesterIp}) would no longer be covered.`);
  }
  check(await supabaseAdmin.from("ip_allowlist").delete().eq("id", id).select("id"));
  cache = null;
  return { success: true };
}

// ── backups / migrations ────────────────────────────────────
export async function getBackupInfo() {
  const migrations = check(
    await supabaseAdmin.from("schema_migrations").select("version, applied_at").order("version", { ascending: false })
  ) as { version: string; applied_at: string }[];
  return {
    provider: "Supabase",
    note: "Database backups are taken and restored by Supabase. Daily backups are included on paid plans; point-in-time recovery is a paid add-on. Manage them in the Supabase dashboard under Database → Backups.",
    migrations,
  };
}

// ── blocklist ───────────────────────────────────────────────
let blockCache: { at: number; list: string[] } | null = null;

async function loadBlocklist(): Promise<string[]> {
  if (blockCache && Date.now() - blockCache.at < TTL_MS) return blockCache.list;
  const rows = check(await supabaseAdmin.from("ip_blocklist").select("cidr")) as { cidr: string }[];
  blockCache = { at: Date.now(), list: rows.map((r) => r.cidr) };
  return blockCache.list;
}

/** Whether an address is on the blocklist. Blocked addresses cannot sign in or use the admin portal. */
export async function isIpBlocked(ip: string): Promise<boolean> {
  return (await loadBlocklist()).some((c) => ipMatches(ip, c));
}

export async function listBlocklist() {
  return check(await supabaseAdmin.from("ip_blocklist").select("id, cidr, reason, created_at").order("created_at", { ascending: false }));
}

export async function addBlock(cidrInput: string, reason: string | null, requesterIp: string, actorProfileId?: string) {
  const cidr = normalizeCidr(cidrInput);
  if (ipMatches(requesterIp, cidr)) throw new HttpError(400, `This would block your own address (${requesterIp}).`);
  const existing = check(await supabaseAdmin.from("ip_blocklist").select("id").eq("cidr", cidr).maybeSingle());
  if (existing) throw new HttpError(409, "That address is already blocked.");
  const row = check(await supabaseAdmin.from("ip_blocklist").insert({ cidr, reason, created_by: actorProfileId ?? null }).select("id, cidr, reason, created_at").single());
  blockCache = null;
  return row;
}

export async function removeBlock(id: string) {
  check(await supabaseAdmin.from("ip_blocklist").delete().eq("id", id).select("id"));
  blockCache = null;
  return { success: true };
}
