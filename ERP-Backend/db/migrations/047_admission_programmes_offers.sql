-- Admission programmes (rules, ranking, seats), seat offers, the offer letter template and automatic messages.
CREATE TABLE public.adm_programmes (
    institution_id   UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    name             VARCHAR(80) NOT NULL,
    classes          VARCHAR(200) NOT NULL,
    min_age          INTEGER NOT NULL DEFAULT 3 CHECK (min_age BETWEEN 1 AND 25),
    overall_pct      INTEGER CHECK (overall_pct BETWEEN 0 AND 100),
    seats_total      INTEGER NOT NULL DEFAULT 0 CHECK (seats_total >= 0),
    assessment       VARCHAR(200) NOT NULL DEFAULT '',
    test_weight      INTEGER NOT NULL DEFAULT 0 CHECK (test_weight BETWEEN 0 AND 100),
    interview_weight INTEGER NOT NULL DEFAULT 100 CHECK (interview_weight BETWEEN 0 AND 100),
    seats_on_merit   INTEGER NOT NULL DEFAULT 0 CHECK (seats_on_merit >= 0),
    tie_break        VARCHAR(120) NOT NULL DEFAULT 'Older child first',
    categories       JSONB NOT NULL DEFAULT '{}'::JSONB,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (institution_id, name)
);
CREATE TABLE public.adm_offers (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    application_id UUID NOT NULL UNIQUE REFERENCES public.adm_applications(id) ON DELETE CASCADE,
    category       VARCHAR(30) NOT NULL DEFAULT 'General',
    offered_on     DATE NOT NULL DEFAULT CURRENT_DATE,
    accept_by      DATE NOT NULL,
    status         VARCHAR(12) NOT NULL DEFAULT 'Offered' CHECK (status IN ('Offered', 'Accepted', 'Fee paid', 'Confirmed', 'Expired')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_adm_offers_school ON public.adm_offers (institution_id, offered_on DESC);
CREATE TABLE public.adm_settings (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    letter_template TEXT,
    auto_messages  JSONB NOT NULL DEFAULT '{}'::JSONB
);
ALTER TABLE public.adm_programmes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_offers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.adm_settings   ENABLE ROW LEVEL SECURITY;
