-- A numbered invoice for every student and instalment. Parents see it in the Parent portal (a notice is sent when it is generated).
CREATE TABLE IF NOT EXISTS public.fee_invoices (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    number         VARCHAR(24) NOT NULL,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    term           INTEGER NOT NULL CHECK (term BETWEEN 1 AND 12),
    invoice_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date       DATE NOT NULL,
    amount         INTEGER NOT NULL CHECK (amount >= 0),
    sent_at        TIMESTAMPTZ,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, student_id, term),
    UNIQUE (institution_id, number)
);
CREATE INDEX IF NOT EXISTS idx_fee_invoices_term ON public.fee_invoices (institution_id, term);
ALTER TABLE public.fee_invoices ENABLE ROW LEVEL SECURITY;
