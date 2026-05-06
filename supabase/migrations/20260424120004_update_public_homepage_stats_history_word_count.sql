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
  with counts as (
    select
      (select count(*) from public.church_profiles) as total_churches,
      (
        select count(*)
        from public.church_profiles cp
        where cardinality(
          regexp_split_to_array(
            trim(
              regexp_replace(
                coalesce(cp.profile_json -> 'contentBlocks' ->> 'history', ''),
                '\s+',
                ' ',
                'g'
              )
            ),
            ' '
          )
        ) > 50
      ) as approved_profiles,
      (select count(*) from public.church_contributions) as contributions,
      (select count(*) from public.church_image_contributions) as images,
      (select count(*) from public.church_audio_contributions) as audio
  )
  select
    total_churches,
    approved_profiles,
    (contributions + images + audio) as community_contributions,
    (images + audio) as photos_and_media
  from counts;
$$;

revoke all on function public.get_public_homepage_stats() from public;
grant execute on function public.get_public_homepage_stats() to anon;
grant execute on function public.get_public_homepage_stats() to authenticated;
