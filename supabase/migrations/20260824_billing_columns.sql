-- Billing columns on the existing users table. Everything here is written
-- exclusively by the Stripe webhook (service role), and read by the client
-- under its own RLS policy.
alter table public.users
  add column if not exists stripe_customer_id      text unique,
  add column if not exists stripe_subscription_id  text,
  add column if not exists plan                    text,
  add column if not exists current_period_end      timestamptz,
  add column if not exists cancel_at_period_end    boolean not null default false;

-- The webhook resolves accounts by customer id on every event.
create index if not exists users_stripe_customer_id_idx
  on public.users (stripe_customer_id);

-- membership_status values the app relies on:
--   active | past_due | paused | expired | inactive
alter table public.users
  drop constraint if exists users_membership_status_check;
alter table public.users
  add constraint users_membership_status_check
  check (membership_status in ('active','past_due','paused','expired','inactive'));

-- A signed-in user may read their own billing row and nothing else. No client
-- may write these columns — only the service role, from the webhook.
alter table public.users enable row level security;

drop policy if exists "users read own row" on public.users;
create policy "users read own row"
  on public.users for select
  using (auth.uid() = id);
