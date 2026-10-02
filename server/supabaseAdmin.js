'use strict';

const { createClient } = require('@supabase/supabase-js');

// Server-only Supabase client using the SERVICE ROLE key. This bypasses RLS, so
// it must NEVER be exposed to the browser. Used to verify user JWTs, read/write
// entitlements, and reconcile Stripe webhook events. Returns null when unset so
// the app degrades to "no server-side gating" (everything open) — matching the
// guest-only fallback used elsewhere.
let admin = null;

function getAdmin() {
  if (admin) return admin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}

module.exports = { getAdmin };
