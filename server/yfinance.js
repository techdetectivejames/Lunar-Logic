'use strict';

// Pure Node.js Yahoo Finance client (no Python subprocess), so this works in
// serverless environments like Vercel where a Python runtime isn't available.
const YahooFinance = require('yahoo-finance2').default;

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

function withCache(cache, key, ttlMs, fn) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < ttlMs) return Promise.resolve(entry.data);
  return fn().then((data) => {
    cache.set(key, { data, time: Date.now() });
    return data;
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

module.exports = { getDividendInfo, getCandles };

