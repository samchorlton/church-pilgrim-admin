alter table if exists public.user_profiles
  add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('profile-images', 'profile-images', true)
on conflict (id) do nothing;

drop policy if exists "Authenticated users can upload profile images" on storage.objects;
create policy "Authenticated users can upload profile images"
on storage.objects
for insert
with check (
  bucket_id = 'profile-images'
  and auth.role() = 'authenticated'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Public can view profile images" on storage.objects;
create policy "Public can view profile images"
on storage.objects
for select
using (bucket_id = 'profile-images');

drop policy if exists "Users can delete own profile images" on storage.objects;
create policy "Users can delete own profile images"
on storage.objects
for delete
using (
  bucket_id = 'profile-images'
  and auth.uid()::text = (storage.foldername(name))[1]
);
