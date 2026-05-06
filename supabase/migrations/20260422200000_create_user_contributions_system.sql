-- Create user profiles table
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create contributions table for text updates
CREATE TABLE IF NOT EXISTS church_contributions (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  list_entry INTEGER NOT NULL,
  contribution_type TEXT NOT NULL CHECK (contribution_type IN ('overview', 'history', 'architecture', 'timeline_event')),
  current_content TEXT,
  suggested_content TEXT NOT NULL,
  timeline_year TEXT, -- Only used for timeline_event type
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create image contributions table
CREATE TABLE IF NOT EXISTS church_image_contributions (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  list_entry INTEGER NOT NULL,
  image_url TEXT NOT NULL,
  image_caption TEXT,
  image_credit TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_church_contributions_list_entry ON church_contributions(list_entry);
CREATE INDEX IF NOT EXISTS idx_church_contributions_user_id ON church_contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_church_contributions_status ON church_contributions(status);
CREATE INDEX IF NOT EXISTS idx_church_image_contributions_list_entry ON church_image_contributions(list_entry);
CREATE INDEX IF NOT EXISTS idx_church_image_contributions_user_id ON church_image_contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_church_image_contributions_status ON church_image_contributions(status);

-- Row Level Security policies
-- Users can read their own profiles
DROP POLICY IF EXISTS "Users can read own profile" ON user_profiles;
CREATE POLICY "Users can read own profile" ON user_profiles
  FOR SELECT USING (auth.uid() = id);

-- Users can update their own profiles
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
CREATE POLICY "Users can update own profile" ON user_profiles
  FOR UPDATE USING (auth.uid() = id);

-- Users can insert their own profile
DROP POLICY IF EXISTS "Users can insert own profile" ON user_profiles;
CREATE POLICY "Users can insert own profile" ON user_profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Users can read their own contributions
DROP POLICY IF EXISTS "Users can read own contributions" ON church_contributions;
CREATE POLICY "Users can read own contributions" ON church_contributions
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own contributions
DROP POLICY IF EXISTS "Users can insert own contributions" ON church_contributions;
CREATE POLICY "Users can insert own contributions" ON church_contributions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can read their own image contributions
DROP POLICY IF EXISTS "Users can read own image contributions" ON church_image_contributions;
CREATE POLICY "Users can read own image contributions" ON church_image_contributions
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own image contributions
DROP POLICY IF EXISTS "Users can insert own image contributions" ON church_image_contributions;
CREATE POLICY "Users can insert own image contributions" ON church_image_contributions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Enable RLS on all tables
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE church_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE church_image_contributions ENABLE ROW LEVEL SECURITY;

-- Grant permissions to authenticated users
GRANT SELECT, INSERT, UPDATE ON user_profiles TO authenticated;
GRANT SELECT, INSERT ON church_contributions TO authenticated;
GRANT SELECT, INSERT ON church_image_contributions TO authenticated;
DO $$
BEGIN
  IF to_regclass('public.church_contributions_id_seq') IS NOT NULL THEN
    GRANT USAGE ON SEQUENCE church_contributions_id_seq TO authenticated;
  END IF;
  IF to_regclass('public.church_image_contributions_id_seq') IS NOT NULL THEN
    GRANT USAGE ON SEQUENCE church_image_contributions_id_seq TO authenticated;
  END IF;
END $$;
