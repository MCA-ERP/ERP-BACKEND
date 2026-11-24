-- ====================================================================
-- MIGRATION 109: ADMISSIONS PORTAL
-- Leads and follow-ups on admission enquiries, the extra enquiry details, and the final "confirmed" mark on an application.
-- The Admissions portal and the School Admin Admission module read and write the same adm_* tables.
-- ====================================================================

ALTER TABLE public.adm_enquiries
    ADD COLUMN IF NOT EXISTS dob             DATE,
    ADD COLUMN IF NOT EXISTS gender          VARCHAR(10),
    ADD COLUMN IF NOT EXISTS email           VARCHAR(150),
    ADD COLUMN IF NOT EXISTS notes           VARCHAR(500),
    ADD COLUMN IF NOT EXISTS interest        VARCHAR(4) NOT NULL DEFAULT 'Warm',
    ADD COLUMN IF NOT EXISTS next_followup   DATE,
    ADD COLUMN IF NOT EXISTS closed_reason   VARCHAR(200);
ALTER TABLE public.adm_enquiries DROP CONSTRAINT IF EXISTS adm_enquiries_interest_check;
ALTER TABLE public.adm_enquiries ADD CONSTRAINT adm_enquiries_interest_check CHECK (interest IN ('Hot', 'Warm', 'Cold'));
ALTER TABLE public.adm_enquiries DROP CONSTRAINT IF EXISTS adm_enquiries_gender_check;
ALTER TABLE public.adm_enquiries ADD CONSTRAINT adm_enquiries_gender_check CHECK (gender IS NULL OR gender IN ('Female', 'Male', 'Other'));
CREATE INDEX IF NOT EXISTS idx_adm_enquiries_followup ON public.adm_enquiries (institution_id, status, next_followup);

CREATE TABLE IF NOT EXISTS public.adm_followups (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    enquiry_id     UUID NOT NULL REFERENCES public.adm_enquiries(id) ON DELETE CASCADE,
    how            VARCHAR(10) NOT NULL CHECK (how IN ('Call', 'Visit', 'Message', 'Email')),
    outcome        VARCHAR(300) NOT NULL,
    interest       VARCHAR(4) NOT NULL CHECK (interest IN ('Hot', 'Warm', 'Cold')),
    next_followup  DATE,
    done_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    logged_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adm_followups_school ON public.adm_followups (institution_id, done_on DESC);
CREATE INDEX IF NOT EXISTS idx_adm_followups_enquiry ON public.adm_followups (enquiry_id, done_on DESC);
ALTER TABLE public.adm_followups ENABLE ROW LEVEL SECURITY;

-- the last step of the pipeline: the school has confirmed the admission
ALTER TABLE public.adm_applications ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- The Admissions Head role is limited to a list of modules (role_modules). Add what the portal's own pages need:
-- the AI assistant, staff self-service (claims, payslips) and fees (assigning the new student's fee plan).
INSERT INTO public.role_modules (role_id, module_code)
SELECT r.id, m.code FROM public.roles r
CROSS JOIN (VALUES ('school_assistant'), ('employee_self_service'), ('fees'), ('online_admissions')) AS m(code)
WHERE r.name = 'AdmissionsHead'
  AND EXISTS (SELECT 1 FROM public.role_modules rm WHERE rm.role_id = r.id)
ON CONFLICT DO NOTHING;
