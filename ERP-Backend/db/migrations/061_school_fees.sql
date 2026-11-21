-- School fees: categories, heads, groups, structure, optional fees, student plans, concessions and payments.
CREATE SEQUENCE public.fee_receipt_seq START 9813;
CREATE SEQUENCE public.fee_concession_seq START 119;

CREATE TABLE public.fee_categories (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(80) NOT NULL,
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, name)
);
CREATE TABLE public.fee_heads (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(80) NOT NULL,
    category_id    UUID REFERENCES public.fee_categories(id) ON DELETE SET NULL,
    frequency      VARCHAR(20) NOT NULL DEFAULT 'Term-wise',
    optional_text  VARCHAR(40) NOT NULL DEFAULT 'No',
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, name)
);
CREATE TABLE public.fee_groups (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(80) NOT NULL,
    classes        VARCHAR(60) NOT NULL DEFAULT '',
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, name)
);
CREATE TABLE public.fee_structure (
    group_id UUID NOT NULL REFERENCES public.fee_groups(id) ON DELETE CASCADE,
    head_id  UUID NOT NULL REFERENCES public.fee_heads(id) ON DELETE CASCADE,
    amount   INTEGER NOT NULL CHECK (amount >= 0),
    PRIMARY KEY (group_id, head_id)
);
CREATE TABLE public.fee_section_overrides (
    section_id UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    head_id    UUID NOT NULL REFERENCES public.fee_heads(id) ON DELETE CASCADE,
    amount     INTEGER NOT NULL CHECK (amount >= 0),
    stream     VARCHAR(60) NOT NULL DEFAULT '',
    PRIMARY KEY (section_id, head_id)
);
CREATE TABLE public.fee_optional (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(80) NOT NULL,
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('Transport', 'Hostel', 'Mess', 'Other')),
    amount_year    INTEGER NOT NULL CHECK (amount_year >= 0),
    details        VARCHAR(160) NOT NULL DEFAULT '',
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, name)
);
CREATE TABLE public.fee_settings (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    terms          JSONB NOT NULL DEFAULT '[40,35,25]'
);
CREATE TABLE public.student_fee_plans (
    student_id        UUID PRIMARY KEY REFERENCES public.students(id) ON DELETE CASCADE,
    institution_id    UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    group_id          UUID REFERENCES public.fee_groups(id) ON DELETE SET NULL,
    transport_id      UUID REFERENCES public.fee_optional(id) ON DELETE SET NULL,
    hostel_id         UUID REFERENCES public.fee_optional(id) ON DELETE SET NULL,
    concession_pct    INTEGER NOT NULL DEFAULT 0 CHECK (concession_pct BETWEEN 0 AND 100),
    concession_amount INTEGER NOT NULL DEFAULT 0 CHECK (concession_amount >= 0),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE public.fee_concessions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL DEFAULT ('CR-' || lpad(nextval('public.fee_concession_seq')::text, 4, '0')),
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    ctype          VARCHAR(16) NOT NULL CHECK (ctype IN ('Scholarship', 'Sibling', 'Staff ward', 'Financial aid', 'Other')),
    reason         VARCHAR(200) NOT NULL DEFAULT '',
    amount         INTEGER NOT NULL CHECK (amount > 0),
    requested_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected'))
);
CREATE TABLE public.fee_payments (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    receipt_no     VARCHAR(20) NOT NULL DEFAULT ('RCT-' || to_char(NOW(), 'YY') || '-' || lpad(nextval('public.fee_receipt_seq')::text, 5, '0')),
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    mode           VARCHAR(10) NOT NULL CHECK (mode IN ('Cash', 'UPI', 'Card', 'Cheque', 'Bank')),
    reference      VARCHAR(60),
    concession     INTEGER NOT NULL DEFAULT 0 CHECK (concession >= 0),
    total          INTEGER NOT NULL CHECK (total >= 0),
    collected_at   VARCHAR(8) NOT NULL CHECK (collected_at IN ('Counter', 'Online')),
    paid_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    status         VARCHAR(8) NOT NULL DEFAULT 'Paid' CHECK (status IN ('Paid', 'Pending', 'Failed')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_fee_payments_school ON public.fee_payments (institution_id, paid_on DESC);
CREATE TABLE public.fee_payment_lines (
    payment_id UUID NOT NULL REFERENCES public.fee_payments(id) ON DELETE CASCADE,
    line_key   VARCHAR(20) NOT NULL,
    label      VARCHAR(80) NOT NULL,
    amount     INTEGER NOT NULL CHECK (amount > 0),
    PRIMARY KEY (payment_id, line_key)
);

ALTER TABLE public.fee_categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_heads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_groups            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_structure         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_section_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_optional          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_fee_plans     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_concessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_payments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_payment_lines     ENABLE ROW LEVEL SECURITY;
