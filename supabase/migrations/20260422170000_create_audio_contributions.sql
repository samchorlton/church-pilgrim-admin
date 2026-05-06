-- Audio guide contributions submitted by users
create table if not exists public.church_audio_contributions (
  id serial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  list_entry integer not null,
  audio_url text not null,
  audio_title text,
  audio_credit text,
  file_name text,
  mime_type text,
  file_size_bytes bigint,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_church_audio_contributions_list_entry
  on public.church_audio_contributions (list_entry);
create index if not exists idx_church_audio_contributions_user_id
  on public.church_audio_contributions (user_id);
create index if not exists idx_church_audio_contributions_status
  on public.church_audio_contributions (status);

alter table public.church_audio_contributions enable row level security;

drop policy if exists "Users can read own audio contributions" on public.church_audio_contributions;
create policy "Users can read own audio contributions"
on public.church_audio_contributions
for select
using (auth.uid() = user_id);

drop policy if exists "Users can insert own audio contributions" on public.church_audio_contributions;
create policy "Users can insert own audio contributions"
on public.church_audio_contributions
for insert
with check (auth.uid() = user_id);

drop policy if exists "Admin can update all audio contributions" on public.church_audio_contributions;
create policy "Admin can update all audio contributions"
on public.church_audio_contributions
for update
using (
  exists (
    select 1
    from auth.users
    where auth.users.id = auth.uid()
      and auth.users.email = 'admin@churchpilgrim.com'
  )
);

grant select, insert on public.church_audio_contributions to authenticated;
grant update on public.church_audio_contributions to authenticated;
grant usage on sequence public.church_audio_contributions_id_seq to authenticated;

-- Storage bucket for contributed audio guides
insert into storage.buckets (id, name, public)
values ('church-audio', 'church-audio', true)
on conflict (id) do nothing;

drop policy if exists "Authenticated users can upload audio" on storage.objects;
create policy "Authenticated users can upload audio"
on storage.objects
for insert
with check (
  bucket_id = 'church-audio'
  and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Public can view audio" on storage.objects;
create policy "Public can view audio"
on storage.objects
for select
using (bucket_id = 'church-audio');

drop policy if exists "Users can delete own audio" on storage.objects;
create policy "Users can delete own audio"
on storage.objects
for delete
using (
  bucket_id = 'church-audio'
  and auth.uid()::text = (storage.foldername(name))[1]
);
