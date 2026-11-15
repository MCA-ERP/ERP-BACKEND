-- ====================================================================
-- MIGRATION 026: WEBSITE / CMS
-- Blog categories, authors and FAQ become content types; banners get a run window;
-- items can be archived (ended banners, rejected testimonials); sitemap settings.
-- ====================================================================

ALTER TABLE public.cms_items DROP CONSTRAINT IF EXISTS cms_items_type_check;
ALTER TABLE public.cms_items
    ADD CONSTRAINT cms_items_type_check CHECK (type IN ('page', 'blog', 'banner', 'testimonial', 'blog_category', 'author', 'faq'));

ALTER TABLE public.cms_items DROP CONSTRAINT IF EXISTS cms_items_status_check;
ALTER TABLE public.cms_items
    ADD CONSTRAINT cms_items_status_check CHECK (status IN ('draft', 'published', 'archived'));

ALTER TABLE public.cms_items
    ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ends_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cms_items_type_status ON public.cms_items (type, status);

INSERT INTO public.platform_settings (key, value) VALUES
    ('website.site_url', '""'::jsonb),
    ('website.sitemap_include_blog', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
