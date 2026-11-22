-- Teacher portal: circular acknowledgements, class diary details, report remarks, parent-teacher meeting slots, chat, HOD leave step, gallery uploader.

CREATE TABLE IF NOT EXISTS public.comm_circular_acks (
    circular_id UUID NOT NULL REFERENCES public.comm_circulars(id) ON DELETE CASCADE,
    profile_id  UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    acked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (circular_id, profile_id)
);

ALTER TABLE public.comm_diary
    ADD COLUMN IF NOT EXISTS section_id      UUID REFERENCES public.sections(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS student_id      UUID REFERENCES public.students(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS created_by      UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS ask_ack         BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(160);
CREATE TABLE IF NOT EXISTS public.comm_diary_seen (
    diary_id    UUID NOT NULL REFERENCES public.comm_diary(id) ON DELETE CASCADE,
    guardian_id UUID NOT NULL REFERENCES public.guardians(id) ON DELETE CASCADE,
    seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (diary_id, guardian_id)
);

CREATE TABLE IF NOT EXISTS public.student_report_remarks (
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    term           VARCHAR(10) NOT NULL CHECK (term IN ('Term 1', 'Term 2')),
    remark         VARCHAR(500) NOT NULL DEFAULT '',
    updated_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (student_id, term)
);

CREATE TABLE IF NOT EXISTS public.ptm_sessions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    teacher_id     UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    meet_date      DATE NOT NULL,
    starts         TIME NOT NULL DEFAULT '09:00',
    ends           TIME NOT NULL DEFAULT '13:00',
    slot_minutes   INTEGER NOT NULL DEFAULT 10 CHECK (slot_minutes BETWEEN 5 AND 60),
    room           VARCHAR(60) NOT NULL DEFAULT '',
    UNIQUE (teacher_id, meet_date)
);
CREATE TABLE IF NOT EXISTS public.ptm_slots (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id  UUID NOT NULL REFERENCES public.ptm_sessions(id) ON DELETE CASCADE,
    slot_time   TIME NOT NULL,
    status      VARCHAR(8) NOT NULL DEFAULT 'Free' CHECK (status IN ('Free', 'Booked', 'Blocked', 'Met')),
    guardian_id UUID REFERENCES public.guardians(id) ON DELETE SET NULL,
    student_id  UUID REFERENCES public.students(id) ON DELETE SET NULL,
    topic       VARCHAR(200) NOT NULL DEFAULT '',
    UNIQUE (session_id, slot_time)
);

CREATE TABLE IF NOT EXISTS public.chat_threads (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    kind           VARCHAR(10) NOT NULL DEFAULT 'group' CHECK (kind IN ('group', 'direct', 'department')),
    title          VARCHAR(120) NOT NULL,
    subtitle       VARCHAR(160) NOT NULL DEFAULT '',
    section_id     UUID REFERENCES public.sections(id) ON DELETE CASCADE,
    created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.chat_members (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id   UUID NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
    profile_id  UUID REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    guardian_id UUID REFERENCES public.guardians(id) ON DELETE CASCADE,
    CHECK ((profile_id IS NOT NULL) <> (guardian_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_member_profile  ON public.chat_members (thread_id, profile_id)  WHERE profile_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_member_guardian ON public.chat_members (thread_id, guardian_id) WHERE guardian_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.chat_messages (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id     UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    thread_id          UUID NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
    sender_profile_id  UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    sender_guardian_id UUID REFERENCES public.guardians(id) ON DELETE SET NULL,
    body               VARCHAR(2000) NOT NULL DEFAULT '',
    file_name          VARCHAR(160),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON public.chat_messages (thread_id, created_at);

-- leave: the head of department's step
ALTER TABLE public.leave_requests
    ADD COLUMN IF NOT EXISTS hod_by   UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS hod_at   TIMESTAMPTZ;

-- gallery: who uploaded, by id
ALTER TABLE public.gallery_albums ADD COLUMN IF NOT EXISTS uploaded_by_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.comm_circular_acks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comm_diary_seen        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_report_remarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ptm_sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ptm_slots              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_threads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_members           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages          ENABLE ROW LEVEL SECURITY;
