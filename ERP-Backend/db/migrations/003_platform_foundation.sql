-- ====================================================================
-- MIGRATION 003: PLATFORM FOUNDATION
-- updated_at triggers, institution settings, atomic per-tenant sequences,
-- tenant-aware audit logs.
-- ====================================================================

-- 1. Generic updated_at trigger function
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

-- 2. Institution columns (idempotent: early installs created the table without some of these)
ALTER TABLE public.institutions
    ADD COLUMN IF NOT EXISTS city VARCHAR(100),
    ADD COLUMN IF NOT EXISTS state VARCHAR(100),
    ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS plan VARCHAR(30) NOT NULL DEFAULT 'standard',
    ADD COLUMN IF NOT EXISTS enabled_modules TEXT[] NOT NULL DEFAULT ARRAY['sis', 'academics']::TEXT[],
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- 3. Users must be able to be forced to change a temporary password
ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- 4. Tenant-aware audit trail
ALTER TABLE public.audit_logs
    ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES public.institutions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_institution ON public.audit_logs(institution_id, created_at DESC);

-- 5. Attach updated_at triggers
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['institutions', 'campuses', 'user_profiles', 'students', 'student_profiles']
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I
             FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    END LOOP;
END;
$$;

-- 6. Atomic sequences per tenant (student numbers, admission numbers, receipts...)
--    next_sequence() takes a row lock, so concurrent callers never get the same value.
--    NOTE: it commits independently when called over RPC, so a later failure can leave a gap.
--    Gapless documents (fee receipts) must call it inside the same transaction as the insert.
CREATE TABLE IF NOT EXISTS public.id_sequences (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    kind           VARCHAR(30) NOT NULL,
    scope          VARCHAR(30) NOT NULL DEFAULT '',
    last_value     BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (institution_id, kind, scope)
);

CREATE OR REPLACE FUNCTION public.next_sequence(p_institution UUID, p_kind TEXT, p_scope TEXT DEFAULT '')
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    v BIGINT;
BEGIN
    INSERT INTO public.id_sequences AS s (institution_id, kind, scope, last_value)
    VALUES (p_institution, p_kind, p_scope, 1)
    ON CONFLICT (institution_id, kind, scope)
    DO UPDATE SET last_value = s.last_value + 1
    RETURNING s.last_value INTO v;

    RETURN v;
END;
$$;
