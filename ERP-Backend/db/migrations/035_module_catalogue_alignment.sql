-- ====================================================================
-- MIGRATION 035: ADMINISTRATIVE, COMMUNICATION AND ADVANCED MODULES AS THE DESIGN LISTS THEM
-- Names, descriptions, the plan each starts from, add-on prices, where it shows, and what it depends on.
-- ====================================================================

UPDATE public.modules SET name = 'HR',                      description = 'Staff records, leave, staff attendance and appraisals.' WHERE code = 'hr_payroll';
UPDATE public.modules SET name = 'Payroll',                 description = 'Salary structures, payslips, PF, ESI and TDS.' WHERE code = 'payroll';
UPDATE public.modules SET name = 'Finance',                 description = 'Fee structures, collection, concessions, receipts and accounting.' WHERE code = 'fees';
UPDATE public.modules SET name = 'Transport',               description = 'Routes, stops, vehicles, live GPS and transport fees.' WHERE code = 'transport';
UPDATE public.modules SET name = 'Library',                 description = 'Catalogue, issue, return, renewals, reservations and fines.' WHERE code = 'library';
UPDATE public.modules SET name = 'Front Office & Visitors', description = 'Enquiries, visitors, gate passes, calls, post and complaints.' WHERE code = 'visitors';
UPDATE public.modules SET name = 'Certificates', category = 'Administrative', description = 'Bonafide, study, conduct and transfer certificates with templates.' WHERE code = 'certificates';
UPDATE public.modules SET name = 'SMS',                     description = 'DLT-registered SMS alerts to parents and staff.' WHERE code = 'sms_whatsapp';
UPDATE public.modules SET name = 'Email',                   description = 'Transactional and bulk email from the school.' WHERE code = 'email';
UPDATE public.modules SET name = 'Notifications',           description = 'Push and in-app notifications in the parent, teacher and student apps.' WHERE code = 'notifications';
UPDATE public.modules SET name = 'Parent Portal',           description = 'The parent app in English, Hindi and Telugu: progress, attendance, fees, homework, bus, health, library and mess.' WHERE code = 'parent_app';
UPDATE public.modules SET name = 'LMS',                     description = 'Online classes, recorded lessons, quizzes and assignments.' WHERE code = 'online_classes';
UPDATE public.modules SET name = 'Hostel',                  description = 'Rooms, allotment, mess, hostel attendance and hostel fees.' WHERE code = 'hostel';
UPDATE public.modules SET name = 'Inventory',               description = 'Stock, purchase orders, vendors and asset tracking.' WHERE code = 'inventory';
UPDATE public.modules SET name = 'Analytics',               description = 'Cross-campus dashboards, custom reports and a data export API.' WHERE code = 'custom_reports_api';
UPDATE public.modules SET name = 'Day Scholar Mess', category = 'Advanced' WHERE code = 'cafeteria';

INSERT INTO public.modules (code, name, description, is_core, sort_order, category) VALUES
    ('employee_self_service', 'Employee Self-Service',         'My Profile and My Payslips for every staff member.',                                 FALSE, 32, 'Administrative'),
    ('whatsapp',              'WhatsApp',                       'Approved template messages on WhatsApp Business.',                                   FALSE, 33, 'Communication'),
    ('school_diary',          'School Diary & Parent Messages', 'Class diary, teacher remarks and two-way parent-teacher messages.',                  FALSE, 34, 'Communication'),
    ('health_welfare',        'Health & Welfare',               'Health records, screening, vaccinations, medical visits and parent health updates.', FALSE, 35, 'Advanced')
ON CONFLICT (code) DO NOTHING;

-- the plan each module starts from (and every plan above it), its add-on price in paise per student a year, and where it shows
CREATE TEMP TABLE _m (code TEXT, from_plan TEXT, addon INT, parent BOOLEAN, teacher BOOLEAN);
INSERT INTO _m VALUES
    ('hr_payroll', 'premium', 5000, FALSE, FALSE), ('payroll', 'premium', 8000, FALSE, FALSE), ('fees', 'basic', 0, FALSE, FALSE),
    ('transport', 'premium', 7000, FALSE, FALSE), ('library', 'standard', 2500, FALSE, FALSE), ('visitors', 'standard', 2500, FALSE, FALSE),
    ('certificates', 'basic', 0, FALSE, FALSE), ('employee_self_service', 'premium', 2000, FALSE, FALSE),
    ('sms_whatsapp', 'standard', 2000, TRUE, TRUE), ('email', 'basic', 0, TRUE, TRUE), ('whatsapp', 'premium', 3000, TRUE, TRUE),
    ('notifications', 'basic', 0, TRUE, TRUE), ('school_diary', 'basic', 0, TRUE, TRUE), ('parent_app', 'basic', 0, TRUE, TRUE),
    ('online_classes', 'premium', 9000, TRUE, FALSE), ('hostel', 'enterprise', 6000, TRUE, FALSE), ('inventory', 'premium', 4000, TRUE, FALSE),
    ('custom_reports_api', 'enterprise', 10000, TRUE, FALSE), ('health_welfare', 'premium', 4000, TRUE, FALSE);

UPDATE public.modules m SET addon_price_paise = t.addon, offer_as_addon = t.addon > 0, show_in_parent_app = t.parent, show_in_teacher_app = t.teacher
FROM _m t WHERE m.code = t.code;

DELETE FROM public.plan_modules WHERE module_code IN (SELECT code FROM _m);
INSERT INTO public.plan_modules (plan_id, module_code)
SELECT p.id, t.code FROM _m t
JOIN public.plans from_p ON from_p.code = t.from_plan
JOIN public.plans p ON p.sort_order >= from_p.sort_order
ON CONFLICT DO NOTHING;

-- what each module needs
DELETE FROM public.module_dependencies WHERE module_code IN (SELECT code FROM _m) OR module_code IN ('academics', 'exams', 'timetable', 'attendance', 'activities_events');
INSERT INTO public.module_dependencies (module_code, requires_code) VALUES
    ('academics', 'student_information'), ('exams', 'academics'), ('attendance', 'student_information'), ('timetable', 'academics'), ('activities_events', 'student_information'),
    ('payroll', 'hr_payroll'), ('fees', 'student_information'), ('transport', 'student_information'), ('library', 'student_information'), ('certificates', 'student_information'),
    ('employee_self_service', 'hr_payroll'), ('employee_self_service', 'payroll'),
    ('school_diary', 'notifications'), ('parent_app', 'student_information'), ('parent_app', 'notifications'),
    ('online_classes', 'academics'), ('hostel', 'student_information'), ('hostel', 'fees'), ('inventory', 'fees'), ('health_welfare', 'student_information')
ON CONFLICT DO NOTHING;

DROP TABLE _m;
