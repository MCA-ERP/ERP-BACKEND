-- ====================================================================
-- MIGRATION 023: SIGN-IN CODES (SECOND STEP AFTER THE PASSWORD)
-- A 6-digit code is sent to the person's mobile number (or email if SMS is not set up),
-- and entered after the password. Devices can be trusted for 30 days.
-- ====================================================================

ALTER TABLE public.login_events DROP CONSTRAINT IF EXISTS login_events_reason_check;
ALTER TABLE public.login_events
    ADD CONSTRAINT login_events_reason_check
    CHECK (reason IN ('ok', 'bad_password', 'locked', 'suspended', 'school_inactive', 'no_profile', 'unknown_email', 'sign_out', 'code_sent', 'code_failed'));

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS otp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- one row per code sent; the code itself is never stored, only a keyed hash of it
CREATE TABLE public.login_challenges (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id   UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    code_hash    VARCHAR(64) NOT NULL,
    channel      VARCHAR(10) NOT NULL CHECK (channel IN ('sms', 'email', 'console')),
    sent_to      VARCHAR(120),
    attempts     INTEGER NOT NULL DEFAULT 0,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    ip_address   VARCHAR(60),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_login_challenges_profile ON public.login_challenges (profile_id, created_at DESC);

-- devices that skip the code for 30 days; only a hash of the device token is kept
CREATE TABLE public.trusted_devices (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    profile_id   UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    token_hash   VARCHAR(64) UNIQUE NOT NULL,
    label        VARCHAR(200),
    expires_at   TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_trusted_devices_profile ON public.trusted_devices (profile_id);

ALTER TABLE public.login_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trusted_devices  ENABLE ROW LEVEL SECURITY;

-- the SMS text; it needs its approved template id from MSG91 before it can be used
INSERT INTO public.message_templates (name, channel, key, subject, body) VALUES
    ('Sign-in code (SMS)', 'sms', 'login_otp', NULL, '{{platform_name}}: your sign-in code is {{otp}}. It expires in 10 minutes. Do not share it with anyone.')
ON CONFLICT (name) DO NOTHING;
