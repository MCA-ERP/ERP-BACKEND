-- ====================================================================
-- MIGRATION 017: SUBSCRIPTION MANAGEMENT
-- Plan limits, coupons, automatic offers, special pricing per school,
-- plan-change requests, cancellation, and renewals that happen by themselves
-- when a renewal invoice is paid.
-- ====================================================================

ALTER TABLE public.plans
    ADD COLUMN IF NOT EXISTS description  TEXT,
    ADD COLUMN IF NOT EXISTS staff_limit  INTEGER CHECK (staff_limit  IS NULL OR staff_limit  > 0),
    ADD COLUMN IF NOT EXISTS campus_limit INTEGER CHECK (campus_limit IS NULL OR campus_limit > 0),
    ADD COLUMN IF NOT EXISTS storage_gb   INTEGER CHECK (storage_gb   IS NULL OR storage_gb   > 0),
    ADD COLUMN IF NOT EXISTS trial_days   INTEGER CHECK (trial_days   IS NULL OR trial_days BETWEEN 0 AND 90);

UPDATE public.plans SET staff_limit = CASE code WHEN 'basic' THEN 40 WHEN 'standard' THEN 120 WHEN 'premium' THEN 300 END,
                        campus_limit = CASE code WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'premium' THEN 5 END,
                        storage_gb = CASE code WHEN 'basic' THEN 10 WHEN 'standard' THEN 50 WHEN 'premium' THEN 200 WHEN 'enterprise' THEN 1000 END
WHERE staff_limit IS NULL AND campus_limit IS NULL AND storage_gb IS NULL;

ALTER TABLE public.subscriptions
    ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- codes schools enter at checkout
CREATE TABLE public.coupons (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code             VARCHAR(40) UNIQUE NOT NULL,
    description      VARCHAR(255),
    kind             VARCHAR(12) NOT NULL CHECK (kind IN ('percent', 'per_student')),
    value            INTEGER NOT NULL CHECK (value > 0),       -- percent (1-100) or paise off each student
    plan_codes       TEXT[] NOT NULL DEFAULT '{}',             -- empty = every plan
    valid_from       DATE,
    valid_until      DATE,
    max_redemptions  INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
    redeemed_count   INTEGER NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_coupon_percent CHECK (kind <> 'percent' OR value <= 100)
);

CREATE TABLE public.coupon_redemptions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    coupon_id      UUID NOT NULL REFERENCES public.coupons(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    invoice_id     UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (coupon_id, invoice_id)
);

-- discounts that apply without a code
CREATE TABLE public.offers (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          VARCHAR(120) NOT NULL,
    percent_off   INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
    plan_codes    TEXT[] NOT NULL DEFAULT '{}',
    min_students  INTEGER CHECK (min_students IS NULL OR min_students > 0),
    valid_from    DATE,
    valid_until   DATE,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- a negotiated price for one school (replaces the plan price while valid)
CREATE TABLE public.school_pricing (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id          UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    price_per_student_paise INTEGER NOT NULL CHECK (price_per_student_paise >= 0),
    valid_from              DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until             DATE,
    reason                  VARCHAR(255) NOT NULL,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    created_by              UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_school_pricing_inst ON public.school_pricing (institution_id) WHERE is_active;

-- schools asking to move to another plan
CREATE TABLE public.subscription_requests (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    from_plan_id   UUID REFERENCES public.plans(id) ON DELETE SET NULL,
    to_plan_id     UUID NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
    kind           VARCHAR(10) NOT NULL CHECK (kind IN ('upgrade', 'downgrade')),
    status         VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    note           TEXT,
    decision_note  TEXT,
    requested_by   UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    decided_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    decided_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sub_requests_status ON public.subscription_requests (status, created_at DESC);
-- one open request per school
CREATE UNIQUE INDEX uq_sub_request_pending ON public.subscription_requests (institution_id) WHERE status = 'pending';

-- a renewal invoice remembers which subscription it renews
ALTER TABLE public.invoices
    ADD COLUMN IF NOT EXISTS renews_subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS renewal_applied_at     TIMESTAMPTZ;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['coupons', 'offers', 'school_pricing']
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I
             FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['coupons', 'coupon_redemptions', 'offers', 'school_pricing', 'subscription_requests']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END;
$$;

-- When a renewal invoice becomes fully paid: move the renewal date forward, end the trial,
-- bring a lapsed school back to Active, and record it in the school's history. Runs once per invoice.
CREATE OR REPLACE FUNCTION public.apply_renewal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_sub  public.subscriptions%ROWTYPE;
    v_next DATE;
BEGIN
    IF NEW.status <> 'Paid' OR OLD.status = 'Paid' OR NEW.renews_subscription_id IS NULL OR NEW.renewal_applied_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_sub FROM public.subscriptions WHERE id = NEW.renews_subscription_id FOR UPDATE;
    IF NOT FOUND OR NOT v_sub.is_current THEN
        RETURN NEW;
    END IF;

    v_next := COALESCE(NEW.period_end + 1, CURRENT_DATE + 365);
    UPDATE public.subscriptions
       SET renews_on = GREATEST(COALESCE(renews_on, v_next), v_next), trial_ends_on = NULL
     WHERE id = v_sub.id;

    UPDATE public.institutions SET status = 'Active'
     WHERE id = NEW.institution_id AND status IN ('Trial', 'Overdue', 'Expired');

    NEW.renewal_applied_at := NOW();

    INSERT INTO public.school_events (institution_id, type, summary, new_data)
    VALUES (NEW.institution_id, 'renewed', 'Subscription renewed until ' || to_char(v_next, 'DD Mon YYYY') || ' (invoice ' || NEW.number || ')',
            jsonb_build_object('renews_on', v_next, 'invoice', NEW.number));
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoices_apply_renewal
    BEFORE UPDATE OF status ON public.invoices
    FOR EACH ROW EXECUTE FUNCTION public.apply_renewal();

INSERT INTO public.platform_settings (key, value) VALUES
    ('billing.grace_days', '15'::jsonb),
    ('billing.default_cycle', '"annual"'::jsonb),
    ('billing.invoice_footer', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;
