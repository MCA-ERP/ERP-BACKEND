-- ====================================================================
-- MIGRATION 037: OFFLINE MODE PER MODULE, AND THE PLATFORM-WIDE MODULE RULES
-- ====================================================================

ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS offline_mode BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE public.modules SET offline_mode = TRUE WHERE code IN ('student_information', 'academics', 'online_classes');

INSERT INTO public.platform_settings (key, value) VALUES
    ('modules.admins_toggle',   'true'::jsonb),
    ('modules.confirm_addon',   'true'::jsonb),
    ('modules.hide_unused',     'false'::jsonb),
    ('modules.default_for_new', '"off"'::jsonb)
ON CONFLICT (key) DO NOTHING;
