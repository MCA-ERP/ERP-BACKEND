-- Parent management (login state, contact and address details, messages) and the alumni directory.
CREATE SEQUENCE public.parent_code_seq START 1001;
CREATE SEQUENCE public.parent_msg_seq START 4001;

ALTER TABLE public.guardians
    ADD COLUMN IF NOT EXISTS parent_code     VARCHAR(20),
    ADD COLUMN IF NOT EXISTS login_status    VARCHAR(12) NOT NULL DEFAULT 'None' CHECK (login_status IN ('None', 'Active', 'Inactive')),
    ADD COLUMN IF NOT EXISTS whatsapp        VARCHAR(30),
    ADD COLUMN IF NOT EXISTS language        VARCHAR(30),
    ADD COLUMN IF NOT EXISTS emergency_name  VARCHAR(150),
    ADD COLUMN IF NOT EXISTS emergency_phone VARCHAR(30),
    ADD COLUMN IF NOT EXISTS address         VARCHAR(400),
    ADD COLUMN IF NOT EXISTS city            VARCHAR(100),
    ADD COLUMN IF NOT EXISTS pincode         VARCHAR(10),
    ADD COLUMN IF NOT EXISTS income_band     VARCHAR(40),
    ADD COLUMN IF NOT EXISTS otp_requested_at TIMESTAMPTZ;

UPDATE public.guardians SET parent_code = 'PAR-' || to_char(created_at, 'YYYY') || '-' || nextval('public.parent_code_seq') WHERE parent_code IS NULL;
ALTER TABLE public.guardians ALTER COLUMN parent_code SET DEFAULT ('PAR-' || to_char(NOW(), 'YYYY') || '-' || nextval('public.parent_code_seq'));

CREATE TABLE public.parent_messages (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(20) NOT NULL DEFAULT ('PM-' || nextval('public.parent_msg_seq')),
    kind           VARCHAR(14) NOT NULL CHECK (kind IN ('message', 'notification', 'meeting')),
    guardian_id    UUID NOT NULL REFERENCES public.guardians(id) ON DELETE CASCADE,
    student_id     UUID REFERENCES public.students(id) ON DELETE SET NULL,
    subject        VARCHAR(200) NOT NULL,
    body           VARCHAR(2000),
    sent_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(12) NOT NULL DEFAULT 'Delivered' CHECK (status IN ('Delivered', 'Read', 'Replied', 'Scheduled', 'Held', 'Cancelled')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_parent_msgs_school ON public.parent_messages (institution_id, kind, sent_on DESC);

CREATE TABLE public.alumni (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    full_name      VARCHAR(150) NOT NULL,
    batch_year     INTEGER NOT NULL CHECK (batch_year BETWEEN 1900 AND 2100),
    last_class     VARCHAR(60),
    studied        VARCHAR(150),
    now_at         VARCHAR(150),
    email          VARCHAR(255),
    phone          VARCHAR(30),
    helps_as       VARCHAR(10) CHECK (helps_as IN ('Active', 'Given', 'Upcoming')),
    given_amount   INTEGER NOT NULL DEFAULT 0 CHECK (given_amount >= 0),
    given_on       DATE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_alumni_school ON public.alumni (institution_id, batch_year DESC);

CREATE TABLE public.alumni_events (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    title          VARCHAR(200) NOT NULL,
    event_date     DATE NOT NULL,
    audience       VARCHAR(150),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_alumni_events_school ON public.alumni_events (institution_id, event_date DESC);

ALTER TABLE public.parent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alumni          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alumni_events   ENABLE ROW LEVEL SECURITY;
