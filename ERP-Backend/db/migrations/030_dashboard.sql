-- ====================================================================
-- MIGRATION 030: DASHBOARD
-- What the team did about each alert (acknowledged or resolved), and KPI targets.
-- Alerts themselves are worked out live from the data; only the team's decision is stored.
-- ====================================================================

CREATE TABLE public.dashboard_alert_states (
    alert_id   VARCHAR(200) PRIMARY KEY,
    status     VARCHAR(15) NOT NULL CHECK (status IN ('acknowledged', 'resolved')),
    updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_dashboard_alert_states_updated ON public.dashboard_alert_states (updated_at DESC);
ALTER TABLE public.dashboard_alert_states ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_settings (key, value) VALUES
    ('dashboard.kpi_targets', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;
