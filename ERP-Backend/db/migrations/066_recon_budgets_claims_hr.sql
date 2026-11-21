-- Reconciliation, budgets and forecasts, staff claims and advances, reminder actions, HR staff records.
CREATE SEQUENCE public.fee_journal_seq START 3141;
CREATE TABLE public.fee_settlements (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    ref            VARCHAR(40) NOT NULL,
    payments_on    DATE NOT NULL,
    payments       INTEGER NOT NULL DEFAULT 0,
    gross          INTEGER NOT NULL CHECK (gross >= 0),
    fee_gst        INTEGER NOT NULL DEFAULT 0 CHECK (fee_gst >= 0),
    bank_amount    INTEGER,
    bank_credit_on DATE,
    bank_ref       VARCHAR(60),
    status         VARCHAR(18) NOT NULL DEFAULT 'Waiting for bank' CHECK (status IN ('Waiting for bank', 'Matched', 'Difference')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, ref)
);
ALTER TABLE public.fee_payments ADD COLUMN settlement_id UUID REFERENCES public.fee_settlements(id) ON DELETE SET NULL;

CREATE TABLE public.bank_statement_lines (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    line_on        DATE NOT NULL,
    narration      VARCHAR(240) NOT NULL,
    money_in       INTEGER NOT NULL DEFAULT 0 CHECK (money_in >= 0),
    money_out      INTEGER NOT NULL DEFAULT 0 CHECK (money_out >= 0),
    matched_to     VARCHAR(200),
    rule_note      VARCHAR(80),
    journal        VARCHAR(20),
    status         VARCHAR(10) NOT NULL DEFAULT 'No match' CHECK (status IN ('Auto', 'Suggested', 'Manual', 'No match')),
    suggest_payment UUID REFERENCES public.fee_payments(id) ON DELETE SET NULL,
    uploaded_on    DATE NOT NULL DEFAULT CURRENT_DATE
);
CREATE INDEX idx_bank_lines_school ON public.bank_statement_lines (institution_id, line_on DESC);

CREATE TABLE public.recon_rules (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    rule_key       VARCHAR(20) NOT NULL,
    enabled        BOOLEAN NOT NULL,
    PRIMARY KEY (institution_id, rule_key)
);
CREATE TABLE public.recon_exceptions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    ref_key        VARCHAR(80) NOT NULL,
    kind           VARCHAR(40) NOT NULL,
    detail         VARCHAR(300) NOT NULL,
    amount         INTEGER NOT NULL DEFAULT 0,
    student_id     UUID REFERENCES public.students(id) ON DELETE SET NULL,
    status         VARCHAR(8) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Cleared')),
    opened_on      DATE NOT NULL DEFAULT CURRENT_DATE,
    cleared_on     DATE,
    UNIQUE (institution_id, ref_key)
);
CREATE TABLE public.recon_audit (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    who            VARCHAR(120) NOT NULL DEFAULT 'System',
    action         VARCHAR(60) NOT NULL,
    item           VARCHAR(200) NOT NULL DEFAULT '',
    details        VARCHAR(300) NOT NULL DEFAULT '',
    journal        VARCHAR(20)
);
CREATE INDEX idx_recon_audit_school ON public.recon_audit (institution_id, at DESC);

CREATE TABLE public.fee_budgets (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    head           VARCHAR(80) NOT NULL,
    department     VARCHAR(40) NOT NULL DEFAULT '',
    annual         INTEGER NOT NULL CHECK (annual >= 0),
    revised        INTEGER CHECK (revised >= 0),
    UNIQUE (institution_id, head)
);
CREATE TABLE public.fee_cash_plan (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    month          CHAR(7) NOT NULL,
    other_in       INTEGER NOT NULL DEFAULT 0 CHECK (other_in >= 0),
    running        INTEGER NOT NULL DEFAULT 0 CHECK (running >= 0),
    capital        INTEGER NOT NULL DEFAULT 0 CHECK (capital >= 0),
    PRIMARY KEY (institution_id, month)
);
CREATE TABLE public.fee_cash_open (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    opening        BIGINT NOT NULL DEFAULT 0,
    as_of          DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE SEQUENCE public.staff_claim_seq START 312;
CREATE TABLE public.staff_claims (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL DEFAULT ('CL-' || nextval('public.staff_claim_seq')),
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    ctype          VARCHAR(20) NOT NULL,
    description    VARCHAR(200) NOT NULL DEFAULT '',
    claim_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    amount         INTEGER NOT NULL CHECK (amount > 0),
    receipts       INTEGER NOT NULL DEFAULT 0 CHECK (receipts >= 0),
    status         VARCHAR(14) NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted', 'HOD approved', 'Approved', 'Paid', 'Rejected')),
    paid_on        DATE
);
CREATE TABLE public.staff_advances (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    staff_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    purpose        VARCHAR(160) NOT NULL,
    given          INTEGER NOT NULL CHECK (given > 0),
    settle_by      DATE NOT NULL,
    settled        INTEGER NOT NULL DEFAULT 0 CHECK (settled >= 0)
);
CREATE TABLE public.claim_rules (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    ctype          VARCHAR(20) NOT NULL,
    limit_amount   INTEGER NOT NULL CHECK (limit_amount >= 0),
    per            VARCHAR(8) NOT NULL DEFAULT '',
    receipt_above  INTEGER NOT NULL DEFAULT 0 CHECK (receipt_above >= 0),
    approver       VARCHAR(30) NOT NULL,
    PRIMARY KEY (institution_id, ctype)
);

CREATE TABLE public.fee_reminder_actions (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    term           INTEGER NOT NULL,
    step_key       VARCHAR(10) NOT NULL,
    on_date        DATE NOT NULL,
    status         VARCHAR(6) NOT NULL CHECK (status IN ('Held', 'Sent')),
    channel        VARCHAR(40) NOT NULL DEFAULT '',
    amount         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (institution_id, student_id, term, step_key, on_date)
);

CREATE SEQUENCE public.hr_emp_seq START 1001;
CREATE TABLE public.hr_staff (
    profile_id     UUID PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    emp_code       VARCHAR(20) NOT NULL DEFAULT ('EMP-' || nextval('public.hr_emp_seq')),
    department     VARCHAR(60) NOT NULL DEFAULT '',
    staff_type     VARCHAR(12) NOT NULL DEFAULT 'Non-teaching' CHECK (staff_type IN ('Teaching', 'Non-teaching')),
    mobile         VARCHAR(30),
    joined_on      DATE,
    UNIQUE (institution_id, emp_code)
);

ALTER TABLE public.fee_settlements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_statement_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recon_rules           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recon_exceptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recon_audit           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_budgets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_cash_plan         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_cash_open         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_claims          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_advances        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_rules           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_reminder_actions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_staff              ENABLE ROW LEVEL SECURITY;
