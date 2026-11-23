-- Suppliers the school pays, with the expense head each one usually goes to.
CREATE TABLE IF NOT EXISTS public.fee_vendors (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code           VARCHAR(12) NOT NULL,
    name           VARCHAR(120) NOT NULL,
    supplies       VARCHAR(120) NOT NULL DEFAULT '',
    category_id    UUID REFERENCES public.fee_expense_categories(id) ON DELETE SET NULL,
    gstin          VARCHAR(15),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, code),
    UNIQUE (institution_id, name)
);
ALTER TABLE public.fee_vendors ENABLE ROW LEVEL SECURITY;
