-- ====================================================================
-- MIGRATION 115: STAFF PERSONAL SETTINGS
-- A staff member's photo and their notification choices (used by the Principal portal's Personal Settings).
-- ====================================================================
CREATE TABLE IF NOT EXISTS public.staff_settings (
    profile_id     UUID PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    photo          TEXT,
    prefs          JSONB NOT NULL DEFAULT '{}'::JSONB,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.staff_settings ENABLE ROW LEVEL SECURITY;
