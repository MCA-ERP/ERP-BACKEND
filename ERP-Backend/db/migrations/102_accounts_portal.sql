-- Accounts (Fee & Finance) portal: tasks the accountant raises from an AI insight, and the revenue budget by fee type.

CREATE TABLE IF NOT EXISTS public.acc_tasks (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    owner_id       UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    title          VARCHAR(160) NOT NULL,
    detail         VARCHAR(500) NOT NULL DEFAULT '',
    source_key     VARCHAR(100),
    status         VARCHAR(8)   NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Done')),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, owner_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_acc_tasks_owner ON public.acc_tasks (institution_id, owner_id, status);

-- what the school expects to collect each year under each fee type (Tuition fees, Transport ...), for Revenue against budget
CREATE TABLE IF NOT EXISTS public.fee_revenue_budget (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    fee_type       VARCHAR(40) NOT NULL,
    annual         BIGINT NOT NULL DEFAULT 0 CHECK (annual >= 0),
    PRIMARY KEY (institution_id, fee_type)
);

ALTER TABLE public.acc_tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_revenue_budget  ENABLE ROW LEVEL SECURITY;
