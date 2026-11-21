-- Keep fee heads, groups and optional fees in the order they were added.
ALTER TABLE public.fee_heads     ADD COLUMN pos BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.fee_groups    ADD COLUMN pos BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE public.fee_optional  ADD COLUMN pos BIGINT GENERATED ALWAYS AS IDENTITY;
