const SUPABASE_URL = 'https://eknseqzppwhfidllbxli.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrbnNlcXpwcHdoZmlkbGxieGxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MTY3NzgsImV4cCI6MjA5ODI5Mjc3OH0.uRFWmJpy14bsxFtvhW6bNhr8-rUOYw99cYJ2-ULDswM';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  db: { schema: 'expense_app' }
});
