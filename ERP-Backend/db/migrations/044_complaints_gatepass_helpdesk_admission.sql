-- ====================================================================
-- MIGRATION 044: COMPLAINTS, GATE PASSES, HELP DESK AND ADMISSION ENQUIRIES / APPLICATIONS
-- More front-desk registers, the school's own help desk (parents and staff raise requests to the school), and the first two
-- steps of admission. Every row belongs to one school. Reference numbers run on shared sequences.
-- ====================================================================

CREATE SEQUENCE public.fo_complaint_seq START 1001;
CREATE SEQUENCE public.fo_gate_student_seq START 1001;
CREATE SEQUENCE public.fo_gate_staff_seq START 1001;
CREATE SEQUENCE public.hd_ticket_seq START 1001;
CREATE SEQUENCE public.adm_enquiry_seq START 1001;
CREATE SEQUENCE public.adm_application_seq START 1001;

CREATE TABLE public.fo_complaints (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('CMP-' || nextval('public.fo_complaint_seq')),
    raised_by      VARCHAR(150) NOT NULL,
    about          VARCHAR(60) NOT NULL,
    details        VARCHAR(500) NOT NULL,
    assigned_to    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    raised_on      DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(12) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In progress', 'Resolved')),
    resolved_at    TIMESTAMPTZ,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_fo_complaints_school ON public.fo_complaints (institution_id, raised_on DESC);

CREATE TABLE public.fo_gate_passes (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT '',
    kind           VARCHAR(8) NOT NULL CHECK (kind IN ('Student', 'Staff')),
    person_name    VARCHAR(150) NOT NULL,
    class_dept     VARCHAR(60),
    reason         VARCHAR(300) NOT NULL,
    out_time       TIME,
    picked_up_by   VARCHAR(150),
    pass_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(16) NOT NULL DEFAULT 'Pending approval' CHECK (status IN ('Pending approval', 'Expected', 'Left', 'Out', 'Returned', 'Rejected')),
    decided_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_fo_gate_school ON public.fo_gate_passes (institution_id, pass_date DESC);

-- GP-S-1001 for students, GP-T-1001 for staff
CREATE FUNCTION public.fo_gate_pass_code() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.code IS NULL OR NEW.code = '' THEN
        NEW.code := CASE WHEN NEW.kind = 'Student' THEN 'GP-S-' || nextval('public.fo_gate_student_seq') ELSE 'GP-T-' || nextval('public.fo_gate_staff_seq') END;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_fo_gate_pass_code BEFORE INSERT ON public.fo_gate_passes FOR EACH ROW EXECUTE FUNCTION public.fo_gate_pass_code();

CREATE TABLE public.hd_categories (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(80) NOT NULL,
    raised_by      VARCHAR(10) NOT NULL CHECK (raised_by IN ('Parents', 'Staff')),
    handled_by     VARCHAR(80) NOT NULL,
    reply_hours    INTEGER NOT NULL CHECK (reply_hours BETWEEN 1 AND 720),
    sort_order     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (institution_id, name)
);

CREATE TABLE public.hd_tickets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id  UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code            VARCHAR(20) NOT NULL DEFAULT ('HD-' || nextval('public.hd_ticket_seq')),
    subject         VARCHAR(250) NOT NULL,
    category        VARCHAR(80) NOT NULL,
    raised_by_name  VARCHAR(150) NOT NULL,
    raised_by_kind  VARCHAR(10) NOT NULL CHECK (raised_by_kind IN ('Parent', 'Teacher', 'Staff')),
    priority        VARCHAR(8) NOT NULL DEFAULT 'Normal' CHECK (priority IN ('High', 'Normal', 'Low')),
    assigned_name   VARCHAR(150),
    status          VARCHAR(16) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In progress', 'Waiting on you', 'Resolved')),
    rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
    first_reply_at  TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    created_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_hd_tickets_school ON public.hd_tickets (institution_id, created_at DESC);

CREATE TABLE public.adm_enquiries (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('AE-' || nextval('public.adm_enquiry_seq')),
    child          VARCHAR(150) NOT NULL,
    class_sought   VARCHAR(30) NOT NULL,
    parent_name    VARCHAR(150) NOT NULL,
    mobile         VARCHAR(30),
    source         VARCHAR(40) NOT NULL DEFAULT 'Walk-in',
    counsellor     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    enquiry_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(12) NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Follow-up', 'Converted', 'Closed')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_adm_enquiries_school ON public.adm_enquiries (institution_id, enquiry_date DESC);

CREATE TABLE public.adm_applications (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(30) NOT NULL DEFAULT ('APP-' || (EXTRACT(YEAR FROM NOW())::INT + 1) || '-' || LPAD(nextval('public.adm_application_seq')::TEXT, 4, '0')),
    child          VARCHAR(150) NOT NULL,
    class_sought   VARCHAR(30) NOT NULL,
    parent_name    VARCHAR(150) NOT NULL,
    mobile         VARCHAR(30),
    source         VARCHAR(40) NOT NULL DEFAULT 'Front office',
    details        JSONB NOT NULL DEFAULT '{}'::JSONB,
    enquiry_id     UUID REFERENCES public.adm_enquiries(id) ON DELETE SET NULL,
    applied_on     DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(14) NOT NULL DEFAULT 'Under review' CHECK (status IN ('Under review', 'Approved', 'Allocated', 'Returned', 'Rejected', 'Waitlisted')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_adm_applications_school ON public.adm_applications (institution_id, applied_on DESC);

ALTER TABLE public.fo_complaints   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fo_gate_passes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hd_categories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hd_tickets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_enquiries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_applications ENABLE ROW LEVEL SECURITY;
