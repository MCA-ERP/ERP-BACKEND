-- Books of account: the chart of accounts, manual journal entries, and which bank entries have shown up on the statement.
-- Receipts, fines, refunds, expenses and claims post to the books from their own records; only manual entries are stored here.
CREATE TABLE IF NOT EXISTS public.acc_accounts (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(8)  NOT NULL,
    name           VARCHAR(80) NOT NULL,
    grp            VARCHAR(12) NOT NULL CHECK (grp IN ('Assets', 'Liabilities', 'Fund', 'Income', 'Expenses')),
    opening        BIGINT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, code)
);
CREATE TABLE IF NOT EXISTS public.acc_journal (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    voucher        VARCHAR(12) NOT NULL,
    entry_date     DATE NOT NULL,
    narration      VARCHAR(200) NOT NULL,
    amount         BIGINT NOT NULL CHECK (amount > 0),
    debit_code     VARCHAR(8) NOT NULL,
    credit_code    VARCHAR(8) NOT NULL,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, voucher)
);
CREATE TABLE IF NOT EXISTS public.acc_bank_marks (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    voucher        VARCHAR(40) NOT NULL,
    marked_on      DATE NOT NULL DEFAULT CURRENT_DATE,
    marked_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    PRIMARY KEY (institution_id, voucher)
);
ALTER TABLE public.acc_accounts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acc_journal    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acc_bank_marks ENABLE ROW LEVEL SECURITY;
