-- ====================================================================
-- MIGRATION 009: PLATFORM OPERATIONS
-- platform_settings, ip_allowlist, support tickets, announcements and
-- templates, CMS content, and the platform staff roles/permissions.
-- ====================================================================

-- 1. Settings (key/value; validated by the API)
CREATE TABLE public.platform_settings (
    key        VARCHAR(80) PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.platform_settings (key, value) VALUES
    ('general.platform_name',      '"My Class Assist"'),
    ('general.support_email',      '"support@myclassassist.in"'),
    ('general.support_phone',      '""'),
    ('general.trial_days',         '14'),
    ('general.gst_number',         '""'),
    ('branding.logo_url',          '""'),
    ('branding.primary_color',     '"#0294CE"'),
    ('locale.timezone',            '"Asia/Kolkata"'),
    ('locale.currency',            '"INR"'),
    ('locale.date_format',         '"DD MMM YYYY"'),
    ('notify.email_from_name',     '"My Class Assist"'),
    ('notify.email_from_address',  '""'),
    ('notify.sms_sender_id',       '""'),
    ('security.min_password_length', '8'),
    ('security.session_timeout_minutes', '480'),
    ('security.require_2fa_staff', 'false'),
    ('security.max_failed_logins', '5');

-- 2. IP allowlist for the platform admin API (empty = no restriction)
CREATE TABLE public.ip_allowlist (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cidr       VARCHAR(64) NOT NULL UNIQUE,
    label      VARCHAR(150),
    created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Support tickets
CREATE SEQUENCE public.support_ticket_seq START 1001;

CREATE TABLE public.support_tickets (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code           VARCHAR(20) UNIQUE NOT NULL DEFAULT ('TKT-' || nextval('public.support_ticket_seq')),
    institution_id UUID REFERENCES public.institutions(id) ON DELETE CASCADE,
    subject        VARCHAR(255) NOT NULL,
    category       VARCHAR(50) NOT NULL DEFAULT 'General',
    priority       VARCHAR(10) NOT NULL DEFAULT 'Medium' CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
    status         VARCHAR(20) NOT NULL DEFAULT 'Open'
                   CHECK (status IN ('Open', 'In progress', 'Waiting on school', 'Resolved', 'Closed')),
    raised_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    raised_by_name VARCHAR(200),
    assigned_to    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at    TIMESTAMPTZ
);
CREATE INDEX idx_tickets_status ON public.support_tickets (status, created_at DESC);
CREATE INDEX idx_tickets_institution ON public.support_tickets (institution_id, created_at DESC);

CREATE TABLE public.ticket_messages (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id   UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
    author_id   UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    author_name VARCHAR(200) NOT NULL,
    body        TEXT NOT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE,   -- staff-only note, never shown to the school
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ticket_messages_ticket ON public.ticket_messages (ticket_id, created_at);

-- 4. Announcements and templates
CREATE TABLE public.announcements (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title      VARCHAR(255) NOT NULL,
    body       TEXT NOT NULL,
    audience   JSONB NOT NULL DEFAULT '{"type": "all"}',   -- {type: all|plans|schools, plans: [codes], school_ids: [uuid]}
    channels   TEXT[] NOT NULL DEFAULT ARRAY['in_app']::TEXT[],
    status     VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
    created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    sent_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.announcement_deliveries (
    announcement_id UUID NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
    institution_id  UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    delivered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (announcement_id, institution_id)
);
CREATE INDEX idx_deliveries_institution ON public.announcement_deliveries (institution_id, delivered_at DESC);

CREATE TABLE public.message_templates (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(150) UNIQUE NOT NULL,
    channel    VARCHAR(10) NOT NULL CHECK (channel IN ('in_app', 'email', 'sms', 'whatsapp')),
    subject    VARCHAR(255),
    body       TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. CMS content for the public website
CREATE TABLE public.cms_items (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type         VARCHAR(20) NOT NULL CHECK (type IN ('page', 'blog', 'banner', 'testimonial')),
    slug         VARCHAR(150) NOT NULL,
    title        VARCHAR(255) NOT NULL,
    body         TEXT NOT NULL DEFAULT '',
    data         JSONB NOT NULL DEFAULT '{}',       -- type-specific fields (image_url, link, author, school...)
    status       VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    sort_order   INTEGER NOT NULL DEFAULT 0,
    published_at TIMESTAMPTZ,
    created_by   UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_cms_type_slug UNIQUE (type, slug)
);

-- 6. updated_at triggers and RLS
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['support_tickets', 'announcements', 'message_templates', 'cms_items']
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I
             FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    END LOOP;

    FOREACH t IN ARRAY ARRAY['platform_settings', 'ip_allowlist', 'support_tickets', 'ticket_messages',
                             'announcements', 'announcement_deliveries', 'message_templates', 'cms_items']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END;
$$;

-- 7. Platform staff roles and their permissions
INSERT INTO public.roles (name, display_name, description, is_system_default) VALUES
    ('PlatformManager', 'Platform Manager', 'Runs day-to-day platform operations', TRUE),
    ('Finance',         'Finance',          'Subscriptions, payments and revenue reports', TRUE),
    ('SupportAgent',    'Support Agent',    'Handles school support tickets', TRUE),
    ('ContentEditor',   'Content Editor',   'Manages website content and announcements', TRUE)
ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name, description = EXCLUDED.description;

-- one permission per (area, action): platform.<area>.<view|create|edit|delete>
INSERT INTO public.permissions (code, module, description)
SELECT 'platform.' || a.area || '.' || x.action, 'platform',
       initcap(x.action) || ' access to ' || a.label
FROM (VALUES
    ('dashboard', 'the dashboard'), ('schools', 'school management'), ('subscriptions', 'subscriptions and plans'),
    ('modules', 'module management'), ('users', 'platform users'), ('roles', 'roles and permissions'),
    ('payments', 'payments'), ('support', 'support tickets'), ('reports', 'reports and analytics'),
    ('communication', 'communication'), ('cms', 'the website content'), ('integrations', 'integrations'),
    ('security', 'security and audit'), ('settings', 'system settings')
) AS a(area, label)
CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete')) AS x(action)
ON CONFLICT (code) DO NOTHING;

-- default grants (same presets as the product design)
WITH preset(role_name, area, actions) AS (VALUES
    ('PlatformManager', 'dashboard', 'vce'), ('PlatformManager', 'schools', 'vce'), ('PlatformManager', 'subscriptions', 'vce'),
    ('PlatformManager', 'modules', 'vce'), ('PlatformManager', 'users', 'vce'), ('PlatformManager', 'roles', 'v'),
    ('PlatformManager', 'payments', 'v'), ('PlatformManager', 'support', 'vce'), ('PlatformManager', 'reports', 'vce'),
    ('PlatformManager', 'communication', 'vce'), ('PlatformManager', 'cms', 'vce'), ('PlatformManager', 'integrations', 'vce'),
    ('PlatformManager', 'security', 'v'), ('PlatformManager', 'settings', 'v'),
    ('Finance', 'dashboard', 'v'), ('Finance', 'schools', 'v'), ('Finance', 'subscriptions', 'vce'),
    ('Finance', 'payments', 'vced'), ('Finance', 'reports', 'vc'),
    ('SupportAgent', 'dashboard', 'v'), ('SupportAgent', 'schools', 'v'), ('SupportAgent', 'users', 'v'),
    ('SupportAgent', 'support', 'vce'), ('SupportAgent', 'communication', 'vc'),
    ('ContentEditor', 'dashboard', 'v'), ('ContentEditor', 'cms', 'vced'), ('ContentEditor', 'communication', 'vc')
),
expanded AS (
    SELECT p.role_name, p.area,
           CASE a.ch WHEN 'v' THEN 'view' WHEN 'c' THEN 'create' WHEN 'e' THEN 'edit' ELSE 'delete' END AS action
    FROM preset p
    CROSS JOIN LATERAL regexp_split_to_table(p.actions, '') AS a(ch)
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, pm.id
FROM expanded e
JOIN public.roles r ON r.name = e.role_name
JOIN public.permissions pm ON pm.code = 'platform.' || e.area || '.' || e.action
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- starter templates
INSERT INTO public.message_templates (name, channel, subject, body) VALUES
    ('Welcome to My Class Assist', 'email', 'Welcome to My Class Assist',
     'Hello {{admin_name}}, your school {{school_name}} is ready. Sign in to start setting it up.'),
    ('Trial ending soon', 'email', 'Your trial ends on {{date}}',
     'Hello {{admin_name}}, the trial for {{school_name}} ends on {{date}}. Choose a plan to keep your data.'),
    ('Renewal reminder', 'sms', NULL,
     'My Class Assist: the subscription for {{school_name}} renews on {{date}}.')
ON CONFLICT (name) DO NOTHING;
