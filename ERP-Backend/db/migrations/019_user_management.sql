-- ====================================================================
-- MIGRATION 019: USER MANAGEMENT
-- Sign-in history, account lockout after repeated wrong passwords, and a record of
-- active sessions that can be ended from the admin portal.
-- ====================================================================

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_failed_at     TIMESTAMPTZ;

-- every sign-in attempt, successful or not (the email is kept even when no account matches)
CREATE TABLE public.login_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(320) NOT NULL,
    user_profile_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    institution_id  UUID REFERENCES public.institutions(id) ON DELETE SET NULL,
    success         BOOLEAN NOT NULL,
    reason          VARCHAR(30) NOT NULL
        CHECK (reason IN ('ok', 'bad_password', 'locked', 'suspended', 'school_inactive', 'no_profile', 'unknown_email', 'sign_out')),
    ip_address      VARCHAR(60),
    user_agent      VARCHAR(300),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_login_events_created ON public.login_events (created_at DESC);
CREATE INDEX idx_login_events_email   ON public.login_events (email, created_at DESC);
CREATE INDEX idx_login_events_failed  ON public.login_events (created_at DESC) WHERE NOT success;

-- sessions started through the backend sign-in; "session_id" is the identity provider's id inside the access token
CREATE TABLE public.user_sessions (
    session_id      UUID PRIMARY KEY,
    user_profile_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    ip_address      VARCHAR(60),
    user_agent      VARCHAR(300),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ,
    revoked_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL
);
CREATE INDEX idx_user_sessions_user   ON public.user_sessions (user_profile_id, created_at DESC);
CREATE INDEX idx_user_sessions_active ON public.user_sessions (last_seen_at DESC) WHERE revoked_at IS NULL;

ALTER TABLE public.login_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_settings (key, value) VALUES
    ('security.lockout_minutes', '15'::jsonb),
    ('accounts.student_login_domain', '"students.myclassassist.in"'::jsonb),
    ('accounts.parent_login_domain', '"parents.myclassassist.in"'::jsonb)
ON CONFLICT (key) DO NOTHING;
