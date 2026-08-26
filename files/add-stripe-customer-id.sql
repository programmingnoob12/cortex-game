-- Run in Supabase SQL Editor
alter table public.users add column if not exists stripe_customer_id text;
alter table public.users add column if not exists stripe_subscription_id text;

-- No extra grant needed — the existing "grant all on public.users to
-- service_role" from earlier already covers these new columns too.
