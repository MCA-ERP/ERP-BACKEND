-- ====================================================================
-- MIGRATION 015: COMMUNICATION EXTRAS
-- Scheduled announcements, in-app alerts/banners/pop-ups with an end date,
-- read receipts for in-app messages, template on/off, and cancelling queued messages.
-- ====================================================================

ALTER TABLE public.announcements DROP CONSTRAINT IF EXISTS announcements_status_check;
ALTER TABLE public.announcements
    ADD CONSTRAINT announcements_status_check CHECK (status IN ('draft', 'scheduled', 'sent'));

ALTER TABLE public.announcements
    ADD COLUMN IF NOT EXISTS kind          VARCHAR(12) NOT NULL DEFAULT 'announcement'
        CHECK (kind IN ('announcement', 'banner', 'alert', 'popup')),
    ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ends_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ended_at      TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_announcements_due ON public.announcements (scheduled_for) WHERE status = 'scheduled';

ALTER TABLE public.announcement_deliveries
    ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

ALTER TABLE public.message_templates
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.message_log DROP CONSTRAINT IF EXISTS message_log_status_check;
ALTER TABLE public.message_log
    ADD CONSTRAINT message_log_status_check CHECK (status IN ('queued', 'sent', 'failed', 'cancelled'));
