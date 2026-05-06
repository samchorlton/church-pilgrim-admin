-- Add index on normalized_json district for filtering performance
-- This improves query performance when filtering churches by district

create index if not exists idx_church_profiles_normalized_district
  on public.church_profiles using gin (normalized_json)
  where normalized_json is not null;

-- Alternative: create a more specific index on just the district field
create index if not exists idx_church_profiles_district
  on public.church_profiles ((normalized_json->>'district'))
  where normalized_json->>'district' is not null;
