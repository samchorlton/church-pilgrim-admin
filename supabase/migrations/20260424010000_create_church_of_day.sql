-- Daily featured church for consistent "Church of the Day" across all users.
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

