-- ====================================================================
-- MIGRATION 012: EMAIL AND SMS DELIVERY
-- message_log records every message the platform sends (or fails to send).
-- message_templates gains a stable key per system message, and the id of the
-- approved SMS template at the SMS provider (India requires DLT-approved text).
-- ====================================================================

ALTER TABLE public.message_templates
    ADD COLUMN IF NOT EXISTS key VARCHAR(60),
    ADD COLUMN IF NOT EXISTS provider_template_id VARCHAR(80);

-- one system template per (key, channel); custom templates have no key
CREATE UNIQUE INDEX uq_template_key_channel ON public.message_templates (key, channel) WHERE key IS NOT NULL;

CREATE TABLE public.message_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel             VARCHAR(10) NOT NULL CHECK (channel IN ('email', 'sms')),
    to_address          VARCHAR(320) NOT NULL,
    subject             VARCHAR(255),
    body                TEXT NOT NULL,
    status              VARCHAR(10) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
    error               TEXT,
    provider_message_id VARCHAR(200),
    institution_id      UUID REFERENCES public.institutions(id) ON DELETE SET NULL,
    related_type        VARCHAR(30),             -- announcement, invoice, ticket, school, reminder, test
    related_id          VARCHAR(80),
    dedupe_key          VARCHAR(200) UNIQUE,     -- makes reminders safe to run twice
    attempts            INTEGER NOT NULL DEFAULT 0,
    created_by          UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at             TIMESTAMPTZ
);
CREATE INDEX idx_message_log_created ON public.message_log (created_at DESC);
CREATE INDEX idx_message_log_status ON public.message_log (status, created_at DESC);
CREATE INDEX idx_message_log_related ON public.message_log (related_type, related_id);

ALTER TABLE public.message_log ENABLE ROW LEVEL SECURITY;

-- system messages. The three seeded in 009 get keys; the rest are new.
UPDATE public.message_templates SET key = 'welcome',           subject = 'Welcome to {{platform_name}}'        WHERE name = 'Welcome to My Class Assist' AND channel = 'email';
UPDATE public.message_templates SET key = 'trial_ending'                                                       WHERE name = 'Trial ending soon'          AND channel = 'email';
UPDATE public.message_templates SET key = 'renewal_reminder'                                                   WHERE name = 'Renewal reminder'           AND channel = 'sms';

INSERT INTO public.message_templates (name, channel, key, subject, body) VALUES
    ('Renewal reminder (email)', 'email', 'renewal_reminder', 'Your {{platform_name}} subscription renews on {{date}}',
     'Hello {{admin_name}},\n\nThe subscription for {{school_name}} renews on {{date}}. An invoice will be sent to you before then.\n\nThank you,\n{{platform_name}}'),
    ('Invoice issued', 'email', 'invoice_issued', 'Invoice {{invoice_number}} from {{platform_name}}',
     'Hello {{admin_name}},\n\nInvoice {{invoice_number}} for {{school_name}} is ready.\n\nAmount: {{amount}}\nDue date: {{date}}\n\nYou can view and pay it online at {{link}}\n\nThank you,\n{{platform_name}}'),
    ('Payment received', 'email', 'payment_received', 'Payment received: thank you',
     'Hello {{admin_name}},\n\nWe received {{amount}} for invoice {{invoice_number}} ({{school_name}}).\n\nThank you,\n{{platform_name}}'),
    ('Invoice overdue (email)', 'email', 'invoice_overdue', 'Invoice {{invoice_number}} is overdue',
     'Hello {{admin_name}},\n\nInvoice {{invoice_number}} for {{school_name}} ({{amount}} outstanding) was due on {{date}}. Please pay it at {{link}} to keep your school portal active.\n\n{{platform_name}}'),
    ('Invoice overdue (SMS)', 'sms', 'invoice_overdue', NULL,
     '{{platform_name}}: invoice {{invoice_number}} of {{amount}} was due on {{date}}. Please pay to avoid interruption.'),
    ('Support ticket reply', 'email', 'ticket_reply', 'Re: {{ticket_subject}} [{{ticket_code}}]',
     'Hello {{admin_name}},\n\nOur team replied to your support ticket {{ticket_code}}:\n\n{{message}}\n\nYou can reply from your school portal under Support.\n\n{{platform_name}}')
ON CONFLICT (name) DO NOTHING;
