-- ====================================================================
-- MIGRATION 025: WHATSAPP AND EMAIL OPENS
-- WhatsApp becomes a sendable channel (when a Meta WhatsApp Business account is connected),
-- and campaign emails can record when they were opened.
-- ====================================================================

ALTER TABLE public.message_log DROP CONSTRAINT IF EXISTS message_log_channel_check;
ALTER TABLE public.message_log
    ADD CONSTRAINT message_log_channel_check CHECK (channel IN ('email', 'sms', 'whatsapp'));

ALTER TABLE public.message_log
    ADD COLUMN IF NOT EXISTS opened_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS open_count INTEGER NOT NULL DEFAULT 0;

-- WhatsApp needs a template approved by Meta; its name goes in provider_template_id
INSERT INTO public.message_templates (name, channel, key, subject, body) VALUES
    ('Announcement (WhatsApp)', 'whatsapp', 'announcement', NULL, '{{platform_name}}: {{message}}')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.platform_settings (key, value) VALUES
    ('communication.track_email_opens', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
