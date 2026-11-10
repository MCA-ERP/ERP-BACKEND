-- ====================================================================
-- MIGRATION 028: SYSTEM SETTINGS
-- Platform identity and contact details, regional and date/time formats, maintenance mode,
-- self sign-up, and a release history.
-- ====================================================================

CREATE TABLE public.platform_releases (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version     VARCHAR(30) NOT NULL UNIQUE,
    released_on DATE NOT NULL DEFAULT CURRENT_DATE,
    notes       TEXT NOT NULL DEFAULT '',
    created_by  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.platform_releases ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_settings (key, value) VALUES
    ('general.short_name',          '"MCA"'::jsonb),
    ('general.tagline',             '"Your class, assisted."'::jsonb),
    ('general.company',             '""'::jsonb),
    ('general.main_domain',         '""'::jsonb),
    ('contact.whatsapp',            '""'::jsonb),
    ('contact.hours',               '""'::jsonb),
    ('contact.sales_email',         '""'::jsonb),
    ('contact.address',             '""'::jsonb),
    ('branding.mark_url',           '""'::jsonb),
    ('branding.favicon_url',        '""'::jsonb),
    ('branding.invoice_logo_url',   '""'::jsonb),
    ('regional.countries',          '["IN"]'::jsonb),
    ('locale.week_start',           '"Monday"'::jsonb),
    ('locale.financial_year',       '"April - March"'::jsonb),
    ('locale.time_format',          '"12h"'::jsonb),
    ('locale.show_seconds',         'false'::jsonb),
    ('maintenance.enabled',         'false'::jsonb),
    ('maintenance.message',         '"We are upgrading the platform and will be back shortly."'::jsonb),
    ('maintenance.starts_at',       '""'::jsonb),
    ('maintenance.ends_at',         '""'::jsonb),
    ('app.self_signup',             'true'::jsonb),
    ('notify.reply_to',             '""'::jsonb)
ON CONFLICT (key) DO NOTHING;
