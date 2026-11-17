-- ====================================================================
-- MIGRATION 038: APPROVAL CHAINS
-- For each kind of request: who approves it, in what order, within how many days, and the rules around it.
-- These are the platform defaults. The approval screens come with the modules that raise the requests.
-- ====================================================================

CREATE TABLE public.approval_flows (
    key                TEXT PRIMARY KEY,
    label              TEXT NOT NULL,
    sort_order         INTEGER NOT NULL DEFAULT 0,
    require_approval   BOOLEAN NOT NULL DEFAULT TRUE,
    require_hint       TEXT NOT NULL DEFAULT 'Nothing goes through without it',
    escalate_overdue   BOOLEAN NOT NULL DEFAULT TRUE,
    allow_delegate     BOOLEAN NOT NULL DEFAULT TRUE,
    notify_requester   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.approval_levels (
    flow_key       TEXT NOT NULL REFERENCES public.approval_flows(key) ON DELETE CASCADE,
    level          INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
    approver_role  VARCHAR(80) NOT NULL,
    when_text      VARCHAR(200) NOT NULL,
    within_days    INTEGER NOT NULL DEFAULT 1 CHECK (within_days BETWEEN 1 AND 30),
    PRIMARY KEY (flow_key, level)
);

ALTER TABLE public.approval_flows  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_levels ENABLE ROW LEVEL SECURITY;

INSERT INTO public.approval_flows (key, label, sort_order, allow_delegate, require_hint) VALUES
    ('admission', 'Admission', 1, TRUE, 'Nothing goes through without it'),
    ('fees', 'Fees', 2, TRUE, 'Nothing goes through without it'),
    ('payroll', 'Payroll', 3, FALSE, 'Nothing goes through without it'),
    ('results', 'Results', 4, TRUE, 'Results stay hidden from parents until approved'),
    ('leave', 'Leave', 5, TRUE, 'Nothing goes through without it'),
    ('attcorr', 'Attendance corrections', 6, TRUE, 'Nothing goes through without it'),
    ('lesson', 'Lesson plans', 7, TRUE, 'Nothing goes through without it'),
    ('mobile', 'Parent mobile changes', 8, TRUE, 'Nothing goes through without it'),
    ('mess', 'Mess opt-in', 9, TRUE, 'Nothing goes through without it'),
    ('health', 'Health updates', 10, TRUE, 'Nothing goes through without it'),
    ('staffdocs', 'Staff documents', 11, TRUE, 'Nothing goes through without it');

INSERT INTO public.approval_levels (flow_key, level, approver_role, when_text, within_days) VALUES
    ('admission', 1, 'Admissions counsellor or receptionist', 'Every application', 1),
    ('admission', 2, 'Principal', 'Every application', 2),
    ('admission', 3, 'School admin', 'Fee concession above 25%', 2),
    ('fees', 1, 'Accountant', 'Concessions and waivers', 1),
    ('fees', 2, 'Principal', 'Concession above ₹10,000', 2),
    ('fees', 3, 'School admin', 'Write-off of any amount', 3),
    ('payroll', 1, 'HR Manager', 'HR verification of the monthly payroll', 2),
    ('payroll', 2, 'Accountant', 'Finance approval before salaries are paid', 1),
    ('payroll', 3, 'Principal', 'Changes to salary structures', 2),
    ('results', 1, 'Subject teacher', 'Marks entry complete', 3),
    ('results', 2, 'Class teacher', 'Class results checked', 2),
    ('results', 3, 'Principal', 'Publish results to parents', 1),
    ('leave', 1, 'Class Teacher', 'Student leave applied by parents', 1),
    ('leave', 2, 'HR Manager', 'Staff leave', 1),
    ('leave', 3, 'Principal', 'Staff leave longer than 3 days', 2),
    ('attcorr', 1, 'School Admin', 'Teacher''s edit request', 1),
    ('attcorr', 2, 'Principal', 'Corrections older than 7 days', 2),
    ('lesson', 1, 'Vice Principal', 'Every submitted lesson plan', 2),
    ('lesson', 2, 'Principal', 'Plans returned twice', 2),
    ('mobile', 1, 'School Admin', 'Send a code to the new number and confirm it', 1),
    ('mobile', 2, 'School Admin', 'Approve and update the number everywhere', 1),
    ('mess', 1, 'Mess Manager', 'Plan and allergy check', 1),
    ('mess', 2, 'Accountant', 'Add mess charges to the fee', 2),
    ('health', 1, 'School Nurse', 'Medical notes and vaccination cards', 1),
    ('health', 2, 'Principal', 'New serious condition or allergy', 1),
    ('staffdocs', 1, 'HR Manager', 'Qualifications and documents added in My Profile', 3);
