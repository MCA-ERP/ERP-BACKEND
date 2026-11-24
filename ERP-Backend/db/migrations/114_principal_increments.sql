-- ====================================================================
-- MIGRATION 114: PRINCIPAL APPROVES INCREMENTS
-- HR sends the increment recommendations to the Principal (hr_cycle.inc_sent). The Principal's decision is kept on the
-- same row so HR and Payroll see it.
-- ====================================================================
ALTER TABLE public.hr_cycle
    ADD COLUMN IF NOT EXISTS inc_approved    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS inc_decided_at  TIMESTAMPTZ;
