'use strict';

const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const isConfigured = Boolean(supabaseUrl && serviceRoleKey);

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/$/, '');
}

function getRestUrl(path, query = '') {
  const base = normalizeBaseUrl(supabaseUrl);
  return `${base}/rest/v1/${path}${query}`;
}

async function request(path, { method = 'GET', query = '', body } = {}) {
  if (!isConfigured) {
    const err = new Error('Supabase service role integration is not configured.');
    err.status = 503;
    throw err;
  }

  const res = await fetch(getRestUrl(path, query), {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || `Supabase request failed (${res.status})`);
    err.status = res.status;
    err.details = data?.details || null;
    err.hint = data?.hint || null;
    throw err;
  }

  return data;
}

async function ensureUserProfile({ userId, email }) {
  await request('user_profiles?on_conflict=user_id', {
    method: 'POST',
    body: [{ user_id: userId, email: email || null, updated_at: new Date().toISOString() }],
  });
}

async function getUserProfile(userId) {
  const data = await request(`user_profiles?user_id=eq.${encodeURIComponent(userId)}&select=user_id,email,created_at,updated_at&limit=1`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

function sanitizeTickerList(values, regex, max = 12) {
  if (!Array.isArray(values)) return [];
  const set = new Set();
  for (const value of values) {
    const normalized = String(value || '').trim().toUpperCase();
    if (regex.test(normalized)) set.add(normalized);
    if (set.size >= max) break;
  }
  return [...set];
}

async function getWatchlists(userId) {
  const data = await request(`user_watchlists?user_id=eq.${encodeURIComponent(userId)}&select=user_id,stocks,crypto,updated_at&limit=1`);
  const row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row) return null;
  return {
    stocks: sanitizeTickerList(row.stocks, /^[A-Z0-9.\-]{1,10}$/),
    crypto: sanitizeTickerList(row.crypto, /^[A-Z0-9]{2,10}$/),
    updatedAt: row.updated_at || null,
  };
}

async function saveWatchlists(userId, { stocks, crypto }) {
  const cleanStocks = sanitizeTickerList(stocks, /^[A-Z0-9.\-]{1,10}$/);
  const cleanCrypto = sanitizeTickerList(crypto, /^[A-Z0-9]{2,10}$/);

  const data = await request('user_watchlists?on_conflict=user_id', {
    method: 'POST',
    body: [{
      user_id: userId,
      stocks: cleanStocks,
      crypto: cleanCrypto,
      updated_at: new Date().toISOString(),
    }],
  });

  const row = Array.isArray(data) && data.length ? data[0] : null;
  return {
    stocks: sanitizeTickerList(row?.stocks || cleanStocks, /^[A-Z0-9.\-]{1,10}$/),
    crypto: sanitizeTickerList(row?.crypto || cleanCrypto, /^[A-Z0-9]{2,10}$/),
    updatedAt: row?.updated_at || null,
  };
}

module.exports = {
  isConfigured,
  ensureUserProfile,
  getUserProfile,
  getWatchlists,
  saveWatchlists,
};
