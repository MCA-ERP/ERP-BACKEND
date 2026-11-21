-- Library circulation (members, issues, reservations, fines, settings) and inventory items.
ALTER TABLE public.lib_books ADD COLUMN price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0);
CREATE SEQUENCE public.lib_member_seq START 140;
CREATE SEQUENCE public.lib_res_seq START 421;
CREATE SEQUENCE public.lib_fine_seq START 4054;
CREATE TABLE public.lib_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code VARCHAR(20) NOT NULL DEFAULT ('LC-' || to_char(NOW(), 'YYYY') || lpad(nextval('public.lib_member_seq')::text, 4, '0')),
    kind VARCHAR(8) NOT NULL CHECK (kind IN ('Student', 'Staff')),
    student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    valid_until DATE NOT NULL,
    status VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Blocked')),
    UNIQUE (institution_id, student_id), UNIQUE (institution_id, staff_id)
);
CREATE TABLE public.lib_issues (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    copy_id UUID NOT NULL REFERENCES public.lib_copies(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES public.lib_members(id) ON DELETE CASCADE,
    issued_on DATE NOT NULL DEFAULT CURRENT_DATE, due_on DATE NOT NULL,
    returned_on DATE, renewals INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(10) NOT NULL DEFAULT 'Issued' CHECK (status IN ('Issued', 'Returned', 'Lost'))
);
CREATE INDEX idx_lib_issues_school ON public.lib_issues (institution_id, issued_on DESC);
CREATE TABLE public.lib_reservations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code VARCHAR(12) NOT NULL DEFAULT ('RS-' || lpad(nextval('public.lib_res_seq')::text, 4, '0')),
    book_id UUID NOT NULL REFERENCES public.lib_books(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES public.lib_members(id) ON DELETE CASCADE,
    reserved_on DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(16) NOT NULL DEFAULT 'Waiting' CHECK (status IN ('Waiting', 'Ready to collect', 'Cancelled', 'Issued'))
);
CREATE TABLE public.lib_fines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code VARCHAR(12) NOT NULL DEFAULT ('LF-' || nextval('public.lib_fine_seq')),
    member_id UUID NOT NULL REFERENCES public.lib_members(id) ON DELETE CASCADE,
    issue_id UUID REFERENCES public.lib_issues(id) ON DELETE SET NULL,
    reason VARCHAR(80) NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
    fined_on DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(8) NOT NULL DEFAULT 'Unpaid' CHECK (status IN ('Unpaid', 'Paid', 'Waived'))
);
CREATE TABLE public.lib_settings (
    institution_id UUID PRIMARY KEY REFERENCES public.institutions(id) ON DELETE CASCADE,
    lim_low INTEGER NOT NULL DEFAULT 1 CHECK (lim_low BETWEEN 0 AND 50), lim_high INTEGER NOT NULL DEFAULT 2 CHECK (lim_high BETWEEN 0 AND 50), lim_staff INTEGER NOT NULL DEFAULT 5 CHECK (lim_staff BETWEEN 0 AND 50),
    ref_rule VARCHAR(30) NOT NULL DEFAULT 'Read in library only',
    days_student INTEGER NOT NULL DEFAULT 14 CHECK (days_student BETWEEN 1 AND 365), days_staff INTEGER NOT NULL DEFAULT 30 CHECK (days_staff BETWEEN 1 AND 365),
    renewals INTEGER NOT NULL DEFAULT 2 CHECK (renewals BETWEEN 0 AND 10), remind_days INTEGER NOT NULL DEFAULT 2 CHECK (remind_days BETWEEN 0 AND 14),
    late_student INTEGER NOT NULL DEFAULT 2 CHECK (late_student >= 0), late_staff INTEGER NOT NULL DEFAULT 5 CHECK (late_staff >= 0),
    max_fine VARCHAR(30) NOT NULL DEFAULT 'Up to the book''s price', lost_rule VARCHAR(30) NOT NULL DEFAULT 'Book price + ₹50 processing',
    block_unpaid BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE SEQUENCE public.inv_item_seq START 13;
CREATE TABLE public.inv_categories (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE, name VARCHAR(80) NOT NULL, status VARCHAR(8) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')), UNIQUE (institution_id, name));
CREATE TABLE public.inv_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    institution_id UUID NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
    code VARCHAR(12) NOT NULL DEFAULT ('IT-' || lpad(nextval('public.inv_item_seq')::text, 3, '0')),
    name VARCHAR(160) NOT NULL, category_id UUID REFERENCES public.inv_categories(id) ON DELETE SET NULL,
    unit VARCHAR(20) NOT NULL DEFAULT 'pieces', in_stock INTEGER NOT NULL DEFAULT 0 CHECK (in_stock >= 0),
    reorder_at INTEGER NOT NULL DEFAULT 0 CHECK (reorder_at >= 0), unit_price INTEGER NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
    UNIQUE (institution_id, code)
);
ALTER TABLE public.lib_members ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lib_issues ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lib_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lib_fines ENABLE ROW LEVEL SECURITY; ALTER TABLE public.lib_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE public.inv_categories ENABLE ROW LEVEL SECURITY; ALTER TABLE public.inv_items ENABLE ROW LEVEL SECURITY;
