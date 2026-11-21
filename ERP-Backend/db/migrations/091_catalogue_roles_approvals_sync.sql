-- Bring Super Admin in line with the school portals: modules, plans, flags, releases, roles, approval chains, templates, integrations.
WITH m(code, name, descr, cat, plan_code, ord) AS (VALUES
  ('online_admissions', 'Online Admissions', 'Online application with programme rules, merit lists, seat matrix, offers and the Applicant Portal', 'Academic', 'premium', 40),
  ('holistic_card', 'Holistic Progress Card', 'Skills, activities and co-scholastic progress beyond marks', 'Academic', 'standard', 41),
  ('house_points', 'Houses & House Points', 'Houses, points awarded by teachers and standings', 'Academic', 'standard', 42),
  ('canteen_wallet', 'Canteen Wallet', 'Student wallet, daily limits and allergy-safe canteen billing', 'Administrative', 'premium', 43),
  ('auto_reminders', 'Fee Auto Reminders', 'Scheduled fee reminders and the daily queue', 'Administrative', 'standard', 44),
  ('fee_reconciliation', 'Reconciliation & Bank Matching', 'Live reconciliation of online payments and bank statement matching', 'Administrative', 'premium', 45),
  ('budgets_forecasts', 'Budgets & Forecasts', 'Budgets, forecasts and expense approvals', 'Administrative', 'premium', 46),
  ('ai_insights', 'AI Insights', 'AI summaries and insights for management', 'Advanced', 'enterprise', 47),
  ('claims_advances', 'Staff Claims & Advances', 'Reimbursement claims and salary advances', 'Administrative', 'premium', 48),
  ('tally_export', 'Tally Export', 'Accounting export to Tally Prime', 'Advanced', 'premium', 49),
  ('recruitment', 'Recruitment & Onboarding', 'Vacancies, candidates, interviews, offers and onboarding', 'Administrative', 'premium', 50),
  ('appraisal_360', '360° Appraisal', 'Staff appraisal with multi-source feedback and increments', 'Administrative', 'premium', 51),
  ('statutory_files', 'Bank & Statutory Files', 'Bank transfer file, PF ECR, ESI, PT and TDS files', 'Administrative', 'premium', 52),
  ('helpdesk', 'Help Desk', 'Tickets raised by staff and parents inside the school', 'Communication', 'standard', 53),
  ('surveys', 'Surveys & Feedback', 'Parent, student and staff surveys and teacher feedback', 'Communication', 'standard', 54),
  ('photo_gallery', 'Photo Gallery', 'Albums with photo-consent controls', 'Communication', 'standard', 55),
  ('chat', 'Chat', 'Parent, student and teacher chat with moderation', 'Communication', 'standard', 56),
  ('competitive_prep', 'Competitive Exam Prep', 'JEE, NEET and olympiad preparation programmes', 'Academic', 'premium', 57),
  ('ai_chatbot', 'AI Chatbot', 'WhatsApp and website assistant for parents and visitors', 'Advanced', 'enterprise', 58),
  ('school_store', 'School Store', 'Uniform and book store billing and stock', 'Administrative', 'premium', 59),
  ('driver_app', 'Driver App', 'Trip roster, boarding and live location for drivers', 'Advanced', 'premium', 60),
  ('parent_requests', 'Parent Request Forms', 'Concessions, certificates, mess and other requests raised by parents', 'Communication', 'standard', 61),
  ('management_portal', 'Management / Education Group', 'Management portal with group-level dashboards', 'Advanced', 'enterprise', 62),
  ('dpdp_consent', 'DPDP Consent Centre', 'Consent register and data requests under the DPDP Act', 'Administrative', 'basic', 63)
), ins AS (
  INSERT INTO public.modules (code, name, description, is_core, sort_order, category, build_status)
  SELECT code, name, descr, FALSE, ord, cat, 'live' FROM m
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category, build_status = 'live'
  RETURNING code
)
INSERT INTO public.plan_modules (plan_id, module_code)
SELECT p.id, m.code FROM m JOIN public.plans tp ON tp.code = m.plan_code JOIN public.plans p ON p.sort_order >= tp.sort_order AND p.sort_order < 90 JOIN ins ON ins.code = m.code
ON CONFLICT DO NOTHING;

