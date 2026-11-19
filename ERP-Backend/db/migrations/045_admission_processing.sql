-- ====================================================================
-- MIGRATION 045: ADMISSION PROCESSING
-- Documents, entrance tests and marks, interviews, the approval chain, admission fee and admission numbers.
-- ====================================================================

CREATE SEQUENCE public.adm_receipt_seq START 1001;
CREATE SEQUENCE public.adm_number_seq START 1001;

ALTER TABLE public.adm_applications DROP CONSTRAINT IF EXISTS adm_applications_status_check;
ALTER TABLE public.adm_applications ADD CONSTRAINT adm_applications_status_check
    CHECK (status IN ('Under review', 'Approved', 'Fee paid', 'Registered', 'Allocated', 'Returned', 'Rejected', 'Waitlisted'));
ALTER TABLE public.adm_applications
    ADD COLUMN level        INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
    ADD COLUMN level_since  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN admission_no VARCHAR(40);

CREATE TABLE public.adm_documents (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.adm_applications(id) ON DELETE CASCADE,
    doc_type       VARCHAR(60) NOT NULL,
    file_name      VARCHAR(150),
    status         VARCHAR(14) NOT NULL DEFAULT 'Pending review' CHECK (status IN ('Pending review', 'Verified', 'Returned')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_adm_documents_school ON public.adm_documents (institution_id, created_at DESC);

CREATE TABLE public.adm_tests (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(120) NOT NULL,
    subjects       VARCHAR(200) NOT NULL,
    max_marks      INTEGER NOT NULL CHECK (max_marks > 0),
    test_date      DATE NOT NULL,
    test_time      TIME,
    venue          VARCHAR(80),
    status         VARCHAR(12) NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Scheduled', 'Completed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.adm_test_marks (
    test_id        UUID NOT NULL REFERENCES public.adm_tests(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.adm_applications(id) ON DELETE CASCADE,
    marks          JSONB NOT NULL DEFAULT '{}'::JSONB,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (test_id, application_id)
);

CREATE TABLE public.adm_panels (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(60) NOT NULL,
    for_classes    VARCHAR(80) NOT NULL,
    members        VARCHAR(200) NOT NULL,
    status         VARCHAR(10) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.adm_interviews (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.adm_applications(id) ON DELETE CASCADE,
    panel_name     VARCHAR(120) NOT NULL,
    interview_date DATE NOT NULL,
    interview_time TIME,
    status         VARCHAR(12) NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'Completed', 'Rescheduled')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_adm_interviews_school ON public.adm_interviews (institution_id, interview_date DESC);

CREATE TABLE public.adm_approval_levels (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    level          INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
    role           VARCHAR(60) NOT NULL,
    person         VARCHAR(120) NOT NULL,
    hours          INTEGER NOT NULL CHECK (hours BETWEEN 1 AND 720),
    escalate_to    VARCHAR(120) NOT NULL,
    PRIMARY KEY (institution_id, level)
);

CREATE TABLE public.adm_fee_setup (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    class_group    VARCHAR(40) NOT NULL,
    admission_fee  INTEGER NOT NULL CHECK (admission_fee >= 0),
    caution        INTEGER NOT NULL CHECK (caution >= 0),
    form_fee       INTEGER NOT NULL CHECK (form_fee >= 0),
    sort_order     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (institution_id, class_group)
);

CREATE TABLE public.adm_fee_settings (
    institution_id  UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    pay_within_days INTEGER NOT NULL DEFAULT 7,
    online_payment  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE public.adm_fee_payments (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.adm_applications(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('ADF-' || nextval('public.adm_receipt_seq')),
    admission_fee  INTEGER NOT NULL,
    caution        INTEGER NOT NULL,
    mode           VARCHAR(12) NOT NULL CHECK (mode IN ('UPI', 'Card', 'Cash', 'Cheque', 'Net banking')),
    paid_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(8) NOT NULL DEFAULT 'Paid' CHECK (status IN ('Paid')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_adm_fee_payments_school ON public.adm_fee_payments (institution_id, paid_on DESC);

ALTER TABLE public.adm_documents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_tests           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_test_marks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_panels          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_interviews      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_approval_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_fee_setup       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_fee_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_fee_payments    ENABLE ROW LEVEL SECURITY;
