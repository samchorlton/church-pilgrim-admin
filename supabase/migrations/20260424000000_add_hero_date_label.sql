-- Add optional hero date label for cathedral hero banner override.
alter table public.church_profiles
  add column if not exists hero_date_label text;

