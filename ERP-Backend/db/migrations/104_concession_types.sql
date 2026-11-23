-- Concession types the school offers (Sibling 10%, Merit 25% ...). A concession request can name its type.
CREATE TABLE IF NOT EXISTS public.fee_concession_types (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name           VARCHAR(60) NOT NULL,
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('Percentage', 'Fixed')),
    value          INTEGER NOT NULL CHECK (value > 0),
    for_whom       VARCHAR(120) NOT NULL DEFAULT '',
    approved_by    VARCHAR(14) NOT NULL DEFAULT 'Principal' CHECK (approved_by IN ('Automatic', 'Accountant', 'Principal', 'School admin')),
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (institution_id, name)
);
ALTER TABLE public.fee_concession_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fee_concessions ADD COLUMN IF NOT EXISTS type_name VARCHAR(60);
