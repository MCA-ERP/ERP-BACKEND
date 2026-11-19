-- Parent requests and feedback, the boards a school runs, and academic-year working days.
CREATE SEQUENCE public.parent_req_seq START 1001;
CREATE SEQUENCE public.parent_fb_seq START 631;

ALTER TABLE public.academic_years ADD COLUMN IF NOT EXISTS working_days INTEGER CHECK (working_days BETWEEN 1 AND 366);
ALTER TABLE public.guardians
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_device   VARCHAR(30);

CREATE TABLE public.parent_requests (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id       UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code                 VARCHAR(20) NOT NULL DEFAULT ('PR-' || nextval('public.parent_req_seq')),
    kind                 VARCHAR(12) NOT NULL CHECK (kind IN ('leave', 'correction', 'mobile', 'other', 'app')),
    guardian_id          UUID NOT NULL REFERENCES public.guardians(id) ON DELETE CASCADE,
    student_id           UUID REFERENCES public.students(id) ON DELETE SET NULL,
    req_type             VARCHAR(60),
    details              VARCHAR(400) NOT NULL,
    current_number       VARCHAR(30),
    new_number           VARCHAR(30),
    reason               VARCHAR(200),
    raised_on            DATE NOT NULL DEFAULT CURRENT_DATE,
    status               VARCHAR(16) NOT NULL,
    created_by           UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_parent_requests_school ON public.parent_requests (institution_id, kind, raised_on DESC);

CREATE TABLE public.parent_feedback (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('PF-' || lpad(nextval('public.parent_fb_seq')::text, 4, '0')),
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('feedback', 'complaint')),
    guardian_id    UUID NOT NULL REFERENCES public.guardians(id) ON DELETE CASCADE,
    student_id     UUID REFERENCES public.students(id) ON DELETE SET NULL,
    about          VARCHAR(150) NOT NULL,
    comment        VARCHAR(2000),
    rating         INTEGER CHECK (rating BETWEEN 1 AND 5),
    raised_on      DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(12) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'In progress', 'Resolved')),
    resolution     VARCHAR(1000),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_parent_feedback_school ON public.parent_feedback (institution_id, kind, raised_on DESC);

CREATE TABLE public.school_boards (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    board          VARCHAR(12) NOT NULL CHECK (board IN ('CBSE', 'ICSE', 'State Board', 'Other Board')),
    in_use         BOOLEAN NOT NULL DEFAULT FALSE,
    loc_reminders  BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, board)
);

ALTER TABLE public.parent_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_boards   ENABLE ROW LEVEL SECURITY;
