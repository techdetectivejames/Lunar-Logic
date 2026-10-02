-- Lunar Logic — Supabase schema (Phase 2: Stripe paywall / entitlements)
--
-- Run this AFTER supabase/schema.sql, once, in the Supabase SQL editor. It is
-- idempotent. It adds the `entitlements` table (one row per user holding their
-- plan + subscription status), row-level security so a user can only READ their
-- own entitlement (all writes happen server-side via the Stripe webhook using
-- the service_role key, which bypasses RLS), and extends handle_new_user() to
-- provision a free entitlement row on signup.

create table if not exists public.entitlements (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  -- 'free' | 'premium'
  plan                   text not null default 'free',
  -- Mirrors Stripe subscription status: active, trialing, past_due, canceled,
  -- unpaid, incomplete, incomplete_expired, or 'inactive' when there's no sub.
  status                 text not null default 'inactive',
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists entitlements_customer_idx on public.entitlements (stripe_customer_id);

drop trigger if exists entitlements_set_updated_at on public.entitlements;
create trigger entitlements_set_updated_at
  before update on public.entitlements
  for each row execute function public.set_updated_at();

-- Extend new-user provisioning to also create a free entitlement row.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(coalesce(new.email, ''), '@', 1)
    )
  )
  on conflict (id) do nothing;

  insert into public.entitlements (user_id, plan, status)
  values (new.id, 'free', 'inactive')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill entitlement rows for users that signed up before this migration.
insert into public.entitlements (user_id, plan, status)
select id, 'free', 'inactive' from auth.users
on conflict (user_id) do nothing;

-- Row-level security: users may read ONLY their own entitlement. There are no
-- insert/update/delete policies, so the anon/authenticated roles can't write;
-- the server's service_role key (which bypasses RLS) is the only writer.
alter table public.entitlements enable row level security;

drop policy if exists entitlements_select_own on public.entitlements;
create policy entitlements_select_own on public.entitlements
  for select using (auth.uid() = user_id);
