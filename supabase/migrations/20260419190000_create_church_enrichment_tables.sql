-- Church enrichment outputs: normalized records and LLM-ready evidence packets
-- Generated migration: 2026-04-19

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

create index if not exists idx_church_normalized_grade
  on public.church_normalized_records (grade);

create index if not exists idx_church_normalized_completeness
  on public.church_normalized_records (completeness_score desc);

create index if not exists idx_church_evidence_updated_at
  on public.church_evidence_packets (updated_at desc);

alter table public.church_normalized_records enable row level security;
alter table public.church_evidence_packets enable row level security;

drop policy if exists "church_normalized_read_authenticated" on public.church_normalized_records;
create policy "church_normalized_read_authenticated"
on public.church_normalized_records
for select
to authenticated
using (true);

drop policy if exists "church_evidence_read_authenticated" on public.church_evidence_packets;
create policy "church_evidence_read_authenticated"
on public.church_evidence_packets
for select
to authenticated
using (true);
