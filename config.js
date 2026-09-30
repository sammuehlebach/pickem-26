// Supabase connection for the page. The anon key is designed to be public: the database only
// lets it read what the pool rules allow and write through save_sheet(), which enforces locks.
// Supabase dashboard → Project Settings → API: "Project URL" and the "anon" / publishable key.
window.PICKEM_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: ""
};
