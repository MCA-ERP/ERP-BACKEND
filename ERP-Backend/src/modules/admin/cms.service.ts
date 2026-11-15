import { supabaseAdmin } from "../../../db/client";
import { check } from "../../lib/db";
import { HttpError } from "../../lib/http-error";
import { getSetting } from "./settings.service";

export const CMS_TYPES = ["page", "blog", "banner", "testimonial", "blog_category", "author", "faq"] as const;
export type CmsType = (typeof CMS_TYPES)[number];
/** What the public website may read. Authors are shown through the posts they wrote. */
export const PUBLIC_TYPES = ["page", "blog", "banner", "testimonial", "blog_category", "faq"] as const;
export type CmsStatus = "draft" | "published" | "archived";

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "item";

const COLUMNS = "id, type, slug, title, body, data, status, sort_order, published_at, starts_at, ends_at, updated_at";

export async function listItems(type: CmsType) {
  return check(await supabaseAdmin.from("cms_items").select(COLUMNS).eq("type", type).order("sort_order").order("updated_at", { ascending: false }));
}

export interface CmsInput {
  title: string;
  slug?: string;
  body?: string;
  data?: Record<string, unknown>;
  status?: CmsStatus;
  sort_order?: number;
  starts_at?: string | null;
  ends_at?: string | null;
}

/** Rules that belong to a kind of content, checked on every save. */
function checkRules(type: CmsType, input: { status?: CmsStatus; data?: Record<string, unknown>; starts_at?: string | null; ends_at?: string | null }) {
  if (input.starts_at && input.ends_at && new Date(input.ends_at).getTime() <= new Date(input.starts_at).getTime()) {
    throw new HttpError(400, "The end date must be after the start date.");
  }
  if (type === "testimonial" && input.status === "published") {
    const consent = input.data?.consent;
    if (consent !== true && consent !== "true") throw new HttpError(400, "Tick that the school agreed to be quoted before approving this testimonial.");
  }
}

export async function createItem(input: CmsInput & { type: CmsType }, actorProfileId?: string) {
  const status = input.status ?? "draft";
  checkRules(input.type, { ...input, status });
  return check(
    await supabaseAdmin
      .from("cms_items")
      .insert({
        type: input.type,
        title: input.title,
        slug: slugify(input.slug || input.title),
        body: input.body ?? "",
        data: input.data ?? {},
        status,
        sort_order: input.sort_order ?? 0,
        starts_at: input.starts_at ?? null,
        ends_at: input.ends_at ?? null,
        published_at: status === "published" ? new Date().toISOString() : null,
        created_by: actorProfileId ?? null,
      })
      .select()
      .single()
  );
}

export async function updateItem(id: string, patch: Partial<CmsInput>) {
  const current = check(await supabaseAdmin.from("cms_items").select("type, status, published_at, data, starts_at, ends_at").eq("id", id).maybeSingle()) as
    | { type: CmsType; status: CmsStatus; published_at: string | null; data: Record<string, unknown>; starts_at: string | null; ends_at: string | null }
    | null;
  if (!current) throw new HttpError(404, "Content item not found.");

  checkRules(current.type, {
    status: patch.status ?? current.status,
    data: patch.data ?? current.data,
    starts_at: patch.starts_at !== undefined ? patch.starts_at : current.starts_at,
    ends_at: patch.ends_at !== undefined ? patch.ends_at : current.ends_at,
  });
  const update: Record<string, unknown> = { ...patch };
  if (patch.slug !== undefined) update.slug = slugify(patch.slug);
  if (patch.status === "published" && !current.published_at) update.published_at = new Date().toISOString();
  return check(await supabaseAdmin.from("cms_items").update(update).eq("id", id).select().single());
}

export async function deleteItem(id: string) {
  const item = check(await supabaseAdmin.from("cms_items").select("type, title").eq("id", id).maybeSingle()) as { type: CmsType; title: string } | null;
  if (!item) throw new HttpError(404, "Content item not found.");
  // a category or an author that posts still use cannot disappear from under them
  if (item.type === "blog_category" || item.type === "author") {
    const key = item.type === "author" ? "author" : "category";
    const posts = check(await supabaseAdmin.from("cms_items").select("id").eq("type", "blog").filter(`data->>${key}`, "eq", item.title).limit(1)) as { id: string }[];
    if (posts.length) throw new HttpError(409, `"${item.title}" is used by blog posts. Move or delete those posts first.`);
  }
  check(await supabaseAdmin.from("cms_items").delete().eq("id", id).select("id"));
  return { success: true };
}

/** Published content only, for the public marketing website. Banners respect their start and end. */
export async function listPublished(type: CmsType) {
  const rows = check(
    await supabaseAdmin
      .from("cms_items")
      .select("slug, title, body, data, sort_order, published_at, starts_at, ends_at")
      .eq("type", type)
      .eq("status", "published")
      .order("sort_order")
      .order("published_at", { ascending: false })
  ) as { starts_at: string | null; ends_at: string | null }[];
  const now = Date.now();
  return rows.filter((r) => (!r.starts_at || new Date(r.starts_at).getTime() <= now) && (!r.ends_at || new Date(r.ends_at).getTime() > now));
}

// ── sitemap ─────────────────────────────────────────────────
export const pagePath = (item: { slug: string; data?: Record<string, unknown> }) => {
  const own = typeof item.data?.path === "string" ? item.data.path.trim() : "";
  if (own) return own.startsWith("/") ? own : "/" + own;
  return item.slug === "home" ? "/" : "/" + item.slug;
};

const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export function sitemapXml(base: string, urls: { path: string; lastmod: string | null }[]): string {
  const root = base.replace(/\/$/, "");
  const body = urls
    .map((u) => `  <url><loc>${xmlEscape(root + u.path)}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** Every address search engines should crawl: published pages, and published blog posts when switched on. */
export async function sitemapUrls(): Promise<{ title: string; path: string; lastmod: string | null; kind: "page" | "blog" }[]> {
  const includeBlog = await getSetting<boolean>("website.sitemap_include_blog", true);
  const rows = check(
    await supabaseAdmin
      .from("cms_items")
      .select("type, slug, title, data, updated_at")
      .in("type", includeBlog ? ["page", "blog"] : ["page"])
      .eq("status", "published")
      .order("type")
      .order("sort_order")
  ) as { type: "page" | "blog"; slug: string; title: string; data: Record<string, unknown>; updated_at: string }[];
  return rows.map((r) => ({ title: r.title, path: r.type === "blog" ? `/blog/${r.slug}` : pagePath(r), lastmod: r.updated_at, kind: r.type }));
}

export async function sitemapFor(base: string) {
  return sitemapXml(base, (await sitemapUrls()).map((u) => ({ path: u.path, lastmod: u.lastmod })));
}
