create or replace function public.get_public_homepage_stats()
returns table (
  total_churches bigint,
  approved_profiles bigint,
  community_contributions bigint,
  photos_and_media bigint
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from public.church_profiles) as total_churches,
    (select count(*) from public.church_profiles where editorial_status = 'live') as approved_profiles,
    (select count(*) from public.church_contributions) as community_contributions,
    (
      (select count(*) from public.church_image_contributions) +
      (select count(*) from public.church_audio_contributions) +
      (select count(*) from public.church_contributions)
    ) as photos_and_media;
$$;

revoke all on function public.get_public_homepage_stats() from public;
grant execute on function public.get_public_homepage_stats() to anon;
grant execute on function public.get_public_homepage_stats() to authenticated;
