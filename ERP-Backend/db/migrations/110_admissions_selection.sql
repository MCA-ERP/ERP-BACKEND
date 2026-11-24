-- ====================================================================
-- MIGRATION 110: ADMISSIONS PORTAL, APPLICATION FEE AND SELECTION
-- The application form fee (pending, paid, waived), the submit and verify marks that move an application along,
-- the reason a form was returned, per-class eligibility rules, and the score a panel gives after an interaction or test.
-- ====================================================================

ALTER TABLE public.adm_applications
    ADD COLUMN IF NOT EXISTS submitted_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS fee_status    VARCHAR(8) NOT NULL DEFAULT 'Pending',
    ADD COLUMN IF NOT EXISTS fee_amount    INTEGER,
    ADD COLUMN IF NOT EXISTS fee_mode      VARCHAR(12),
    ADD COLUMN IF NOT EXISTS fee_paid_on   DATE,
    ADD COLUMN IF NOT EXISTS fee_note      VARCHAR(120),
    ADD COLUMN IF NOT EXISTS return_reason VARCHAR(200);
ALTER TABLE public.adm_applications DROP CONSTRAINT IF EXISTS adm_applications_fee_status_check;
ALTER TABLE public.adm_applications ADD CONSTRAINT adm_applications_fee_status_check CHECK (fee_status IN ('Pending', 'Paid', 'Waived'));

-- applications that exist today were taken before the fee step: treat them as submitted, with no fee recorded
UPDATE public.adm_applications SET submitted_at = created_at, fee_status = 'Paid', fee_amount = 0, fee_note = 'Before fee tracking' WHERE submitted_at IS NULL;

ALTER TABLE public.adm_interviews
    ADD COLUMN IF NOT EXISTS score          INTEGER CHECK (score BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS recommendation VARCHAR(20) CHECK (recommendation IN ('Recommend', 'Waitlist', 'Do not recommend'));

CREATE TABLE IF NOT EXISTS public.adm_class_rules (
    institution_id   UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    class_name       VARCHAR(30) NOT NULL,
    min_age          INTEGER NOT NULL CHECK (min_age BETWEEN 1 AND 25),
    seats            INTEGER NOT NULL DEFAULT 0 CHECK (seats >= 0),
    needs_assessment BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (institution_id, class_name)
);
ALTER TABLE public.adm_class_rules ENABLE ROW LEVEL SECURITY;
