-- Add folklore column to church_profiles table
ALTER TABLE public.church_profiles
ADD COLUMN IF NOT EXISTS folklore text;

-- Create enum type for folklore status
CREATE TYPE folklore_status AS ENUM ('pending', 'approved', 'rejected');

-- Create dedicated folklore table for community contributions
CREATE TABLE IF NOT EXISTS public.church_folklore_contributions (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  list_entry integer not null,
  folklore_text text not null,
  folklore_title text,
  status folklore_status not null default 'pending',
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint folklore_non_empty check (char_length(trim(folklore_text)) > 0),
  constraint folklore_max_length check (char_length(folklore_text) <= 2000)
);

-- Create index for efficient lookups
create index if not exists idx_church_folklore_contributions_list_entry
  on public.church_folklore_contributions (list_entry);

create index if not exists idx_church_folklore_contributions_status
  on public.church_folklore_contributions (status);

-- Enable row level security
alter table public.church_folklore_contributions enable row level security;

-- Policies for folklore contributions
drop policy if exists "folklore_read_anon" on public.church_folklore_contributions;
create policy "folklore_read_anon"
on public.church_folklore_contributions
for select
to anon
using (status = 'approved');

drop policy if exists "folklore_read_authenticated" on public.church_folklore_contributions;
create policy "folklore_read_authenticated"
on public.church_folklore_contributions
for select
to authenticated
using (status = 'approved' or user_id = auth.uid());

drop policy if exists "folklore_insert_authenticated" on public.church_folklore_contributions;
create policy "folklore_insert_authenticated"
on public.church_folklore_contributions
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "folklore_update_own" on public.church_folklore_contributions;
create policy "folklore_update_own"
on public.church_folklore_contributions
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Grant permissions
grant select on public.church_folklore_contributions to anon;
grant select, insert, update on public.church_folklore_contributions to authenticated;
grant usage on sequence public.church_folklore_contributions_id_seq to authenticated;
