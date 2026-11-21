-- Key/value school settings (one JSON document per group) and campus GSTIN / admin.
CREATE TABLE public.school_settings (institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE, key VARCHAR(30) NOT NULL, value JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (institution_id, key));
ALTER TABLE public.school_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campuses ADD COLUMN IF NOT EXISTS gstin VARCHAR(15), ADD COLUMN IF NOT EXISTS campus_admin VARCHAR(80);
