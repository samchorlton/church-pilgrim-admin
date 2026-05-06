-- Fix admin policies that referenced auth.users directly.
-- Referencing auth.users from client role policies can trigger:
-- "permission denied for table users"
-- We use JWT email claim instead.

-- church_contributions admin policies
drop policy if exists "Admins can view all contributions" on public.church_contributions;
create policy "Admins can view all contributions"
on public.church_contributions
for select
using ((auth.jwt() ->> 'email') = 'admin@churchpilgrim.com');

drop policy if exists "Admins can update contributions" on public.church_contributions;
create policy "Admins can update contributions"
on public.church_contributions
for update
using ((auth.jwt() ->> 'email') = 'admin@churchpilgrim.com');

-- church_image_contributions admin policies
drop policy if exists "Admins can view all image contributions" on public.church_image_contributions;
create policy "Admins can view all image contributions"
on public.church_image_contributions
for select
using ((auth.jwt() ->> 'email') = 'admin@churchpilgrim.com');

drop policy if exists "Admins can update image contributions" on public.church_image_contributions;
create policy "Admins can update image contributions"
on public.church_image_contributions
for update
using ((auth.jwt() ->> 'email') = 'admin@churchpilgrim.com');

-- church_audio_contributions admin update policy
drop policy if exists "Admin can update all audio contributions" on public.church_audio_contributions;
create policy "Admin can update all audio contributions"
on public.church_audio_contributions
for update
using ((auth.jwt() ->> 'email') = 'admin@churchpilgrim.com');
