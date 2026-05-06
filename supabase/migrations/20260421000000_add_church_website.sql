-- Add church_website column to church_profiles.
-- Stores the official or parish website URL for a church, populated manually
-- or via enrichment scripts. Nullable — UI shows a disabled state when absent.

alter table public.church_profiles
  add column if not exists church_website text;
