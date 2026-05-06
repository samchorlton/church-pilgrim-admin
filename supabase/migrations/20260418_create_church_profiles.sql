-- Church profiles table for centralized editorial control
-- Generated migration: 2026-04-19

create table if not exists public.church_profiles (
  list_entry bigint primary key,
  source_url text,
  source_hash text,
  parser_version text,
  synthesis_version text,
  title text not null,
  subtitle text,
  summary text,
  profile_json jsonb not null,
  normalized_json jsonb,
  raw_text text,
  editorial_status text not null default 'draft',
  editorial_notes text,
  tags text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists idx_church_profiles_editorial_status
  on public.church_profiles (editorial_status);

create index if not exists idx_church_profiles_updated_at
  on public.church_profiles (updated_at desc);

alter table public.church_profiles enable row level security;

drop policy if exists "church_profiles_read_authenticated" on public.church_profiles;
create policy "church_profiles_read_authenticated"
on public.church_profiles
for select
to authenticated
using (true);
