-- Finance: expenses, Tally mapping and export log, canteen wallet, alert rules, insight state, reminder schedule.
CREATE SEQUENCE public.fee_expense_seq START 54;
CREATE TABLE public.fee_expense_categories (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(80) NOT NULL,
    monthly_budget INTEGER NOT NULL DEFAULT 0 CHECK (monthly_budget >= 0),
    approver       VARCHAR(30) NOT NULL DEFAULT 'Accountant',
    status         VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
    UNIQUE (institution_id, name)
);
CREATE TABLE public.fee_expenses (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    voucher        VARCHAR(30) NOT NULL DEFAULT ('EXP-' || to_char(NOW(), 'YY') || '-' || lpad(nextval('public.fee_expense_seq')::text, 4, '0')),
    category_id    UUID REFERENCES public.fee_expense_categories(id) ON DELETE SET NULL,
    paid_to        VARCHAR(120) NOT NULL,
    amount         INTEGER NOT NULL CHECK (amount > 0),
    mode           VARCHAR(10) CHECK (mode IN ('Cash', 'UPI', 'Card', 'Cheque', 'Bank')),
    spent_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    raised_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    status         VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
    decided_on     DATE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, voucher)
);
CREATE INDEX idx_fee_expenses_school ON public.fee_expenses (institution_id, spent_on DESC);

CREATE TABLE public.fee_ledger_map (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    account        VARCHAR(80) NOT NULL,
    tally_ledger   VARCHAR(80) NOT NULL,
    tally_group    VARCHAR(40) NOT NULL,
    PRIMARY KEY (institution_id, account)
);
CREATE TABLE public.fee_tally_exports (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    exported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    from_date      DATE NOT NULL,
    to_date        DATE NOT NULL,
    types          VARCHAR(20) NOT NULL DEFAULT 'All',
    vouchers       INTEGER NOT NULL DEFAULT 0,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL
);
CREATE TABLE public.canteen_txns (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('Top-up', 'Purchase')),
    amount         INTEGER NOT NULL CHECK (amount > 0),
    txn_on         DATE NOT NULL DEFAULT CURRENT_DATE,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL
);
CREATE INDEX idx_canteen_txns_school ON public.canteen_txns (institution_id, txn_on DESC);
CREATE TABLE public.fee_alert_rules (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    rule_key       VARCHAR(20) NOT NULL,
    enabled        BOOLEAN NOT NULL,
    PRIMARY KEY (institution_id, rule_key)
);
CREATE TABLE public.fee_insight_state (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    insight_key    VARCHAR(100) NOT NULL,
    reviewed_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    PRIMARY KEY (institution_id, insight_key)
);
CREATE TABLE public.fee_reminder_config (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    steps          JSONB NOT NULL,
    rules          JSONB NOT NULL
);

ALTER TABLE public.fee_expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_expenses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_ledger_map         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_tally_exports      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canteen_txns           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_alert_rules        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_insight_state      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_reminder_config    ENABLE ROW LEVEL SECURITY;
