'use strict';

const BASE_URL = 'https://finnhub.io/api/v1';

// Very small in-memory cache to stay well under Finnhub's free-tier rate limit.
const cache = new Map();

function getCached(key, ttlMs) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return entry.data;
  return null;
}

function setCached(key, data) {
  cache.set(key, { data, time: Date.now() });
}

async function finnhubRequest(path, params = {}, ttlMs = 30_000) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    throw new Error('FINNHUB_API_KEY is not set. Add it to your .env file.');
  }

  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  url.searchParams.set('token', apiKey);

  const cacheKey = url.toString();
  const cached = getCached(cacheKey, ttlMs);
  if (cached) return cached;

  const res = await fetch(url.toString());
  const body = await res.json().catch(() => ({}));

  if (!res.ok || body?.error) {
    const err = new Error(body?.error || `Finnhub request failed (${res.status})`);
    err.status = res.status;
    err.finnhubError = body?.error;
    throw err;
  }

  setCached(cacheKey, body);
  return body;
}

function getQuote(symbol) {
  return finnhubRequest('/quote', { symbol }, 15_000);
}

function getProfile(symbol) {
  return finnhubRequest('/stock/profile2', { symbol }, 6 * 60 * 60 * 1000);
}

function getCompanyNews(symbol, from, to) {
  return finnhubRequest('/company-news', { symbol, from, to }, 5 * 60 * 1000);
}

function getCongressionalTrading(symbol, from, to) {
  return finnhubRequest('/stock/congressional-trading', { symbol, from, to }, 5 * 60 * 1000);
}

function searchSymbols(query) {
  return finnhubRequest('/search', { q: query }, 60_000);
}

function getEarningsCalendar(symbol, from, to) {
  return finnhubRequest('/calendar/earnings', { symbol, from, to }, 6 * 60 * 60 * 1000);
}

function getRecommendationTrends(symbol) {
  return finnhubRequest('/stock/recommendation', { symbol }, 6 * 60 * 60 * 1000);
}

function getCryptoNews() {
  return finnhubRequest('/news', { category: 'crypto' }, 5 * 60 * 1000);
}

module.exports = {
  getQuote,
  getProfile,
  getCompanyNews,
  getCongressionalTrading,
  searchSymbols,
  getEarningsCalendar,
  getRecommendationTrends,
  getCryptoNews,
};
