'use strict';

// Pure Node.js Yahoo Finance client (no Python subprocess), so this works in
// serverless environments like Vercel where a Python runtime isn't available.
const YahooFinance = require('yahoo-finance2').default;

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// A full dashboard load fires a quote + candles + dividend lookup per watched
// symbol, all at once. That burst reliably trips Yahoo's own rate limiting,
// so cap concurrency and retry transient 429s with backoff, same as finnhub.js.
const MAX_CONCURRENT_REQUESTS = 4;
let activeRequests = 0;
const requestQueue = [];

function runQueued() {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS || requestQueue.length === 0) return;
  activeRequests += 1;
  const { task, resolve, reject } = requestQueue.shift();
  task().then(resolve, reject).finally(() => {
    activeRequests -= 1;
    runQueued();
  });
}

function withConcurrencyLimit(task) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ task, resolve, reject });
    runQueued();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RETRIES_ON_429 = 2;
const RETRY_BASE_DELAY_MS = 500;

function isRateLimitError(err) {
  return /429|too many requests/i.test(err?.message || '');
}

async function withRetry(fn) {
  for (let attempt = 0; attempt <= MAX_RETRIES_ON_429; attempt += 1) {
    try {
      return await withConcurrencyLimit(fn);
    } catch (err) {
      if (!isRateLimitError(err) || attempt === MAX_RETRIES_ON_429) throw err;
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }
}

function withCache(cache, key, ttlMs, fn) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return Promise.resolve(entry.data);
  return withRetry(fn)
    .then((data) => {
      cache.set(key, { data, time: Date.now() });
      return data;
    })
    .catch((err) => {
      // Rate-limited or transient failure - serve the last known value if we have one.
      if (entry) return entry.data;
      throw err;
    });
}

function toDateStr(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function round4(n) {
  return typeof n === 'number' ? Math.round(n * 10000) / 10000 : n;
}

function classifyFrequency(count) {
  if (count === 0) return 'No recent dividend';
  if (count === 1) return 'Annual';
  if (count === 2) return 'Semi-Annual';
  if (count >= 3 && count <= 6) return 'Quarterly';
  if (count >= 10 && count <= 15) return 'Monthly';
  if (count >= 40) return 'Weekly';
  return 'Irregular';
}

const dividendCache = new Map();
const DIVIDEND_TTL_MS = 6 * 60 * 60 * 1000; // dividend schedules rarely change intraday

function getDividendInfo(symbol) {
  return withCache(dividendCache, symbol, DIVIDEND_TTL_MS, async () => {
    const [summary, chart] = await Promise.all([
      yahooFinance.quoteSummary(symbol, { modules: ['summaryDetail', 'defaultKeyStatistics'] }),
      yahooFinance
        .chart(symbol, { period1: new Date(Date.now() - 370 * 24 * 60 * 60 * 1000), interval: '1d', events: 'div' })
        .catch(() => ({ events: {} })),
    ]);

    const recent = chart.events?.dividends || [];
    const summaryRate = summary.summaryDetail?.dividendRate;
    // Fall back to summing trailing dividend history when the summary field is
    // missing, which happens often for actively-managed income ETFs.
    const dividendRate = summaryRate ?? (recent.length ? round4(recent.reduce((sum, d) => sum + d.amount, 0)) : null);
    const paysDividend = Boolean(summaryRate) || recent.length > 0;

    let lastValue = summary.defaultKeyStatistics?.lastDividendValue ?? null;
    let lastDate = toDateStr(summary.defaultKeyStatistics?.lastDividendDate);
    if ((lastValue == null || lastDate == null) && recent.length) {
      const last = recent[recent.length - 1];
      lastValue = lastValue ?? round4(last.amount);
      lastDate = lastDate || toDateStr(last.date);
    }

    const payoutRatio = summary.summaryDetail?.payoutRatio;

    return {
      symbol: symbol.toUpperCase(),
      paysDividend,
      // Yield is computed client-side from this + the live quote price.
      dividendPerShareAnnual: dividendRate ?? null,
      payoutRatioPct: typeof payoutRatio === 'number' ? Math.round(payoutRatio * 10000) / 100 : null,
      lastDividendValue: lastValue,
      lastDividendDate: lastDate,
      exDividendDate: toDateStr(summary.summaryDetail?.exDividendDate),
      frequency: classifyFrequency(recent.length),
      source: 'yfinance',
    };
  });
}

const quoteCache = new Map();
const QUOTE_TTL_MS = 15_000;

// Backup quote source used when Finnhub is unavailable/rate-limited. Field
// names are mapped to match Finnhub's { c, d, dp, h, l, o, pc, t } shape so
// callers can treat either source interchangeably.
function getQuoteAndProfile(symbol) {
  return withCache(quoteCache, symbol, QUOTE_TTL_MS, async () => {
    const q = await yahooFinance.quote(symbol);
    if (!q || q.regularMarketPrice == null) throw new Error(`No quote data for ${symbol}`);

    return {
      quote: {
        c: q.regularMarketPrice,
        d: q.regularMarketChange ?? null,
        dp: q.regularMarketChangePercent ?? null,
        h: q.regularMarketDayHigh ?? null,
        l: q.regularMarketDayLow ?? null,
        o: q.regularMarketOpen ?? null,
        pc: q.regularMarketPreviousClose ?? null,
        t: q.regularMarketTime ? Math.floor(new Date(q.regularMarketTime).getTime() / 1000) : null,
      },
      profile: {
        name: q.longName || q.shortName || symbol,
        marketCapitalization: typeof q.marketCap === 'number' ? round4(q.marketCap / 1_000_000) : null,
        exchange: q.fullExchangeName || q.exchange || null,
      },
      source: 'yfinance',
    };
  });
}

const PERIOD_DAYS = { '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365 };
const candlesCache = new Map();
const CANDLES_TTL_MS = 5 * 60 * 1000;

function getCandles(symbol, period) {
  const cacheKey = `${symbol}|${period}`;
  return withCache(candlesCache, cacheKey, CANDLES_TTL_MS, async () => {
    const days = PERIOD_DAYS[period] || 30;
    const result = await yahooFinance.chart(symbol, {
      period1: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
      interval: '1d',
    });

    const candles = (result.quotes || [])
      .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
      .map((q) => ({
        t: toDateStr(q.date),
        o: round4(q.open),
        h: round4(q.high),
        l: round4(q.low),
        c: round4(q.close),
        v: q.volume || 0,
      }));

    return { symbol: symbol.toUpperCase(), candles, source: 'yfinance' };
  });
}

module.exports = { getDividendInfo, getQuoteAndProfile, getCandles };

