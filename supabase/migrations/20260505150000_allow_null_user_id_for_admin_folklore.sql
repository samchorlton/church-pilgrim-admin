-- Allow admin-created folklore entries that are not tied to an authenticated user.
-- This keeps user-submitted rows unchanged while enabling admin-panel insertion.
ALTER TABLE public.church_folklore_contributions
ALTER COLUMN user_id DROP NOT NULL;

