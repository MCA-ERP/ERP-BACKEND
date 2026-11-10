import { describe, expect, it } from "vitest";
import { pagePath, sitemapXml, slugify } from "./cms.service";

describe("pagePath", () => {
  it("serves the home page at the root and others by slug", () => {
    expect(pagePath({ slug: "home" })).toBe("/");
    expect(pagePath({ slug: "about" })).toBe("/about");
  });
  it("uses a page's own address when it has one", () => {
    expect(pagePath({ slug: "cbse", data: { path: "for-cbse-schools" } })).toBe("/for-cbse-schools");
    expect(pagePath({ slug: "cbse", data: { path: "/cbse" } })).toBe("/cbse");
  });
});

describe("sitemapXml", () => {
  it("lists every address under the site root with its last change", () => {
    const xml = sitemapXml("https://www.example.in/", [{ path: "/", lastmod: "2026-11-01T10:00:00Z" }, { path: "/blog/a&b", lastmod: null }]);
    expect(xml).toContain("<loc>https://www.example.in/</loc><lastmod>2026-11-01</lastmod>");
    expect(xml).toContain("<loc>https://www.example.in/blog/a&amp;b</loc>");
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
  });
});

describe("slugify", () => {
  it("makes web-safe words", () => expect(slugify("5 ways to cut fee defaulters!")).toBe("5-ways-to-cut-fee-defaulters"));
});
