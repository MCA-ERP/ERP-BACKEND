-- ====================================================================
-- MIGRATION 007: SCHOOL LIFECYCLE, PLANS AND SUBSCRIPTIONS
-- institutions.status becomes the single source of truth for whether a
-- school may use the platform; is_active is derived from it by a trigger.
-- Plans carry a per-student yearly price; subscriptions record which plan
-- a school is on (history kept, exactly one current row per school).
-- ====================================================================

-- 1. Plans
CREATE TABLE public.plans (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                    VARCHAR(30) UNIQUE NOT NULL,
    name                    VARCHAR(100) NOT NULL,
    price_per_student_paise INTEGER NOT NULL CHECK (price_per_student_paise >= 0),
    student_limit           INTEGER CHECK (student_limit IS NULL OR student_limit > 0),
    sort_order              INTEGER NOT NULL DEFAULT 0,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.plans (code, name, price_per_student_paise, student_limit, sort_order) VALUES
    ('basic',      'Basic',      24900,  500,  1),
    ('standard',   'Standard',   44900,  1500, 2),
    ('premium',    'Premium',    69900,  2500, 3),
    ('enterprise', 'Enterprise', 89900,  NULL, 4);

-- 2. School lifecycle on institutions
ALTER TABLE public.institutions
    ADD COLUMN IF NOT EXISTS board VARCHAR(50),
    ADD COLUMN IF NOT EXISTS contact_name VARCHAR(150),
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'Pending';

ALTER TABLE public.institutions
    ADD CONSTRAINT chk_institution_status
    CHECK (status IN ('Pending', 'Trial', 'Active', 'Overdue', 'Suspended', 'Expired'));

-- carry over what is_active already said
UPDATE public.institutions SET status = CASE WHEN is_active THEN 'Active' ELSE 'Suspended' END;

CREATE OR REPLACE FUNCTION public.sync_institution_active()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.is_active := NEW.status IN ('Trial', 'Active', 'Overdue');
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_institutions_sync_active
    BEFORE INSERT OR UPDATE OF status, is_active ON public.institutions
    FOR EACH ROW EXECUTE FUNCTION public.sync_institution_active();

UPDATE public.institutions SET status = status;
CREATE INDEX idx_institutions_status ON public.institutions (status);

-- the free-text plan column from 003 is replaced by real subscriptions
ALTER TABLE public.institutions DROP COLUMN IF EXISTS plan;

-- 3. Subscriptions (history; one current row per school)
CREATE TABLE public.subscriptions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    plan_id        UUID NOT NULL REFERENCES public.plans(id) ON DELETE RESTRICT,
    billing_cycle  VARCHAR(10) NOT NULL DEFAULT 'annual' CHECK (billing_cycle IN ('annual', 'quarterly')),
    started_on     DATE NOT NULL DEFAULT CURRENT_DATE,
    renews_on      DATE,
    trial_ends_on  DATE,
    ended_on       DATE,
    is_current     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_one_current_subscription ON public.subscriptions (institution_id) WHERE is_current;
CREATE INDEX idx_subscriptions_renews ON public.subscriptions (renews_on) WHERE is_current;

-- schools that already exist get the Standard plan
INSERT INTO public.subscriptions (institution_id, plan_id, renews_on, trial_ends_on)
SELECT i.id,
       (SELECT id FROM public.plans WHERE code = 'standard'),
       CASE WHEN i.status = 'Active' THEN CURRENT_DATE + 365 END,
       CASE WHEN i.status = 'Trial'  THEN CURRENT_DATE + 14 END
FROM public.institutions i;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['plans', 'subscriptions']
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I
             FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END;
$$;

-- 4. Read models for the platform dashboard (service role only)
CREATE OR REPLACE VIEW public.platform_school_overview AS
SELECT i.id, i.code, i.name, i.type, i.board, i.city, i.state, i.status,
       i.contact_name, i.contact_email, i.contact_phone, i.created_at,
       p.code AS plan_code, p.name AS plan_name, p.price_per_student_paise,
       s.renews_on, s.trial_ends_on,
       COALESCE(st.n, 0)::INT AS students,
       (COALESCE(st.n, 0)::BIGINT * COALESCE(p.price_per_student_paise, 0))::BIGINT AS arr_paise
FROM public.institutions i
LEFT JOIN public.subscriptions s ON s.institution_id = i.id AND s.is_current
LEFT JOIN public.plans p ON p.id = s.plan_id
LEFT JOIN (
    SELECT institution_id, COUNT(*) AS n
    FROM public.students
    WHERE deleted_at IS NULL AND status = 'Enrolled'
    GROUP BY institution_id
) st ON st.institution_id = i.id
WHERE i.deleted_at IS NULL;

CREATE OR REPLACE VIEW public.platform_user_counts AS
SELECT up.institution_id, r.name AS role, COUNT(*)::INT AS n
FROM public.user_profiles up
JOIN public.roles r ON r.id = up.role_id
WHERE up.status = 'active'
GROUP BY up.institution_id, r.name;

-- views bypass RLS of their owner, so lock them away from the public API keys
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.platform_school_overview, public.platform_user_counts FROM PUBLIC, anon, authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT SELECT ON public.platform_school_overview, public.platform_user_counts TO service_role;
    END IF;
END;
$$;
