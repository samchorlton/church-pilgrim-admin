-- Run this in Supabase SQL editor.
-- Central editable store for church profiles.

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
  church_website text,
  hero_date_label text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_church_profiles_editorial_status
  on public.church_profiles (editorial_status);

create index if not exists idx_church_profiles_updated_at
  on public.church_profiles (updated_at desc);

alter table public.church_profiles enable row level security;

-- Lock down table to authenticated reads only (adjust for your needs).
drop policy if exists "church_profiles_read_authenticated" on public.church_profiles;
create policy "church_profiles_read_authenticated"
on public.church_profiles
for select
to authenticated
using (true);

drop policy if exists "church_profiles_read_anon" on public.church_profiles;
create policy "church_profiles_read_anon"
on public.church_profiles
for select
to anon
using (true);

-- Additional enrichment outputs
create table if not exists public.church_normalized_records (
  nhle_id bigint primary key,
  source_url text not null,
  parser_version text not null,
  seed_title text not null,
  official_name text not null,
  display_name text not null,
  is_probably_church boolean not null default false,
  church_reasons text[] not null default '{}',
  heritage_category text,
  grade text,
  date_first_listed text,
  date_amended text,
  county text,
  district text,
  parish text,
  location_description text,
  national_grid_reference text,
  latitude double precision,
  longitude double precision,
  summary text,
  history_text text,
  details_text text,
  reasons_for_designation text[],
  extracted_facts text[] not null default '{}',
  source_attribution text not null,
  completeness_score integer not null default 0,
  normalized_json jsonb not null,
  normalized_at timestamptz not null default now()
);

create table if not exists public.church_evidence_packets (
  nhle_id bigint primary key,
  source_url text not null,
  name text not null,
  facts text[] not null default '{}',
  warnings text[] not null default '{}',
  packet_json jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.church_wikipedia_context (
  list_entry bigint primary key,
  wikidata_item text,
  wikipedia_title text,
  wikipedia_url text,
  wikipedia_extract text,
  context_json jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists public.church_of_day (
  feature_date date primary key,
  list_entry bigint not null references public.church_profiles(list_entry) on delete cascade,
  rich_summary text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_church_of_day_list_entry
  on public.church_of_day (list_entry);

alter table public.church_of_day enable row level security;

drop policy if exists "church_of_day_read_authenticated" on public.church_of_day;
create policy "church_of_day_read_authenticated"
on public.church_of_day
for select
to authenticated
using (true);

drop policy if exists "church_of_day_read_anon" on public.church_of_day;
create policy "church_of_day_read_anon"
on public.church_of_day
for select
to anon
using (true);
