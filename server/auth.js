'use strict';

const { getAdmin } = require('./supabaseAdmin');
const { getEntitlement, isPremiumActive } = require('./entitlements');
const { featureTier } = require('./featureFlags');

// Short-lived cache of verified tokens so a burst of API calls from one client
// doesn't hit Supabase Auth's getUser endpoint on every request. Per-process
// (fine for serverless warm instances); cleared implicitly when the TTL lapses.
const tokenCache = new Map(); // token -> { user, exp }
const TOKEN_TTL_MS = 60_000;

// Server-side gating is only enforced when the admin client is configured;
// otherwise the app behaves like the guest-only fallback (nothing gated).
function gateActive() {
  return !!getAdmin();
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

async function verifyToken(token) {
  if (!token) return null;
  const cached = tokenCache.get(token);
  if (cached && cached.exp > Date.now()) return cached.user;
  const admin = getAdmin();
  if (!admin) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data || !data.user) return null;
  tokenCache.set(token, { user: data.user, exp: Date.now() + TOKEN_TTL_MS });
  return data.user;
}

// Attaches req.user + req.entitlement when a valid bearer token is present.
// Never rejects — anonymous requests simply proceed without a user.
async function withUser(req, _res, next) {
  try {
    const user = await verifyToken(bearerToken(req));
    if (user) {
      req.user = user;
      req.entitlement = await getEntitlement(user.id);
    }
  } catch {
    /* treat as guest */
  }
  next();
}

// Enforces a signed-in user (used by billing endpoints). Always enforces,
// regardless of gateActive(), since these endpoints are meaningless anonymously.
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required', authRequired: true });
  next();
}

// Gates a route by feature id, matching the tiers in featureFlags.js.
function requireFeature(featureId) {
  return (req, res, next) => {
    if (!gateActive()) return next(); // standalone mode: nothing gated
    const tier = featureTier(featureId);
    if (tier === 'public') return next();
    if (!req.user) {
      return res.status(401).json({ error: 'Sign in required', authRequired: true, feature: featureId });
    }
    if (tier === 'premium' && !isPremiumActive(req.entitlement)) {
      return res.status(403).json({ error: 'Premium plan required', upgradeRequired: true, feature: featureId });
    }
    next();
  };
}

module.exports = { withUser, requireUser, requireFeature, verifyToken, gateActive };
