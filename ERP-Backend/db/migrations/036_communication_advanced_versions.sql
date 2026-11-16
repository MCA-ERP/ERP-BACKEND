-- ====================================================================
-- MIGRATION 036: LIVE VERSION AND RELEASE DATE OF THE COMMUNICATION AND ADVANCED MODULES
-- Shown on each module's page ("Version 4.2.0, Released 12 Sep 2026").
-- ====================================================================

CREATE TEMP TABLE _v (code TEXT, version TEXT, released DATE);
INSERT INTO _v VALUES
    ('sms_whatsapp',       '2.2.0', '2026-09-12'),
    ('email',              '2.0.6', '2026-09-12'),
    ('whatsapp',           '1.4.0', '2026-09-12'),
    ('notifications',      '3.0.2', '2026-10-15'),
    ('school_diary',       '2.5.0', '2026-09-12'),
    ('parent_app',         '4.2.0', '2026-09-12'),
    ('online_classes',     '2.9.1', '2026-10-09'),
    ('hostel',             '1.7.0', '2026-09-12'),
    ('inventory',          '1.9.4', '2026-09-12'),
    ('custom_reports_api', '1.2.0', '2026-09-12'),
    ('health_welfare',     '1.5.1', '2026-09-12'),
    ('cafeteria',          '1.1.0', '2026-09-12');

UPDATE public.modules m SET version = v.version FROM _v v WHERE m.code = v.code;

INSERT INTO public.module_releases (module_code, version, notes, status, rollout_percent, released_at)
SELECT code, version, 'Current release.', 'live', 100, released FROM _v
ON CONFLICT (module_code, version) DO NOTHING;

DROP TABLE _v;
