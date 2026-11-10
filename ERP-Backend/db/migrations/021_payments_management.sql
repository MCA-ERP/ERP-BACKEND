-- ====================================================================
-- MIGRATION 021: PAYMENTS MANAGEMENT
-- Refund requests that need a decision, failure details for online payment attempts,
-- and the settings for which payment methods are accepted and how GST is worked out.
-- ====================================================================

ALTER TABLE public.payment_orders
    ADD COLUMN IF NOT EXISTS gateway_payment_id VARCHAR(80),
    ADD COLUMN IF NOT EXISTS method             VARCHAR(30),
    ADD COLUMN IF NOT EXISTS failure_reason     TEXT,
    ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE public.refund_requests (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id     UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
    invoice_id     UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
    reason         TEXT NOT NULL,
    status         VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    requested_by   UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    requester_name VARCHAR(200),
    decided_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    decider_name   VARCHAR(200),
    decision_note  TEXT,
    decided_at     TIMESTAMPTZ,
    refund_id      UUID REFERENCES public.refunds(id) ON DELETE SET NULL,
    last_error     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refund_requests_status ON public.refund_requests (status, created_at DESC);
-- one open request per payment
CREATE UNIQUE INDEX uq_refund_request_pending ON public.refund_requests (payment_id) WHERE status = 'pending';
ALTER TABLE public.refund_requests ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_settings (key, value) VALUES
    ('payments.online_enabled', 'true'::jsonb),
    ('payments.manual_methods', '["UPI", "Card", "Net banking", "Bank transfer", "Cheque", "Cash", "Other"]'::jsonb),
    ('billing.supplier_state', '""'::jsonb),
    ('billing.sac_code', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;
