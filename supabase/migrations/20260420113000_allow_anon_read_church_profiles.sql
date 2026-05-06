-- Allow public app clients (anon role) to read church profiles without auth session
-- Generated migration: 2026-04-20

drop policy if exists "church_profiles_read_anon" on public.church_profiles;
create policy "church_profiles_read_anon"
on public.church_profiles
for select
to anon
using (true);
