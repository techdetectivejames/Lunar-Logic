'use strict';

const legislators = require('./legislators');

// Senate members don't disclose via the House Clerk's system, and there is no
// free, actively-maintained mirror of the old Senate Stock Watcher dataset
// (the original S3 bucket is dead, its GitHub source hasn't been touched since
// 2021). Bargo's free Congress Trades API normalizes both chambers from the
// official House Clerk + Senate eFD filings, so it's used here purely to fill
// the Senate gap (House still comes from server/houseStockWatcher.js, which
// has much deeper history than Bargo's rolling 3-month window).
// https://www.bargo.ai/free-apis/congress - free tier requires visible
// attribution (see public/index.html) and forbids bulk redistribution of raw
// records, both of which are respected by only ever serving live, per-request
// results instead of re-publishing the dataset.
const API_BASE = 'https://www.bargo.ai/free-apis/congress/v1';
// Keyless fair-use is 30 requests/day per IP; a free BARGO_API_KEY (no card
// required, see README) raises that to 100/day. Either way, a single shared
// server-side cache refreshed a few times a day (not per browser request)
// stays well under budget.
const REFRESH_MS = 6 * 60 * 60 * 1000;

let cache = { data: null, time: 0 };
let inflight = null;

function authHeaders() {
  const key = process.env.BARGO_API_KEY;
  return key ? { 'X-Api-Key': key } : {};
}

// Bargo returns ISO (YYYY-MM-DD); the rest of this app's congress data (and
// the client's date rendering) uses MM/DD/YYYY, so normalize on the way in.
function toMDY(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function normalize(t) {
  const amountMid = (typeof t.amount_low === 'number' && typeof t.amount_high === 'number')
    ? (t.amount_low + t.amount_high) / 2
    : null;
  return {
    transaction_date: toMDY(t.transaction_date),
    disclosure_date: toMDY(t.disclosure_date),
    ticker: t.ticker || null,
    asset_description: t.asset || '',
    asset_type: 'Stock',
    type: t.type || null,
    amount: t.amount_range || null,
    amount_mid: amountMid,
    representative: t.member || null,
    district: t.state || null,
    owner: null,
    filing_id: null,
    source_url: t.filing_portal || null,
    chamber: 'senate',
  };
}

async function fetchPage(page) {
  const url = new URL(`${API_BASE}/trades`);
  url.searchParams.set('chamber', 'senate');
  url.searchParams.set('limit', '100');
  url.searchParams.set('page', String(page));
  const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(`Bargo Congress Trades API request failed (${res.status})`);
    err.status = res.status === 429 ? 429 : res.status;
    throw err;
  }
  return res.json();
}

async function fetchAll({ forceRefresh = false } = {}) {
  if (cache.data && !forceRefresh && Date.now() - cache.time < REFRESH_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const page = await fetchPage(0);
      const trades = (page.trades || []).map(normalize);
      cache = { data: trades, time: Date.now() };
      return cache.data;
    } catch (err) {
      // Free-tier fair-use exceeded or upstream hiccup - keep serving whatever
      // we last had rather than blanking out the whole Senate feed.
      if (cache.data) return cache.data;
      throw err;
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

function parseDate(str) {
  const t = Date.parse(str);
  return Number.isNaN(t) ? 0 : t;
}

async function getTransactions({ symbol, representative, fromDate, toDate, limit, dateField = 'transaction_date', forceRefresh } = {}) {
  const all = await fetchAll({ forceRefresh });
  const ticker = symbol ? String(symbol).toUpperCase() : null;
  const repQuery = representative ? String(representative).trim().toLowerCase() : null;
  const fromTime = fromDate ? new Date(fromDate).getTime() : -Infinity;
  const toTime = toDate ? new Date(toDate).getTime() + 24 * 60 * 60 * 1000 - 1 : Infinity;

  let trades = all
    .filter((t) => {
      if (ticker && String(t.ticker || '').toUpperCase() !== ticker) return false;
      if (repQuery && !String(t.representative || '').toLowerCase().includes(repQuery)) return false;
      const time = parseDate(t[dateField]);
      return time >= fromTime && time <= toTime;
    })
    .sort((a, b) => parseDate(b[dateField]) - parseDate(a[dateField]));

  if (typeof limit === 'number') trades = trades.slice(0, limit);

  await Promise.all(trades.map(async (t) => {
    t.party = await legislators.getParty({ representative: t.representative, district: t.district });
  }));

  return trades;
}

async function getLatestDisclosureDate() {
  const all = await fetchAll();
  let latest = 0;
  for (const t of all) {
    const time = parseDate(t.disclosure_date);
    if (time > latest) latest = time;
  }
  return latest ? new Date(latest).toISOString().slice(0, 10) : null;
}

let syncTimer = null;

async function syncNow() {
  try {
    const data = await fetchAll({ forceRefresh: true });
    console.log(`[senateTrades] synced ${data.length} transactions at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[senateTrades] background sync failed:', err.message);
  }
}

function startSync() {
  if (syncTimer) return syncTimer;
  syncNow();
  syncTimer = setInterval(syncNow, REFRESH_MS);
  if (typeof syncTimer.unref === 'function') syncTimer.unref();
  return syncTimer;
}

function stopSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

module.exports = { getTransactions, getLatestDisclosureDate, startSync, stopSync };
