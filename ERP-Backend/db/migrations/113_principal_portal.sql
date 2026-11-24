-- ====================================================================
-- MIGRATION 113: PRINCIPAL PORTAL
-- The Principal decides on records that the other portals keep (admissions, staff leave, fee concessions, exam results,
-- circulars, lesson plans, expenses, vacancies). The decision itself is written on the record it belongs to; this table
-- is the Principal's own log of what was decided, by whom, when, and why, for the "Decided" list and the audit trail.
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.principal_decisions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    kind           VARCHAR(20) NOT NULL,
    ref_id         VARCHAR(80) NOT NULL,
    title          VARCHAR(200) NOT NULL,
    action         VARCHAR(20) NOT NULL,
    note           VARCHAR(300),
    decided_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    decided_name   VARCHAR(150) NOT NULL DEFAULT '',
    decided_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_principal_decisions_school ON public.principal_decisions (institution_id, decided_at DESC);
ALTER TABLE public.principal_decisions ENABLE ROW LEVEL SECURITY;
