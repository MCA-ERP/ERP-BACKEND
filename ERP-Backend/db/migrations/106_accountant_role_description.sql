-- The Accountant now has its own Fee & Finance portal; say so in the role list.
UPDATE public.roles SET description = 'Fees, invoices, receipts, concessions, expenses and accounts (Fee & Finance portal)' WHERE name = 'Accountant';
