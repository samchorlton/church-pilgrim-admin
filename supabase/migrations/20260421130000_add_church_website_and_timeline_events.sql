-- Add church_website and timeline_events columns to church_profiles.
--
-- church_website: official or parish website URL, populated manually or via
--   enrichment scripts. Nullable — UI shows a disabled state when absent.
--
-- timeline_events: ordered array of { year: string, event: string } objects
--   extracted from NHLE history/details text and Wikipedia context by
--   scripts/build-church-timelines.mjs. Nullable — UI shows an empty state
--   when not yet populated.

alter table public.church_profiles
  add column if not exists church_website text;

alter table public.church_profiles
  add column if not exists timeline_events jsonb;
