-- ====================================================================
-- MIGRATION 032: PLAN LIMITS AND DOCUMENT REQUESTS
-- More of what a plan includes, and what happens when a school reaches a limit.
-- ====================================================================

ALTER TABLE public.plans
    ADD COLUMN IF NOT EXISTS admin_limit         INTEGER CHECK (admin_limit IS NULL OR admin_limit > 0),
    ADD COLUMN IF NOT EXISTS max_file_mb         INTEGER CHECK (max_file_mb IS NULL OR max_file_mb > 0),
    ADD COLUMN IF NOT EXISTS video_storage_gb    INTEGER CHECK (video_storage_gb IS NULL OR video_storage_gb > 0),
    ADD COLUMN IF NOT EXISTS extra_storage_paise INTEGER CHECK (extra_storage_paise IS NULL OR extra_storage_paise >= 0),
    ADD COLUMN IF NOT EXISTS sms_per_year        INTEGER CHECK (sms_per_year IS NULL OR sms_per_year >= 0),
    ADD COLUMN IF NOT EXISTS support             VARCHAR(100),
    ADD COLUMN IF NOT EXISTS show_on_pricing     BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS allow_instalments   BOOLEAN NOT NULL DEFAULT TRUE;

INSERT INTO public.platform_settings (key, value) VALUES
    ('plans.overage_policy',       '"block"'::jsonb),
    ('plans.storage_warn_percent', '80'::jsonb)
ON CONFLICT (key) DO NOTHING;
