-- ====================================================================
-- MIGRATION 041: LANGUAGES, TRANSLATIONS AND SECURITY ALERT STATES
-- Languages the apps can be shown in, the phrases translated into each, and whether
-- a security alert has been acknowledged or resolved.
-- ====================================================================

CREATE TABLE public.languages (
    code        VARCHAR(10) PRIMARY KEY,
    name        VARCHAR(60) NOT NULL,
    status      VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('active', 'draft')),
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX languages_one_default ON public.languages (is_default) WHERE is_default;

CREATE TABLE public.translation_keys (
    key         VARCHAR(120) PRIMARY KEY,
    english     TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE public.translations (
    key           VARCHAR(120) NOT NULL REFERENCES public.translation_keys(key) ON DELETE CASCADE,
    language_code VARCHAR(10)  NOT NULL REFERENCES public.languages(code) ON DELETE CASCADE,
    value         TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key, language_code)
);

CREATE TABLE public.security_alert_states (
    alert_id    TEXT PRIMARY KEY,
    status      VARCHAR(12) NOT NULL CHECK (status IN ('acknowledged', 'resolved')),
    updated_by  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.languages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translation_keys     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.translations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_alert_states ENABLE ROW LEVEL SECURITY;

INSERT INTO public.languages (code, name, status, is_default, sort_order) VALUES
  ('en', 'English',   'active', TRUE,  1),
  ('hi', 'Hindi',     'active', FALSE, 2),
  ('te', 'Telugu',    'active', FALSE, 3),
  ('ta', 'Tamil',     'draft',  FALSE, 4),
  ('kn', 'Kannada',   'draft',  FALSE, 5),
  ('mr', 'Marathi',   'draft',  FALSE, 6),
  ('ml', 'Malayalam', 'draft',  FALSE, 7),
  ('bn', 'Bengali',   'draft',  FALSE, 8);

INSERT INTO public.translation_keys (key, english, sort_order) VALUES
  ('login.title',        'Sign in to your school', 1),
  ('fees.pay_now',       'Pay now', 2),
  ('attendance.present', 'Present', 3),
  ('homework.due',       'Due tomorrow', 4),
  ('bus.arriving',       'Bus arriving in 10 minutes', 5);

INSERT INTO public.translations (key, language_code, value) VALUES
  ('login.title', 'hi', 'अपने स्कूल में साइन इन करें'),
  ('fees.pay_now', 'hi', 'अभी भुगतान करें'),
  ('attendance.present', 'hi', 'उपस्थित'),
  ('homework.due', 'hi', 'कल तक जमा करें'),
  ('bus.arriving', 'hi', 'बस 10 मिनट में पहुँचेगी'),
  ('login.title', 'te', 'మీ పాఠశాలలో సైన్ ఇన్ చేయండి'),
  ('fees.pay_now', 'te', 'ఇప్పుడు చెల్లించండి'),
  ('attendance.present', 'te', 'హాజరు'),
  ('homework.due', 'te', 'రేపటికి');
