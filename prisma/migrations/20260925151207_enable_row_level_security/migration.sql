-- Supabase exposes the public schema through its REST Data API (PostgREST) using the
-- public "anon" key. The API talks to the database only through Prisma, as the table
-- owner, which bypasses RLS. Enabling RLS with no policies therefore blocks the Data API
-- (anon / authenticated roles) while leaving the backend unaffected.
--
-- Every later migration that creates a table must also run:
--   ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;
-- `npm run db:check-rls` lists any public table that is missing it.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
