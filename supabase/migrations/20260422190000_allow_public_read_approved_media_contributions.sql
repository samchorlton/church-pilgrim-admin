-- Allow public/anon clients to read only approved contributed media.
-- This is required for unauthenticated listing pages to show community content.

grant select on public.church_image_contributions to anon;
grant select on public.church_audio_contributions to anon;

drop policy if exists "Public can read approved image contributions" on public.church_image_contributions;
create policy "Public can read approved image contributions"
on public.church_image_contributions
for select
using (status = 'approved');

drop policy if exists "Public can read approved audio contributions" on public.church_audio_contributions;
create policy "Public can read approved audio contributions"
on public.church_audio_contributions
for select
using (status = 'approved');
