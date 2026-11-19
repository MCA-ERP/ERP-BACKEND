-- ====================================================================
-- MIGRATION 043: FRONT OFFICE REGISTERS AND STAFF LEAVE
-- Enquiries, visitors, appointments, calls and post for a school's front desk, and a staff member's own leave.
-- Every row belongs to one school (institution_id). Reference numbers (ENQ-1001, CL-1001 ...) run on one shared sequence each.
-- ====================================================================

CREATE SEQUENCE public.fo_enquiry_seq START 1001;
CREATE SEQUENCE public.fo_appointment_seq START 1001;
CREATE SEQUENCE public.fo_call_seq START 1001;
CREATE SEQUENCE public.fo_post_seq START 1001;

CREATE TABLE public.fo_enquiries (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('ENQ-' || nextval('public.fo_enquiry_seq')),
    visitor        VARCHAR(150) NOT NULL,
    purpose        VARCHAR(60) NOT NULL,
    mobile         VARCHAR(30),
    assigned_to    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    enquiry_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    next_followup  DATE,
    status         VARCHAR(12) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Follow-up', 'Converted', 'Closed')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_fo_enquiries_school ON public.fo_enquiries (institution_id, enquiry_date DESC);

CREATE TABLE public.fo_enquiry_followups (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    enquiry_id    UUID NOT NULL REFERENCES public.fo_enquiries(id) ON DELETE CASCADE,
    note          TEXT NOT NULL,
    next_followup DATE,
    logged_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.fo_visitors (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    visit_date     DATE NOT NULL DEFAULT CURRENT_DATE,
    visitor        VARCHAR(150) NOT NULL,
    purpose        VARCHAR(60) NOT NULL,
    details        VARCHAR(300),
    meeting        VARCHAR(150),
    id_proof       VARCHAR(80),
    in_time        TIME,
    out_time       TIME,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_fo_visitors_school ON public.fo_visitors (institution_id, visit_date DESC);

CREATE TABLE public.fo_appointments (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('APT-' || nextval('public.fo_appointment_seq')),
    with_whom      VARCHAR(80) NOT NULL,
    visitor        VARCHAR(150) NOT NULL,
    purpose        VARCHAR(80) NOT NULL,
    appt_date      DATE NOT NULL,
    appt_time      TIME,
    status         VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Confirmed', 'Completed', 'Cancelled')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_fo_appointments_school ON public.fo_appointments (institution_id, appt_date DESC);

CREATE TABLE public.fo_calls (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('CL-' || nextval('public.fo_call_seq')),
    direction      VARCHAR(10) NOT NULL CHECK (direction IN ('Incoming', 'Outgoing')),
    caller         VARCHAR(150) NOT NULL,
    number         VARCHAR(30),
    about          VARCHAR(100) NOT NULL,
    handled_by     VARCHAR(150),
    duration_min   INTEGER NOT NULL DEFAULT 0 CHECK (duration_min >= 0),
    call_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    follow_up      VARCHAR(14) NOT NULL DEFAULT 'Not needed' CHECK (follow_up IN ('Not needed', 'Callback due', 'Done')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_fo_calls_school ON public.fo_calls (institution_id, call_date DESC);

CREATE TABLE public.fo_post (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('PST-' || nextval('public.fo_post_seq')),
    direction      VARCHAR(10) NOT NULL CHECK (direction IN ('Incoming', 'Outgoing')),
    party          VARCHAR(150) NOT NULL,
    post_type      VARCHAR(40) NOT NULL,
    courier        VARCHAR(60),
    handled_by     VARCHAR(150),
    post_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(16) NOT NULL DEFAULT 'In transit' CHECK (status IN ('Delivered', 'In transit', 'Pending dispatch')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (code)
);
CREATE INDEX idx_fo_post_school ON public.fo_post (institution_id, post_date DESC);

-- ── leave ──
CREATE TABLE public.leave_policies (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    leave_type     VARCHAR(20) NOT NULL CHECK (leave_type IN ('Casual', 'Sick', 'Earned')),
    allowed_days   NUMERIC(5, 1) NOT NULL CHECK (allowed_days >= 0),
    details        VARCHAR(300) NOT NULL DEFAULT '',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (institution_id, leave_type)
);

CREATE TABLE public.leave_requests (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    profile_id     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    leave_type     VARCHAR(20) NOT NULL CHECK (leave_type IN ('Casual', 'Sick', 'Earned')),
    from_date      DATE NOT NULL,
    to_date        DATE NOT NULL,
    half_day       BOOLEAN NOT NULL DEFAULT FALSE,
    days           NUMERIC(5, 1) NOT NULL CHECK (days > 0),
    reason         TEXT NOT NULL DEFAULT '',
    cover_note     VARCHAR(300),
    status         VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Cancelled')),
    decided_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    decided_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (to_date >= from_date)
);
CREATE INDEX idx_leave_requests_person ON public.leave_requests (profile_id, from_date DESC);
CREATE INDEX idx_leave_requests_school ON public.leave_requests (institution_id, status);

CREATE TABLE public.comp_offs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    profile_id     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    worked_on      DATE NOT NULL,
    reason         VARCHAR(200) NOT NULL,
    use_by         DATE NOT NULL,
    status         VARCHAR(10) NOT NULL DEFAULT 'Available' CHECK (status IN ('Available', 'Used', 'Expired')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_comp_offs_person ON public.comp_offs (profile_id, worked_on DESC);

ALTER TABLE public.fo_enquiries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fo_enquiry_followups  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fo_visitors           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fo_appointments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fo_calls              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fo_post               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_policies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comp_offs             ENABLE ROW LEVEL SECURITY;
