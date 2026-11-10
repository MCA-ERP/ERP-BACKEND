-- ====================================================================
-- MIGRATION 020: ROLES MANAGEMENT
-- Custom roles (for every school or one school), role scope, data scope, module access per role,
-- page-level restrictions for platform roles, approval rights, and a history of every change.
-- ====================================================================

ALTER TABLE public.roles
    ADD COLUMN IF NOT EXISTS scope          VARCHAR(10) NOT NULL DEFAULT 'school' CHECK (scope IN ('platform', 'school')),
    ADD COLUMN IF NOT EXISTS data_scope     VARCHAR(10) NOT NULL DEFAULT 'school' CHECK (data_scope IN ('school', 'campus')),
    ADD COLUMN IF NOT EXISTS institution_id UUID REFERENCES public.institutions(id) ON DELETE CASCADE,  -- NULL = available to every school
    ADD COLUMN IF NOT EXISTS created_by     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE public.roles SET scope = 'platform' WHERE name IN ('SuperAdmin', 'PlatformManager', 'Finance', 'SupportAgent', 'ContentEditor');
-- teachers and other campus-level staff see their own campus by default
UPDATE public.roles SET data_scope = 'campus' WHERE name IN ('Faculty', 'Librarian');

-- when a role has rows here, its users can open only these modules (and only if the school's plan allows them)
CREATE TABLE public.role_modules (
    role_id     UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    module_code VARCHAR(40) NOT NULL REFERENCES public.modules(code) ON DELETE CASCADE,
    PRIMARY KEY (role_id, module_code)
);

-- pages of the admin portal a platform role may NOT open, even though it has the menu
CREATE TABLE public.role_page_denials (
    role_id  UUID NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
    page_key VARCHAR(60) NOT NULL,
    PRIMARY KEY (role_id, page_key)
);

-- every change to a role, with what the role could do afterwards (so any version can be restored)
CREATE TABLE public.role_changes (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_id      UUID REFERENCES public.roles(id) ON DELETE SET NULL,
    role_name    VARCHAR(50) NOT NULL,
    change_type  VARCHAR(20) NOT NULL
        CHECK (change_type IN ('created', 'copied', 'updated', 'deleted', 'permissions', 'modules', 'pages', 'data_scope', 'assigned', 'restored')),
    summary      TEXT NOT NULL,
    added        TEXT[] NOT NULL DEFAULT '{}',
    removed      TEXT[] NOT NULL DEFAULT '{}',
    snapshot     JSONB,
    actor_id     UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    actor_name   VARCHAR(200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_role_changes_role ON public.role_changes (role_id, created_at DESC);
CREATE INDEX idx_role_changes_time ON public.role_changes (created_at DESC);

ALTER TABLE public.role_modules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_page_denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_changes      ENABLE ROW LEVEL SECURITY;

-- approvals: who may approve admissions, fee concessions and waivers, payroll runs, and exam results
INSERT INTO public.permissions (code, module, description) VALUES
    ('approvals.admission', 'approvals', 'Approve new admissions'),
    ('approvals.fees',      'approvals', 'Approve fee concessions, waivers and write-offs'),
    ('approvals.payroll',   'approvals', 'Approve salary runs and changes'),
    ('approvals.results',   'approvals', 'Approve exam results before parents see them')
ON CONFLICT (code) DO NOTHING;

WITH grants(role_name, code) AS (VALUES
    ('InstitutionAdmin', 'approvals.admission'), ('InstitutionAdmin', 'approvals.fees'), ('InstitutionAdmin', 'approvals.payroll'), ('InstitutionAdmin', 'approvals.results'),
    ('Principal', 'approvals.admission'), ('Principal', 'approvals.fees'), ('Principal', 'approvals.results'),
    ('Registrar', 'approvals.admission'), ('HR', 'approvals.payroll'), ('Accountant', 'approvals.fees')
)
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM grants g JOIN public.roles r ON r.name = g.role_name JOIN public.permissions p ON p.code = g.code
ON CONFLICT DO NOTHING;

-- starting point for every default role's history
INSERT INTO public.role_changes (role_id, role_name, change_type, summary, snapshot, actor_name)
SELECT r.id, r.name, 'created', 'Initial version',
       jsonb_build_object('permissions', COALESCE((SELECT jsonb_agg(p.code ORDER BY p.code) FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id WHERE rp.role_id = r.id), '[]'::jsonb)),
       'System'
FROM public.roles r;
