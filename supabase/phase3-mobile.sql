-- Lunar Logic — Supabase schema (Phase 3: mobile / RevenueCat / push)
--
-- Run AFTER schema.sql and phase2-stripe.sql, once, in the Supabase SQL editor.
-- Idempotent. Adds columns so an entitlement can come from either Stripe (web)
-- or RevenueCat (iOS/Android IAP), and a push_tokens table for device tokens.

-- Track which billing provider last wrote the entitlement + the RevenueCat id.
alter table public.entitlements
  add column if not exists provider text not null default 'stripe';
alter table public.entitlements
  add column if not exists revenuecat_app_user_id text;

create index if not exists entitlements_rc_idx
  on public.entitlements (revenuecat_app_user_id);

-- Device push tokens (APNs/FCM) for Capacitor Push Notifications.
create table if not exists public.push_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  token      text not null,
  platform   text,                       -- 'ios' | 'android'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, token)
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id);

drop trigger if exists push_tokens_set_updated_at on public.push_tokens;
create trigger push_tokens_set_updated_at
  before update on public.push_tokens
  for each row execute function public.set_updated_at();

-- RLS: a user can manage only their own device tokens. (The server also writes
-- via the service_role key, which bypasses RLS.)
alter table public.push_tokens enable row level security;

drop policy if exists push_tokens_select_own on public.push_tokens;
create policy push_tokens_select_own on public.push_tokens
  for select using (auth.uid() = user_id);

drop policy if exists push_tokens_insert_own on public.push_tokens;
create policy push_tokens_insert_own on public.push_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists push_tokens_delete_own on public.push_tokens;
create policy push_tokens_delete_own on public.push_tokens
  for delete using (auth.uid() = user_id);
