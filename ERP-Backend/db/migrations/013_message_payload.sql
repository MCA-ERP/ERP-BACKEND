-- SMS messages are sent as "template id + variables"; keep them so a failed message can be retried.
ALTER TABLE public.message_log ADD COLUMN IF NOT EXISTS payload JSONB;

-- SMS announcements need an approved template at the SMS provider too.
INSERT INTO public.message_templates (name, channel, key, subject, body) VALUES
    ('Announcement (SMS)', 'sms', 'announcement', NULL, '{{platform_name}}: {{message}}')
ON CONFLICT (name) DO NOTHING;
