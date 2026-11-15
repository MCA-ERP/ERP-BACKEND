// Unit tests never touch a real database; these placeholders only let the Supabase client be constructed.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.NODE_ENV = "test";
