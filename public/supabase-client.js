// Lazily creates the browser Supabase client from server-provided public
// config (/api/config). The anon key is meant to be public; row-level security
// protects the data. Returns null when Supabase isn't configured, so the app
// degrades gracefully to guest-only mode (default dashboard, no sign-in).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let clientPromise = null;

async function create() {
  let cfg;
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`config ${res.status}`);
    cfg = await res.json();
  } catch {
    return null; // backend unreachable - treat as guest-only
  }

  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;

  return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // completes the OAuth/magic-link redirect
    },
  });
}

// Memoized singleton: every caller shares one client (and one auth session).
export function getSupabase() {
  if (!clientPromise) clientPromise = create();
  return clientPromise;
}
