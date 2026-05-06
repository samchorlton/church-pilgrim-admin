-- Add timeline_events column to church_profiles.
-- Stores an ordered array of { year: string, event: string } objects
-- extracted from NHLE history/details text and Wikipedia context.

alter table public.church_profiles
  add column if not exists timeline_events jsonb;
