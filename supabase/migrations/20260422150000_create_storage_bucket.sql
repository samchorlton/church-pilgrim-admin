-- Create storage bucket for church images
INSERT INTO storage.buckets (id, name, public)
VALUES ('church-images', 'church-images', true);

-- Create storage policies
-- Allow authenticated users to upload images
CREATE POLICY "Authenticated users can upload images" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'church-images' 
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- Allow public read access to approved images
CREATE POLICY "Public can view images" ON storage.objects
  FOR SELECT USING (bucket_id = 'church-images');

-- Allow users to delete their own images
CREATE POLICY "Users can delete own images" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'church-images' 
    AND auth.uid()::text = (storage.foldername(name))[1]
  );