-- Wikipedia context extracted for church profiles
-- Generated migration: 2026-04-20

create table if not exists public.church_wikipedia_context (
  list_entry bigint primary key,
  wikidata_item text,
  wikipedia_title text,
  wikipedia_url text,
  wikipedia_extract text,
  context_json jsonb not null,
  fetched_at timestamptz not null default now()
);

create index if not exists idx_church_wikipedia_context_title
  on public.church_wikipedia_context (wikipedia_title);

create index if not exists idx_church_wikipedia_context_fetched_at
  on public.church_wikipedia_context (fetched_at desc);

alter table public.church_wikipedia_context enable row level security;

drop policy if exists "church_wikipedia_context_read_authenticated" on public.church_wikipedia_context;
create policy "church_wikipedia_context_read_authenticated"
on public.church_wikipedia_context
for select
to authenticated
using (true);
