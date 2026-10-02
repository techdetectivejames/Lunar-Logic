-- Lunar Logic — Supabase schema (Phase 1: auth + saved dashboards)
--
-- Run this once in the Supabase SQL editor (or via the CLI) against your
-- project. It is idempotent: safe to re-run. It creates the `profiles` and
-- `dashboards` tables, row-level security policies so each user can only
-- touch their own rows, and triggers that keep `updated_at` fresh and
-- auto-provision a profile row whenever a new auth user signs up.
--
-- After running this, enable the auth providers you want in the Supabase
-- dashboard (Authentication -> Providers): Email, and Google (set its client
-- id/secret). Add your site URL + redirect URLs under Authentication -> URL
-- Configuration so OAuth redirects back to the app.

-- gen_random_uuid() lives in pgcrypto; present by default on Supabase, but be explicit.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.dashboards (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null default 'My Dashboard',
  -- Versioned layout blob. Shape is owned by the frontend (see LAYOUT_VERSION
  -- in public/app.js); keeping it as jsonb lets new widgets be added later
  -- without a schema migration.
  layout     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dashboards_user_id_idx on public.dashboards (user_id);
create index if not exists dashboards_updated_at_idx on public.dashboards (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Triggers: keep updated_at current
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists dashboards_set_updated_at on public.dashboards;
create trigger dashboards_set_updated_at
  before update on public.dashboards
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Trigger: auto-create a profile row for every new auth user
-- ---------------------------------------------------------------------------

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
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles   enable row level security;
alter table public.dashboards enable row level security;

-- profiles: a user may only read/insert/update their own row.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- dashboards: full CRUD, but only on rows the user owns.
drop policy if exists dashboards_select_own on public.dashboards;
create policy dashboards_select_own on public.dashboards
  for select using (auth.uid() = user_id);

drop policy if exists dashboards_insert_own on public.dashboards;
create policy dashboards_insert_own on public.dashboards
  for insert with check (auth.uid() = user_id);

drop policy if exists dashboards_update_own on public.dashboards;
create policy dashboards_update_own on public.dashboards
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists dashboards_delete_own on public.dashboards;
create policy dashboards_delete_own on public.dashboards
  for delete using (auth.uid() = user_id);
