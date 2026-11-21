-- 'Cancelled' is longer than the original VARCHAR(8) status column.
ALTER TABLE public.fee_payments ALTER COLUMN status TYPE VARCHAR(10);
