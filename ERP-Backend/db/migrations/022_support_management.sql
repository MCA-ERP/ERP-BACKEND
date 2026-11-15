-- ====================================================================
-- MIGRATION 022: SUPPORT MANAGEMENT
-- Ticket categories with default agents, response and resolution targets per priority,
-- escalations, a help centre (articles, FAQs, tutorials), school feedback, and feature requests with votes.
-- ====================================================================

CREATE TABLE public.ticket_categories (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name             VARCHAR(50) UNIQUE NOT NULL,
    description      TEXT,
    subtopics        TEXT[] NOT NULL DEFAULT '{}',
    default_priority VARCHAR(10) CHECK (default_priority IN ('Low', 'Medium', 'High', 'Urgent')),
    default_agent_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.ticket_categories (name, description, subtopics, sort_order) VALUES
    ('Technical', 'App, transport, exams and messaging problems.', ARRAY['Parent app', 'Teacher app', 'Transport', 'Examinations', 'Messaging', 'Bug or error'], 1),
    ('Billing',   'Invoices, payments and subscriptions.',          ARRAY['Invoice', 'Payment', 'Refund', 'Subscription', 'GST'], 2),
    ('Account',   'Sign-in, admins, onboarding and data imports.',  ARRAY['Sign-in', 'School admins', 'Onboarding', 'Data import'], 3),
    ('General',   'Questions and everything else.',                 ARRAY['Question', 'Feature request', 'Other'], 4);

-- when support promises to answer and to fix, by priority
CREATE TABLE public.sla_policies (
    priority             VARCHAR(10) PRIMARY KEY CHECK (priority IN ('Low', 'Medium', 'High', 'Urgent')),
    first_response_hours INTEGER NOT NULL CHECK (first_response_hours > 0),
    resolution_hours     INTEGER NOT NULL CHECK (resolution_hours > 0),
    CHECK (resolution_hours >= first_response_hours)
);
INSERT INTO public.sla_policies (priority, first_response_hours, resolution_hours) VALUES
    ('Urgent', 1, 8), ('High', 4, 24), ('Medium', 8, 48), ('Low', 24, 120);

ALTER TABLE public.support_tickets
    ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS escalation_level  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS subtopic          VARCHAR(60);

-- first reply from staff for tickets that already have one
UPDATE public.support_tickets t SET first_response_at = (
    SELECT MIN(m.created_at) FROM public.ticket_messages m WHERE m.ticket_id = t.id AND NOT m.is_internal AND m.author_id IS NOT NULL
        AND m.author_id IS DISTINCT FROM t.raised_by
) WHERE first_response_at IS NULL;

CREATE TABLE public.ticket_escalations (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id     UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
    reason        VARCHAR(20) NOT NULL CHECK (reason IN ('response_overdue', 'resolution_overdue', 'manual')),
    from_priority VARCHAR(10) NOT NULL,
    to_priority   VARCHAR(10) NOT NULL,
    note          TEXT,
    escalated_by  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    escalator_name VARCHAR(200),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_escalations_time ON public.ticket_escalations (created_at DESC);
-- the system escalates a ticket once per kind of breach
CREATE UNIQUE INDEX uq_escalation_auto ON public.ticket_escalations (ticket_id, reason) WHERE reason <> 'manual';

-- the help centre
CREATE TABLE public.kb_items (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type          VARCHAR(10) NOT NULL CHECK (type IN ('article', 'faq', 'tutorial')),
    title         VARCHAR(255) NOT NULL,
    category      VARCHAR(50),
    body          TEXT NOT NULL,                    -- article text, the answer to a FAQ, or the steps of a tutorial
    video_url     VARCHAR(500),
    status        VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    sort_order    INTEGER NOT NULL DEFAULT 0,
    views         INTEGER NOT NULL DEFAULT 0,
    helpful_yes   INTEGER NOT NULL DEFAULT 0,
    helpful_no    INTEGER NOT NULL DEFAULT 0,
    created_by    UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    published_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_kb_published ON public.kb_items (type, status, sort_order);

-- ratings and comments from schools (optionally about one ticket)
CREATE TABLE public.school_feedback (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    ticket_id      UUID REFERENCES public.support_tickets(id) ON DELETE SET NULL,
    rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment        TEXT,
    submitted_by   UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    submitter_name VARCHAR(200),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_feedback_ticket ON public.school_feedback (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_feedback_time ON public.school_feedback (created_at DESC);

CREATE TABLE public.feature_requests (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID REFERENCES public.institutions(id) ON DELETE SET NULL,
    title          VARCHAR(200) NOT NULL,
    description    TEXT,
    status         VARCHAR(12) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'planned', 'in_progress', 'shipped', 'declined')),
    response       TEXT,
    submitter_name VARCHAR(200),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- one vote per school
CREATE TABLE public.feature_votes (
    request_id     UUID NOT NULL REFERENCES public.feature_requests(id) ON DELETE CASCADE,
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (request_id, institution_id)
);

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['kb_items', 'feature_requests']
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I
             FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    END LOOP;
    FOREACH t IN ARRAY ARRAY['ticket_categories', 'sla_policies', 'ticket_escalations', 'kb_items', 'school_feedback', 'feature_requests', 'feature_votes']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END;
$$;
