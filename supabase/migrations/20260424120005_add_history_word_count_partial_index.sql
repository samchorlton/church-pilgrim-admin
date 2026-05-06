-- Speeds up get_public_homepage_stats() approved_profiles count
-- where approved_profiles is defined as history content > 50 words.
create index if not exists idx_church_profiles_history_words_gt_50
  on public.church_profiles (list_entry)
  where cardinality(
    regexp_split_to_array(
      trim(
        regexp_replace(
          coalesce(profile_json -> 'contentBlocks' ->> 'history', ''),
          '\s+',
          ' ',
          'g'
        )
      ),
      ' '
    )
  ) > 50;
