-- ====================================================================
-- MIGRATION 010: PLATFORM BILLING
-- Invoices (gapless numbering per financial year), payments, refunds and
-- gateway orders. All money is stored as integer paise. Every state change
-- goes through a SQL function so it is atomic and race-free.
-- ====================================================================

-- 1. Tables ----------------------------------------------------------
CREATE TABLE public.billing_counters (
    fy         VARCHAR(7) PRIMARY KEY,           -- financial year, e.g. 2026-27
    last_value INTEGER NOT NULL DEFAULT 0
);

CREATE SEQUENCE public.payment_seq START 88001;

CREATE TABLE public.invoices (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    number           VARCHAR(30) UNIQUE NOT NULL,   -- INV/2026-27/0001
    institution_id   UUID NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
    description      VARCHAR(255) NOT NULL,
    period_start     DATE,
    period_end       DATE,
    issue_date       DATE NOT NULL DEFAULT CURRENT_DATE,
    due_on           DATE NOT NULL,
    subtotal_paise   BIGINT NOT NULL CHECK (subtotal_paise >= 0),
    gst_rate_percent NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (gst_rate_percent >= 0),
    tax_paise        BIGINT NOT NULL CHECK (tax_paise >= 0),
    total_paise      BIGINT NOT NULL CHECK (total_paise >= 0),
    status           VARCHAR(10) NOT NULL DEFAULT 'Issued' CHECK (status IN ('Issued', 'Paid', 'Void')),
    void_reason      TEXT,
    created_by       UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_invoices_institution ON public.invoices (institution_id, issue_date DESC);
CREATE INDEX idx_invoices_status_due ON public.invoices (status, due_on);

CREATE TABLE public.invoice_lines (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id       UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    description      VARCHAR(255) NOT NULL,
    quantity         INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_paise BIGINT NOT NULL CHECK (unit_price_paise >= 0),
    amount_paise     BIGINT NOT NULL CHECK (amount_paise >= 0)
);
CREATE INDEX idx_invoice_lines_invoice ON public.invoice_lines (invoice_id);

CREATE TABLE public.payments (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code               VARCHAR(20) UNIQUE NOT NULL DEFAULT ('PAY-' || nextval('public.payment_seq')),
    invoice_id         UUID NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
    institution_id     UUID NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
    amount_paise       BIGINT NOT NULL CHECK (amount_paise > 0),
    method             VARCHAR(20) NOT NULL
                       CHECK (method IN ('UPI', 'Card', 'Net banking', 'Bank transfer', 'Cheque', 'Cash', 'Online', 'Other')),
    gateway            VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (gateway IN ('manual', 'razorpay')),
    gateway_order_id   VARCHAR(80),
    gateway_payment_id VARCHAR(80) UNIQUE,
    reference          VARCHAR(120),
    paid_on            DATE NOT NULL DEFAULT CURRENT_DATE,
    notes              TEXT,
    recorded_by        UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payments_invoice ON public.payments (invoice_id);
CREATE INDEX idx_payments_paid_on ON public.payments (paid_on DESC);

CREATE TABLE public.refunds (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id        UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
    amount_paise      BIGINT NOT NULL CHECK (amount_paise > 0),
    reason            TEXT NOT NULL,
    gateway_refund_id VARCHAR(80),
    created_by        UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refunds_payment ON public.refunds (payment_id);

-- one row per gateway order a school started; the webhook and the browser callback both settle it
CREATE TABLE public.payment_orders (
    order_id       VARCHAR(80) PRIMARY KEY,
    invoice_id     UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
    status         VARCHAR(10) NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payment_orders_invoice ON public.payment_orders (invoice_id);

CREATE TABLE public.gateway_events (
    id          VARCHAR(120) PRIMARY KEY,
    type        VARCHAR(60) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON public.invoices
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['billing_counters', 'invoices', 'invoice_lines', 'payments', 'refunds', 'payment_orders', 'gateway_events']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END;
$$;

-- 2. Settings --------------------------------------------------------
INSERT INTO public.platform_settings (key, value) VALUES
    ('billing.gst_rate_percent',   '18'),
    ('billing.payment_terms_days', '15')
ON CONFLICT (key) DO NOTHING;

-- 3. Atomic operations -----------------------------------------------
CREATE OR REPLACE FUNCTION public.net_paid(p_invoice UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE((SELECT SUM(amount_paise) FROM public.payments WHERE invoice_id = p_invoice), 0)
         - COALESCE((SELECT SUM(r.amount_paise) FROM public.refunds r JOIN public.payments p ON p.id = r.payment_id WHERE p.invoice_id = p_invoice), 0);
$$;

CREATE OR REPLACE FUNCTION public.create_invoice(
    p_institution UUID, p_description TEXT, p_lines JSONB, p_due_on DATE,
    p_period_start DATE, p_period_end DATE, p_gst_rate NUMERIC, p_created_by UUID
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_subtotal BIGINT := 0;
    v_tax BIGINT;
    v_fy TEXT;
    v_n INTEGER;
    v_id UUID;
    v_line JSONB;
    v_year INTEGER := EXTRACT(YEAR FROM CURRENT_DATE);
BEGIN
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
        RAISE EXCEPTION 'An invoice needs at least one line.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.institutions WHERE id = p_institution) THEN
        RAISE EXCEPTION 'School not found.';
    END IF;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        IF (v_line ->> 'quantity')::INTEGER <= 0 OR (v_line ->> 'unit_price_paise')::BIGINT < 0 THEN
            RAISE EXCEPTION 'Each line needs a positive quantity and a price of zero or more.';
        END IF;
        v_subtotal := v_subtotal + (v_line ->> 'quantity')::INTEGER * (v_line ->> 'unit_price_paise')::BIGINT;
    END LOOP;
    v_tax := ROUND(v_subtotal * p_gst_rate / 100.0);

    -- financial year runs April to March
    IF EXTRACT(MONTH FROM CURRENT_DATE) >= 4 THEN
        v_fy := v_year || '-' || RIGHT((v_year + 1)::TEXT, 2);
    ELSE
        v_fy := (v_year - 1) || '-' || RIGHT(v_year::TEXT, 2);
    END IF;

    INSERT INTO public.billing_counters AS c (fy, last_value) VALUES (v_fy, 1)
    ON CONFLICT (fy) DO UPDATE SET last_value = c.last_value + 1
    RETURNING c.last_value INTO v_n;

    INSERT INTO public.invoices (number, institution_id, description, period_start, period_end, due_on,
                                 subtotal_paise, gst_rate_percent, tax_paise, total_paise, created_by)
    VALUES ('INV/' || v_fy || '/' || LPAD(v_n::TEXT, 4, '0'), p_institution, p_description, p_period_start, p_period_end, p_due_on,
            v_subtotal, p_gst_rate, v_tax, v_subtotal + v_tax, p_created_by)
    RETURNING id INTO v_id;

    INSERT INTO public.invoice_lines (invoice_id, description, quantity, unit_price_paise, amount_paise)
    SELECT v_id, l ->> 'description', (l ->> 'quantity')::INTEGER, (l ->> 'unit_price_paise')::BIGINT,
           (l ->> 'quantity')::INTEGER * (l ->> 'unit_price_paise')::BIGINT
    FROM jsonb_array_elements(p_lines) AS l;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_payment(
    p_invoice UUID, p_amount BIGINT, p_method TEXT, p_gateway TEXT, p_gateway_order_id TEXT,
    p_gateway_payment_id TEXT, p_reference TEXT, p_paid_on DATE, p_notes TEXT, p_by UUID
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_inv public.invoices%ROWTYPE;
    v_existing UUID;
    v_balance BIGINT;
    v_id UUID;
BEGIN
    IF p_gateway_payment_id IS NOT NULL THEN
        SELECT id INTO v_existing FROM public.payments WHERE gateway_payment_id = p_gateway_payment_id;
        IF FOUND THEN RETURN v_existing; END IF;   -- webhook and browser callback may both arrive
    END IF;

    SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found.'; END IF;
    IF v_inv.status = 'Void' THEN RAISE EXCEPTION 'This invoice is void.'; END IF;
    IF p_amount <= 0 THEN RAISE EXCEPTION 'The amount must be greater than zero.'; END IF;

    v_balance := v_inv.total_paise - public.net_paid(p_invoice);
    IF p_amount > v_balance THEN
        RAISE EXCEPTION 'The amount is more than the balance due (% paise).', v_balance;
    END IF;

    INSERT INTO public.payments (invoice_id, institution_id, amount_paise, method, gateway, gateway_order_id,
                                 gateway_payment_id, reference, paid_on, notes, recorded_by)
    VALUES (p_invoice, v_inv.institution_id, p_amount, p_method, p_gateway, p_gateway_order_id,
            p_gateway_payment_id, p_reference, COALESCE(p_paid_on, CURRENT_DATE), p_notes, p_by)
    RETURNING id INTO v_id;

    IF public.net_paid(p_invoice) >= v_inv.total_paise THEN
        UPDATE public.invoices SET status = 'Paid' WHERE id = p_invoice;
    END IF;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_payment(
    p_payment UUID, p_amount BIGINT, p_reason TEXT, p_gateway_refund_id TEXT, p_by UUID
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_pay public.payments%ROWTYPE;
    v_refunded BIGINT;
    v_id UUID;
    v_total BIGINT;
BEGIN
    SELECT * INTO v_pay FROM public.payments WHERE id = p_payment;
    IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found.'; END IF;
    PERFORM 1 FROM public.invoices WHERE id = v_pay.invoice_id FOR UPDATE;

    IF p_amount <= 0 THEN RAISE EXCEPTION 'The amount must be greater than zero.'; END IF;
    IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required.'; END IF;

    SELECT COALESCE(SUM(amount_paise), 0) INTO v_refunded FROM public.refunds WHERE payment_id = p_payment;
    IF p_amount > v_pay.amount_paise - v_refunded THEN
        RAISE EXCEPTION 'Only % paise of this payment can still be refunded.', v_pay.amount_paise - v_refunded;
    END IF;

    INSERT INTO public.refunds (payment_id, amount_paise, reason, gateway_refund_id, created_by)
    VALUES (p_payment, p_amount, p_reason, p_gateway_refund_id, p_by)
    RETURNING id INTO v_id;

    SELECT total_paise INTO v_total FROM public.invoices WHERE id = v_pay.invoice_id;
    IF public.net_paid(v_pay.invoice_id) < v_total THEN
        UPDATE public.invoices SET status = 'Issued' WHERE id = v_pay.invoice_id AND status = 'Paid';
    END IF;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_invoice(p_invoice UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_inv public.invoices%ROWTYPE;
BEGIN
    SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found.'; END IF;
    IF v_inv.status = 'Void' THEN RAISE EXCEPTION 'This invoice is already void.'; END IF;
    IF public.net_paid(p_invoice) > 0 THEN RAISE EXCEPTION 'Refund the payments on this invoice before voiding it.'; END IF;
    IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) = 0 THEN RAISE EXCEPTION 'A reason is required.'; END IF;
    UPDATE public.invoices SET status = 'Void', void_reason = p_reason WHERE id = p_invoice;
END;
$$;

-- 4. Read model ------------------------------------------------------
CREATE OR REPLACE VIEW public.platform_invoice_overview AS
SELECT i.id, i.number, i.institution_id, ins.name AS school_name, ins.code AS school_code,
       i.description, i.period_start, i.period_end, i.issue_date, i.due_on,
       i.subtotal_paise, i.gst_rate_percent, i.tax_paise, i.total_paise, i.void_reason,
       np.paid_paise,
       (i.total_paise - np.paid_paise) AS balance_paise,
       CASE
           WHEN i.status = 'Void' THEN 'Void'
           WHEN i.status = 'Paid' THEN 'Paid'
           WHEN i.due_on < CURRENT_DATE THEN 'Overdue'
           WHEN np.paid_paise > 0 THEN 'Partially paid'
           ELSE 'Issued'
       END AS status,
       i.created_at
FROM public.invoices i
JOIN public.institutions ins ON ins.id = i.institution_id
CROSS JOIN LATERAL (SELECT public.net_paid(i.id) AS paid_paise) np;

-- 5. Lock the functions and view away from the public API keys ---------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION public.net_paid(UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION public.create_invoice(UUID, TEXT, JSONB, DATE, DATE, DATE, NUMERIC, UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION public.record_payment(UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION public.refund_payment(UUID, BIGINT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON FUNCTION public.void_invoice(UUID, TEXT) FROM PUBLIC, anon, authenticated;
        REVOKE ALL ON public.platform_invoice_overview FROM PUBLIC, anon, authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.net_paid(UUID) TO service_role;
        GRANT EXECUTE ON FUNCTION public.create_invoice(UUID, TEXT, JSONB, DATE, DATE, DATE, NUMERIC, UUID) TO service_role;
        GRANT EXECUTE ON FUNCTION public.record_payment(UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, UUID) TO service_role;
        GRANT EXECUTE ON FUNCTION public.refund_payment(UUID, BIGINT, TEXT, TEXT, UUID) TO service_role;
        GRANT EXECUTE ON FUNCTION public.void_invoice(UUID, TEXT) TO service_role;
        GRANT SELECT ON public.platform_invoice_overview TO service_role;
    END IF;
END;
$$;
