-- ====================================================================
-- MIGRATION 039: DEFAULT SCHOOL ROLES AS THE DESIGN LISTS THEM
-- These roles are the same for every school. Existing roles keep their keys; only their display names and
-- descriptions change. New roles start with no permissions: set them under Permission Management.
-- ====================================================================

UPDATE public.roles SET display_name = 'School Admin', description = 'Full control of one school' WHERE name = 'InstitutionAdmin';
UPDATE public.roles SET display_name = 'Principal', description = 'Academics, approvals and reports' WHERE name = 'Principal';
UPDATE public.roles SET display_name = 'HR Manager', description = 'Staff records, leave, staff attendance and payroll verification (HR portal)' WHERE name = 'HR';
UPDATE public.roles SET display_name = 'Teacher', description = 'Attendance, homework and marks for assigned classes' WHERE name = 'Faculty';
UPDATE public.roles SET display_name = 'Accountant', description = 'Fees, invoices, receipts, concessions, expenses and accounts (Fee & Finance portal)' WHERE name = 'Accountant';
UPDATE public.roles SET display_name = 'Librarian', description = 'Catalogue, barcodes, issue, return and fines (Library portal)' WHERE name = 'Librarian';
UPDATE public.roles SET display_name = 'Parent', description = 'Their children''s records in the parent app' WHERE name = 'Parent';
UPDATE public.roles SET display_name = 'Student', description = 'Their own records in the student app' WHERE name = 'Student';

INSERT INTO public.roles (name, display_name, description, is_system_default, scope, data_scope) VALUES
    ('VicePrincipal',     'Vice Principal',            'Principal rights except final approvals',                                          TRUE, 'school', 'school'),
    ('AdmissionsHead',    'Admissions Head',           'Enquiries, applications, approvals and onboarding (Admissions portal)',            TRUE, 'school', 'school'),
    ('ClassTeacher',      'Class Teacher',             'Teacher rights plus their class''s records and parent messages',                   TRUE, 'school', 'school'),
    ('Receptionist',      'Receptionist',              'Enquiries, visitors and admissions forms',                                         TRUE, 'school', 'campus'),
    ('TransportManager',  'Transport Manager',         'Vehicles, crew, routes, trips and transport fees (Transport portal)',              TRUE, 'school', 'campus'),
    ('SchoolNurse',       'School Nurse',              'Medical records, infirmary, health visits and incidents (Health & Counselling portal)', TRUE, 'school', 'campus'),
    ('Counsellor',        'Counsellor',                'Counselling appointments, confidential sessions and referrals (Health & Counselling portal)', TRUE, 'school', 'campus'),
    ('MessManager',       'Mess Manager',              'Day-scholar mess, daily menus and hostel meals',                                   TRUE, 'school', 'campus'),
    ('StoreIncharge',     'Store & Assets In-charge',  'Stock, purchases, goods receipt, assets and maintenance (Inventory & Assets portal)', TRUE, 'school', 'campus'),
    ('FrontOfficeSecurity','Front Office & Security',  'Visitors, gate passes, movement and emergency contacts (Visitor & Security portal)', TRUE, 'school', 'campus')
ON CONFLICT (name) DO NOTHING;
