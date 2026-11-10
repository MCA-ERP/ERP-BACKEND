-- ====================================================================
-- MIGRATION 011: REPORTS AND INTEGRATIONS
-- School GSTIN (for GST reports), partner API keys, outgoing webhooks.
-- ====================================================================

ALTER TABLE public.institutions ADD COLUMN IF NOT EXISTS gst_number VARCHAR(20);

-- Partner API keys. Only a SHA-256 hash of the key is stored; the key itself is shown once.
CREATE TABLE public.api_keys (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(120) NOT NULL,
    key_prefix  VARCHAR(16) NOT NULL,
    key_last4   VARCHAR(4) NOT NULL,
    key_hash    CHAR(64) UNIQUE NOT NULL,
    scopes      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status      VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    use_count   BIGINT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    created_by  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX idx_api_keys_status ON public.api_keys (status);

-- Outgoing webhooks: events the platform sends to other systems.
CREATE TABLE public.webhooks (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    url         TEXT NOT NULL,
    description VARCHAR(200),
    events      TEXT[] NOT NULL,
    secret      TEXT NOT NULL,                 -- signs every delivery (HMAC-SHA256)
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.webhook_deliveries (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    webhook_id   UUID NOT NULL REFERENCES public.webhooks(id) ON DELETE CASCADE,
    event        VARCHAR(60) NOT NULL,
    payload      JSONB NOT NULL,
    status_code  INTEGER,
    success      BOOLEAN NOT NULL,
    error        TEXT,
    duration_ms  INTEGER,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_webhook_deliveries ON public.webhook_deliveries (webhook_id, attempted_at DESC);

-- atomic usage counter for API keys
CREATE OR REPLACE FUNCTION public.touch_api_key(p_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE public.api_keys SET use_count = use_count + 1, last_used_at = NOW() WHERE id = p_id;
$$;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['api_keys', 'webhooks', 'webhook_deliveries']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION public.touch_api_key(UUID) FROM PUBLIC, anon, authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.touch_api_key(UUID) TO service_role;
    END IF;
END;
$$;
