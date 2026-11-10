-- ====================================================================
-- MIGRATION 027: SECURITY & AUDIT
-- Blocked addresses, security incidents, and the settings behind the password policy,
-- two-factor scope, remembered devices, single session and data retention.
-- ====================================================================

CREATE TABLE public.ip_blocklist (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cidr       VARCHAR(50) UNIQUE NOT NULL,
    reason     VARCHAR(200),
    created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.security_incidents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seq         BIGINT GENERATED ALWAYS AS IDENTITY,
    title       VARCHAR(200) NOT NULL,
    severity    VARCHAR(10) NOT NULL CHECK (severity IN ('Low', 'Medium', 'High')),
    status      VARCHAR(15) NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Investigating', 'Mitigated', 'Resolved')),
    notes       TEXT NOT NULL DEFAULT '',
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    created_by  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_security_incidents_started ON public.security_incidents (started_at DESC);

ALTER TABLE public.ip_blocklist       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_incidents ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_settings (key, value) VALUES
    ('security.password_require_number',    'true'::jsonb),
    ('security.password_require_symbol',    'false'::jsonb),
    ('security.password_block_common',      'true'::jsonb),
    ('security.require_2fa_school_admins',  'false'::jsonb),
    ('security.remember_device_days',       '30'::jsonb),
    ('security.single_session_staff',       'false'::jsonb),
    ('retention.login_events_days',         '365'::jsonb),
    ('retention.audit_logs_days',           '1095'::jsonb)
ON CONFLICT (key) DO NOTHING;