INSERT INTO public.feature_flags (key, name, description, module_code, rollout_percent, enabled)
SELECT 'mod_' || code, name, 'Switch for ' || name, code, 100, TRUE FROM public.modules WHERE sort_order BETWEEN 40 AND 63 ON CONFLICT (key) DO NOTHING;
INSERT INTO public.module_releases (module_code, version, notes, status, rollout_percent, released_at)
SELECT code, '1.0.0', 'First release in the school portal', 'live', 100, now() FROM public.modules WHERE sort_order BETWEEN 40 AND 63 AND NOT EXISTS (SELECT 1 FROM public.module_releases r WHERE r.module_code = modules.code);

-- roles
INSERT INTO public.roles (name, display_name, description, is_system_default) VALUES
  ('Chairman', 'Chairman / Management', 'Management portal; approves the Principal''s leave and policy-level requests', TRUE),
  ('HOD', 'Head of Department', 'First approver for teachers'' leave and lesson plans', TRUE),
  ('Driver', 'Driver', 'Driver app: trip roster, boarding and location', TRUE),
  ('Applicant', 'Applicant (family)', 'Applicant Portal: apply, upload documents, pay and track', TRUE),
  ('CanteenOperator', 'Canteen operator', 'Canteen counter billing', TRUE),
  ('DataProtectionOfficer', 'Data protection officer', 'Consent register and data requests', TRUE)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT n.id, rp.permission_id FROM (VALUES ('Chairman', 'Principal'), ('HOD', 'Faculty'), ('CanteenOperator', 'MessManager')) v(newr, basr)
JOIN public.roles n ON n.name = v.newr JOIN public.roles b ON b.name = v.basr JOIN public.role_permissions rp ON rp.role_id = b.id ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r JOIN public.permissions p ON p.code = 'admin.audit.view' WHERE r.name = 'DataProtectionOfficer' ON CONFLICT DO NOTHING;

-- approval chains
UPDATE public.approval_levels SET approver_role = 'HOD', when_text = 'Teachers'' leave' WHERE flow_key = 'leave' AND level = 2;
UPDATE public.approval_levels SET approver_role = 'Vice Principal', when_text = 'Leave longer than 3 days' WHERE flow_key = 'leave' AND level = 3;
INSERT INTO public.approval_levels (flow_key, level, approver_role, when_text, within_days) VALUES ('leave', 4, 'Principal', 'Staff leave beyond the Vice Principal''s limit', 2), ('leave', 5, 'Chairman', 'The Principal''s own leave', 3) ON CONFLICT DO NOTHING;
UPDATE public.approval_levels SET approver_role = 'Principal' WHERE flow_key = 'leave' AND level = 4;
WITH f(key, label, ord) AS (VALUES ('merit_offers', 'Merit list and offers', 12), ('seat_release', 'Seat release', 13), ('comp_off', 'Comp-off', 14), ('increments', 'Increments', 15), ('claims', 'Staff claims and advances', 16), ('vacancy', 'Vacancy approval', 17), ('concession', 'Parent concession requests', 18), ('parent_requests', 'Parent request forms', 19), ('vendor_quotation', 'Vendor and quotation approval', 20), ('bank_matching', 'Bank statement matching', 21), ('data_requests', 'Data requests (DPDP)', 22))
INSERT INTO public.approval_flows (key, label, sort_order) SELECT key, label, ord FROM f ON CONFLICT (key) DO NOTHING;
INSERT INTO public.approval_levels (flow_key, level, approver_role, when_text, within_days) VALUES
  ('merit_offers', 1, 'Admissions counsellor', 'Merit list prepared', 2), ('merit_offers', 2, 'Principal', 'Offers released', 2),
  ('seat_release', 1, 'Admissions counsellor', 'Unpaid seats released', 1), ('seat_release', 2, 'Principal', 'Seats given to the waiting list', 2),
  ('comp_off', 1, 'HOD', 'Extra duty claimed', 2), ('comp_off', 2, 'Principal', 'Comp-off granted', 2),
  ('increments', 1, 'HR Manager', 'Appraisal review', 3), ('increments', 2, 'Principal', 'Recommended increment', 3), ('increments', 3, 'Chairman', 'Above the policy limit', 5),
  ('claims', 1, 'HOD', 'Claim or advance raised', 2), ('claims', 2, 'Accountant', 'Bills checked', 2), ('claims', 3, 'Principal', 'Amount above the limit', 3),
  ('vacancy', 1, 'HOD', 'New vacancy raised', 2), ('vacancy', 2, 'Principal', 'Vacancy approved', 3), ('vacancy', 3, 'Chairman', 'New post', 5),
  ('concession', 1, 'Accountant', 'Parent request received', 1), ('concession', 2, 'Principal', 'Above the limit', 2),
  ('parent_requests', 1, 'School Admin', 'Request received from a parent', 2),
  ('vendor_quotation', 1, 'Store in-charge', 'Quotes compared', 2), ('vendor_quotation', 2, 'Principal', 'Award above ₹25,000', 3),
  ('bank_matching', 1, 'Accountant', 'Manual match of a bank line', 1), ('bank_matching', 2, 'Principal', 'Exception cleared', 2),
  ('data_requests', 1, 'Data protection officer', 'Request received', 3), ('data_requests', 2, 'Principal', 'Erasure of a record', 3)
