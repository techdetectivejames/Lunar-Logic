'use strict';

const { createRemoteJWKSet, jwtVerify } = require('jose');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

const isConfigured = Boolean(supabaseUrl && supabaseAnonKey);

let jwks = null;
if (supabaseUrl) {
  const jwksUrl = new URL('/auth/v1/.well-known/jwks.json', supabaseUrl);
  jwks = createRemoteJWKSet(jwksUrl);
}

function getClientConfig() {
  if (!isConfigured) return null;
  return {
    url: supabaseUrl,
    anonKey: supabaseAnonKey,
  };
}

function parseBearerToken(headerValue) {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(String(headerValue));
  return match ? match[1] : null;
}

function hasAuthenticatedAudience(aud) {
  if (typeof aud === 'string') return aud === 'authenticated';
  if (Array.isArray(aud)) return aud.includes('authenticated');
  return false;
}

async function verifyAccessToken(token) {
  if (!isConfigured) {
    const err = new Error('Supabase auth is not configured on the server.');
    err.status = 503;
    throw err;
  }

  if (!jwks) {
    const err = new Error('Supabase JWKS endpoint is unavailable.');
    err.status = 503;
    throw err;
  }

  const issuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const { payload } = await jwtVerify(token, jwks, { issuer });

  if (!hasAuthenticatedAudience(payload.aud)) {
    const err = new Error('Token audience is invalid.');
    err.status = 401;
    throw err;
  }

  return payload;
}

async function requireAuth(req, res, next) {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const payload = await verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email || null,
      role: payload.role || null,
      claims: payload,
    };
    return next();
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || 'Unauthorized' });
  }
}

module.exports = {
  getClientConfig,
  requireAuth,
};
