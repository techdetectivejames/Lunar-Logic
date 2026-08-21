'use strict';

const legislators = require('./legislators');

// Public, free dataset of US House member stock transactions (no API key required).
// The original house-stock-watcher-data S3 bucket now returns AccessDenied, so this
// uses a community-maintained mirror with the same schema instead.
const DATA_URL = 'https://raw.githubusercontent.com/TattooedHead/house-stock-watcher-data/main/data/all_transactions.json';
const REFRESH_MS = 10 * 60 * 1000; // upstream mirror is updated roughly daily, but poll often enough that new filings show up promptly

let cache = { data: null, time: 0 };
let inflight = null;

async function fetchAll({ forceRefresh = false } = {}) {
  if (cache.data && !forceRefresh && Date.now() - cache.time < REFRESH_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) {
      const err = new Error(`House Stock Watcher request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    cache = { data: Array.isArray(data) ? data : [], time: Date.now() };
    return cache.data;
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

  // Without a ticker filter the dataset can span tens of thousands of rows;
  // cap it so "recent activity" stays cheap and genuinely recent.
  if (typeof limit === 'number') trades = trades.slice(0, limit);

  await Promise.all(trades.map(async (t) => {
    t.party = await legislators.getParty({ representative: t.representative, district: t.district });
  }));

  return trades;
}

// Freshest disclosure_date across the whole dataset, so the UI can show how
// current the underlying filings actually are (disclosures lag trades by law).
async function getLatestDisclosureDate() {
  const all = await fetchAll();
  let latest = 0;
  for (const t of all) {
    const time = parseDate(t.disclosure_date);
    if (time > latest) latest = time;
  }
  return latest ? new Date(latest).toISOString().slice(0, 10) : null;
}

// Proactive recurring sync: the STOCK Act gives members up to 45 days to
// disclose a trade, so there is no such thing as "real-time" congressional
// trading data - a periodic re-check of the disclosure feed is genuinely the
// freshest this can ever be. Rather than only refreshing lazily on whichever
// request happens to arrive after the cache goes stale (leaving that one
// request to eat the fetch latency), proactively re-fetch on an interval so
// the cache is always warm and new filings surface promptly.
let syncTimer = null;

async function syncNow() {
  try {
    const data = await fetchAll({ forceRefresh: true });
    console.log(`[houseStockWatcher] synced ${data.length} transactions at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[houseStockWatcher] background sync failed:', err.message);
  }
}

function startSync() {
  if (syncTimer) return syncTimer;
  syncNow(); // warm the cache immediately on boot instead of waiting for the first request
  syncTimer = setInterval(syncNow, REFRESH_MS);
  if (typeof syncTimer.unref === 'function') syncTimer.unref(); // don't keep the process alive solely for this timer
  return syncTimer;
}

function stopSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

module.exports = { getTransactions, getLatestDisclosureDate, startSync, stopSync };

