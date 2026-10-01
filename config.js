// Supabase connection for the page. The anon key is designed to be public: the database only
// lets it read what the pool rules allow and write through save_sheet(), which enforces locks.
// Supabase dashboard → Project Settings → API: "Project URL" and the "anon" / publishable key.
window.PICKEM_CONFIG = {
  supabaseUrl: "https://ayhzkwqjlvgerdbzqrdh.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5aHprd3FqbHZnZXJkYnpxcmRoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4MzY0NDgsImV4cCI6MjEwNjQxMjQ0OH0.sIw3T3yu10F6uIASQOAlYvxT0K8V147WNJwE5QUO9GA"
};
