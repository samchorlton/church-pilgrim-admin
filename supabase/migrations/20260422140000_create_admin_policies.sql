-- Create admin role and policies for managing contributions
-- This allows admins to view and update all contributions

-- Create admin policies for church_contributions
CREATE POLICY "Admins can view all contributions" ON church_contributions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM auth.users 
      WHERE auth.users.id = auth.uid() 
      AND auth.users.email = 'admin@churchpilgrim.com'
    )
  );

CREATE POLICY "Admins can update contributions" ON church_contributions
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM auth.users 
      WHERE auth.users.id = auth.uid() 
      AND auth.users.email = 'admin@churchpilgrim.com'
    )
  );

-- Create admin policies for church_image_contributions
CREATE POLICY "Admins can view all image contributions" ON church_image_contributions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM auth.users 
      WHERE auth.users.id = auth.uid() 
      AND auth.users.email = 'admin@churchpilgrim.com'
    )
  );

CREATE POLICY "Admins can update image contributions" ON church_image_contributions
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM auth.users 
      WHERE auth.users.id = auth.uid() 
      AND auth.users.email = 'admin@churchpilgrim.com'
    )
  );

-- Grant additional permissions to authenticated users for admin functions
GRANT UPDATE ON church_contributions TO authenticated;
GRANT UPDATE ON church_image_contributions TO authenticated;