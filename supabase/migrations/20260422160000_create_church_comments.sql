-- Per-listing community comments
create table if not exists public.church_comments (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  list_entry integer not null,
  display_name text,
  comment_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint church_comments_non_empty_comment check (char_length(trim(comment_text)) > 0),
  constraint church_comments_max_length check (char_length(comment_text) <= 500)
);

create index if not exists idx_church_comments_list_entry_created
  on public.church_comments (list_entry, created_at desc);

alter table public.church_comments enable row level security;

drop policy if exists "church_comments_read_anon" on public.church_comments;
create policy "church_comments_read_anon"
on public.church_comments
for select
to anon
using (true);

drop policy if exists "church_comments_read_authenticated" on public.church_comments;
create policy "church_comments_read_authenticated"
on public.church_comments
for select
to authenticated
using (true);

drop policy if exists "church_comments_insert_authenticated" on public.church_comments;
create policy "church_comments_insert_authenticated"
on public.church_comments
for insert
to authenticated
with check (auth.uid() = user_id);

grant select on public.church_comments to anon;
grant select, insert on public.church_comments to authenticated;
grant usage on sequence public.church_comments_id_seq to authenticated;
