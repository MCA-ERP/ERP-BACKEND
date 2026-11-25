-- HR recruitment: where each opening is advertised, TET rule, background check discrepancies,
-- withdrawn offers and the day a vacancy was filled.
ALTER TABLE public.hr_openings
    ADD COLUMN IF NOT EXISTS channels    TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS description VARCHAR(300) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS needs_tet   BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.hr_checks
    ADD COLUMN IF NOT EXISTS discrepancy VARCHAR(300) NOT NULL DEFAULT '';

ALTER TABLE public.hr_offers DROP CONSTRAINT IF EXISTS hr_offers_status_check;
ALTER TABLE public.hr_offers
    ADD CONSTRAINT hr_offers_status_check CHECK (status IN ('Sent', 'Accepted', 'Declined', 'Withdrawn'));
ALTER TABLE public.hr_offers
    ADD COLUMN IF NOT EXISTS decline_reason VARCHAR(160) NOT NULL DEFAULT '';

ALTER TABLE public.hr_vacancies
    ADD COLUMN IF NOT EXISTS filled_on DATE;
