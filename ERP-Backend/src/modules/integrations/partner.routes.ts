import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { sendError } from "../../lib/http-error";
import { parsePage, safeSearch } from "../../lib/query";
import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { authenticateApiKey } from "./integrations.service";

/**
 * Read-only API for partners, authenticated by an API key created in Integrations:
 *   Authorization: Bearer mca_live_...   (or X-API-Key)
 * Each key carries scopes; a route answers only if the key holds the scope it needs.
 */
export const partnerRouter = Router();

interface PartnerRequest extends Request {
  apiKey?: { id: string; name: string; scopes: string[] };
}

async function apiKeyGuard(req: PartnerRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "");
  try {
    const key = header ? await authenticateApiKey(header.trim()) : null;
    if (!key) {
      res.status(401).json({ error: "A valid API key is required." });
      return;
    }
    req.apiKey = key;
    next();
  } catch (err) {
    sendError(res, err, "Authentication failed");
  }
}

const needs = (scope: string) => (req: PartnerRequest, res: Response, next: NextFunction) => {
  if (req.apiKey?.scopes.includes(scope)) return next();
  res.status(403).json({ error: `This key does not have the ${scope} scope.` });
};

partnerRouter.use(apiKeyGuard);

partnerRouter.get("/schools", needs("schools:read"), async (req, res) => {
  try {
    const p = parsePage(req.query);
    let q = supabaseAdmin
      .from("platform_school_overview")
      .select("code, name, type, board, city, state, status, plan_name, students, renews_on, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(p.from, p.to);
    const search = safeSearch(req.query.search);
    if (search) q = q.or(`name.ilike.%${search}%,code.ilike.%${search}%`);
    const result = await q;
    res.json({ items: check(result), total: result.count ?? 0, page: p.page, pageSize: p.pageSize });
  } catch (err) {
    sendError(res, err, "Failed to load schools");
  }
});

partnerRouter.get("/invoices", needs("invoices:read"), async (req, res) => {
  try {
    const p = parsePage(req.query);
    let q = supabaseAdmin
      .from("platform_invoice_overview")
      .select("number, school_code, school_name, description, issue_date, due_on, subtotal_paise, gst_rate_percent, tax_paise, total_paise, paid_paise, balance_paise, status", { count: "exact" })
      .order("issue_date", { ascending: false })
      .range(p.from, p.to);
    if (typeof req.query.school_code === "string") q = q.eq("school_code", req.query.school_code.toUpperCase());
    if (typeof req.query.status === "string") q = q.eq("status", req.query.status);
    const result = await q;
    res.json({ items: check(result), total: result.count ?? 0, page: p.page, pageSize: p.pageSize });
  } catch (err) {
    sendError(res, err, "Failed to load invoices");
  }
});