ON CONFLICT DO NOTHING;

-- automatic messages the portals send
INSERT INTO public.message_templates (name, channel, subject, body) VALUES
  ('Offer reminder (SMS)', 'sms', NULL, 'Your seat offer for {child} expires on {date}. Pay the fee to confirm.'),
  ('Offer reminder (WhatsApp)', 'whatsapp', NULL, 'Hello {parent}, the offer for {child} expires on {date}. Please complete the payment.'),
  ('Fee reminder (SMS)', 'sms', NULL, '{student} ({class}) has ₹{amount} due by {due_date}.'),
  ('Fee reminder (WhatsApp)', 'whatsapp', NULL, 'Dear parent, fees of ₹{amount} for {student} are due on {due_date}.'),
  ('Fee reminder (Email)', 'email', 'Fee reminder for {student}', 'Dear {parent}, ₹{amount} is due for {student} by {due_date}.'),
  ('Bus stop alert (SMS)', 'sms', NULL, 'The bus is 5 minutes from {stop}. Please be ready.'),
  ('Bus stop alert (App)', 'in_app', NULL, 'The bus is 5 minutes from {stop}.'),
  ('Request reply (App)', 'in_app', NULL, 'Your request {code} has been {status}. {note}'),
  ('Request reply (Email)', 'email', 'Your request {code}', 'Your request {code} has been {status}. {note}')
ON CONFLICT (name) DO NOTHING;

-- integrations the school portals rely on, configured by Super Admin
CREATE TABLE IF NOT EXISTS public.platform_integrations (key VARCHAR(40) PRIMARY KEY, name VARCHAR(100) NOT NULL, category VARCHAR(20) NOT NULL, notes VARCHAR(200) NOT NULL DEFAULT '', status VARCHAR(16) NOT NULL DEFAULT 'not_configured' CHECK (status IN ('not_configured', 'configured', 'live')), sort_order INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
ALTER TABLE public.platform_integrations ENABLE ROW LEVEL SECURITY;
INSERT INTO public.platform_integrations (key, name, category, notes, sort_order) VALUES
  ('hdfc_feed', 'HDFC bank statement feed', 'Bank', 'Feeds bank statement matching', 1), ('tally_prime', 'Tally Prime (XML export)', 'Accounting', 'Accounting export', 2),
  ('rfid_readers', 'RFID readers', 'Hardware', 'Gate readers for student attendance', 3), ('biometric', 'Biometric devices', 'Hardware', 'Staff attendance', 4),
  ('epfo', 'EPFO', 'Statutory', 'PF ECR filing', 5), ('esic', 'ESIC', 'Statutory', 'ESI filing', 6), ('traces', 'Income tax (TRACES)', 'Statutory', 'TDS returns', 7),
  ('zoom', 'Zoom', 'Online classes', '', 8), ('google_meet', 'Google Meet', 'Online classes', '', 9), ('teams', 'Microsoft Teams', 'Online classes', '', 10),
  ('ai_chatbot', 'AI parent chatbot', 'AI', 'Which schools have it and usage limits', 11), ('ai_insights', 'AI insights', 'AI', 'Which schools have it and usage limits', 12)
ON CONFLICT (key) DO NOTHING;
