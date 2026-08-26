'use strict';

const path = require('path');
const express = require('express');
const finnhub = require('./finnhub');
const yfinance = require('./yfinance');
const { analyzeText } = require('./speculation');
const houseStockWatcher = require('./houseStockWatcher');

const app = express();
const MAX_BATCH_SYMBOLS = 60;

const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,10}$/;
const CRYPTO_RE = /^[A-Za-z0-9]{2,10}$/;

function isValidSymbol(symbol) {
  return typeof symbol === 'string' && SYMBOL_RE.test(symbol);
}

function isValidCryptoSymbol(symbol) {
  return typeof symbol === 'string' && CRYPTO_RE.test(symbol);
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// --- API routes ---

app.get('/api/quote', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  try {
    const [quote, profile] = await Promise.all([
      finnhub.getQuote(symbol),
      finnhub.getProfile(symbol).catch(() => ({})),
    ]);
    // Finnhub's free-tier profile2 doesn't cover ETFs/ETNs (e.g. AMDY) at
    // all, returning {} - backfill the missing fields from Yahoo instead of
    // leaving market cap/name/exchange blank.
    if (!profile.marketCapitalization || !profile.name) {
      try {
        const backup = await yfinance.getQuoteAndProfile(symbol);
        profile.name = profile.name || backup.profile.name;
        profile.marketCapitalization = profile.marketCapitalization || backup.profile.marketCapitalization;
        profile.exchange = profile.exchange || backup.profile.exchange;
      } catch {
        // Yahoo also has nothing - leave whatever Finnhub gave us (possibly still empty).
      }
    }
    res.json({ symbol, quote, profile, source: 'finnhub' });
  } catch (err) {
    // Finnhub down/rate-limited - fall back to Yahoo Finance rather than
    // surfacing a hard error to the client.
    try {
      const fallback = await yfinance.getQuoteAndProfile(symbol);
      res.json({ symbol, quote: fallback.quote, profile: fallback.profile, source: 'yfinance' });
    } catch {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query' });

  try {
    const result = await finnhub.searchSymbols(q);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/news', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 30);
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);

  try {
    const news = await finnhub.getCompanyNews(symbol, toDateStr(from), toDateStr(to));
    const items = (Array.isArray(news) ? news : [])
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .slice(0, limit)
      .map((item) => {
        const speculation = analyzeText(`${item.headline || ''} ${item.summary || ''}`);
        return {
          id: item.id,
          headline: item.headline,
          summary: item.summary,
          source: item.source,
          url: item.url,
          datetime: item.datetime,
          image: item.image,
          speculation,
        };
      });
    res.json({ symbol, items });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// General (not-per-symbol) stock market news for the dedicated News tab.
app.get('/api/news/market', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  try {
    const news = await finnhub.getMarketNews();
    const items = (Array.isArray(news) ? news : [])
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        headline: item.headline,
        summary: item.summary,
        source: item.source,
        url: item.url,
        datetime: item.datetime,
        image: item.image,
        speculation: analyzeText(`${item.headline || ''} ${item.summary || ''}`),
      }));
    res.json({ items });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/dividend', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  try {
    // Finnhub's dividend endpoints are premium-only on the configured key,
    // so dividend data is sourced from Yahoo Finance instead.
    const dividend = await yfinance.getDividendInfo(symbol);
    res.json(dividend);
  } catch (err) {
    res.status(502).json({ error: err.message, symbol, paysDividend: false, source: 'yfinance' });
  }
});

const VALID_PERIODS = new Set(['5d', '1mo', '3mo', '6mo', '1y']);

app.get('/api/candles', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const period = String(req.query.period || '1mo');
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  if (!VALID_PERIODS.has(period)) return res.status(400).json({ error: 'Invalid period' });

  try {
    // Finnhub's /stock/candle endpoint is premium-only on the configured key,
    // so OHLC candle data is sourced from Yahoo Finance instead.
    const result = await yfinance.getCandles(symbol, period);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message, symbol, candles: [], source: 'yfinance' });
  }
});

function recommendationConsensus(rec) {
  if (!rec) return null;
  const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = rec;
  const total = strongBuy + buy + hold + sell + strongSell;
  if (!total) return null;
  // Weighted score from -2 (strong sell) to +2 (strong buy).
  const score = (strongBuy * 2 + buy * 1 + hold * 0 + sell * -1 + strongSell * -2) / total;
  let label = 'Hold';
  if (score >= 1.2) label = 'Strong Buy';
  else if (score >= 0.4) label = 'Buy';
  else if (score <= -1.2) label = 'Strong Sell';
  else if (score <= -0.4) label = 'Sell';
  return { label, score: Math.round(score * 100) / 100 };
}

app.get('/api/predictions', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  const today = new Date();
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 120);

  try {
    const [calendar, trends] = await Promise.all([
      finnhub.getEarningsCalendar(symbol, toDateStr(today), toDateStr(horizon)).catch(() => ({ earningsCalendar: [] })),
      finnhub.getRecommendationTrends(symbol).catch(() => []),
    ]);

    const upcoming = (calendar.earningsCalendar || [])
      .filter((e) => e.date >= toDateStr(today))
      .sort((a, b) => (a.date > b.date ? 1 : -1))[0] || null;

    const latestTrend = Array.isArray(trends) && trends.length
      ? [...trends].sort((a, b) => (a.period < b.period ? 1 : -1))[0]
      : null;

    res.json({
      symbol,
      nextEarnings: upcoming && {
        date: upcoming.date,
        hour: upcoming.hour || null,
        epsEstimate: upcoming.epsEstimate,
        revenueEstimate: upcoming.revenueEstimate,
      },
      recommendation: latestTrend && {
        period: latestTrend.period,
        strongBuy: latestTrend.strongBuy,
        buy: latestTrend.buy,
        hold: latestTrend.hold,
        sell: latestTrend.sell,
        strongSell: latestTrend.strongSell,
        consensus: recommendationConsensus(latestTrend),
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/crypto/quote', async (req, res) => {
  const base = String(req.query.symbol || '').toUpperCase();
  if (!isValidCryptoSymbol(base)) return res.status(400).json({ error: 'Invalid crypto symbol' });

  try {
    const quote = await finnhub.getQuote(`BINANCE:${base}USDT`);
    if (!quote || (!quote.c && !quote.pc)) {
      return res.status(404).json({ error: `No market data for ${base}` });
    }
    res.json({ symbol: base, quote, source: 'finnhub' });
  } catch (err) {
    try {
      const fallback = await yfinance.getQuoteAndProfile(`${base}-USD`);
      res.json({ symbol: base, quote: fallback.quote, source: 'yfinance' });
    } catch {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
});

app.get('/api/crypto/candles', async (req, res) => {
  const base = String(req.query.symbol || '').toUpperCase();
  const period = String(req.query.period || '1mo');
  if (!isValidCryptoSymbol(base)) return res.status(400).json({ error: 'Invalid crypto symbol' });
  if (!VALID_PERIODS.has(period)) return res.status(400).json({ error: 'Invalid period' });

  try {
    // Finnhub's /crypto/candle endpoint is premium-only on the configured key,
    // so OHLC candle data is sourced from Yahoo Finance instead (e.g. BTC -> BTC-USD).
    const result = await yfinance.getCandles(`${base}-USD`, period);
    res.json({ ...result, symbol: base });
  } catch (err) {
    res.status(502).json({ error: err.message, symbol: base, candles: [], source: 'yfinance' });
  }
});

app.get('/api/crypto/news', async (req, res) => {
  const base = String(req.query.symbol || '').toUpperCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 50);
  if (base && !isValidCryptoSymbol(base)) return res.status(400).json({ error: 'Invalid crypto symbol' });

  try {
    const news = await finnhub.getCryptoNews();
    let items = Array.isArray(news) ? news : [];
    if (base) {
      const needle = base.toLowerCase();
      items = items.filter((item) =>
        `${item.headline || ''} ${item.summary || ''}`.toLowerCase().includes(needle));
    }
    const mapped = items
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        headline: item.headline,
        summary: item.summary,
        source: item.source,
        url: item.url,
        datetime: item.datetime,
        image: item.image,
        speculation: analyzeText(`${item.headline || ''} ${item.summary || ''}`),
      }));
    res.json({ symbol: base || null, items: mapped });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/congress', async (req, res) => {
  const raw = String(req.query.symbol || '').toUpperCase();
  const symbol = raw || null;
  if (symbol && !isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  const representative = String(req.query.rep || '').trim().slice(0, 100) || null;

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 365, 1), 3650);
  // No symbol = "who's buying what right now" feed across every ticker, capped to stay recent.
  const limit = symbol ? undefined : Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  // Filings trickle in well after the trade itself (STOCK Act allows up to 45 days),
  // so the recent feed is sorted by when it was *disclosed*, not when it was traded -
  // that's the freshest signal the public actually has.
  const dateField = symbol ? 'transaction_date' : 'disclosure_date';

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const forceRefresh = req.query.refresh === '1';

  try {
    const [trades, latestDisclosureDate] = await Promise.all([
      houseStockWatcher.getTransactions({
        symbol,
        representative,
        fromDate: toDateStr(from),
        toDate: toDateStr(to),
        limit,
        dateField,
        forceRefresh,
      }),
      houseStockWatcher.getLatestDisclosureDate(),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ symbol, available: true, trades, latestDisclosureDate });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to load congressional trades' });
  }
});

// --- Live price polling ---
// Serverless hosts (Vercel etc.) can't hold a persistent WebSocket connection
// per client, so "live" prices are delivered via the browser polling this
// batched endpoint instead of a server-pushed trade stream. finnhub.getQuote
// already caches per-symbol for a few seconds, so frequent polling across
// many clients stays well under Finnhub's rate limit.
app.get('/api/quotes-batch', async (req, res) => {
  const stocks = [...new Set(String(req.query.stocks || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(isValidSymbol))].slice(0, MAX_BATCH_SYMBOLS);
  const crypto = [...new Set(String(req.query.crypto || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(isValidCryptoSymbol))].slice(0, MAX_BATCH_SYMBOLS);

  async function safeQuote(symbol, apiSymbol, yfinanceSymbol) {
    try {
      const quote = await finnhub.getQuote(apiSymbol);
      if (quote && (quote.c || quote.pc)) return { symbol, price: quote.c, prevClose: quote.pc };
    } catch {
      // fall through to the Yahoo Finance backup below
    }
    try {
      const fallback = await yfinance.getQuoteAndProfile(yfinanceSymbol);
      return { symbol, price: fallback.quote.c, prevClose: fallback.quote.pc };
    } catch {
      return null;
    }
  }

  const [stockQuotes, cryptoQuotes] = await Promise.all([
    Promise.all(stocks.map((symbol) => safeQuote(symbol, symbol, symbol))),
    Promise.all(crypto.map((symbol) => safeQuote(symbol, `BINANCE:${symbol}USDT`, `${symbol}-USD`))),
  ]);

  res.set('Cache-Control', 'no-store');
  res.json({
    stocks: stockQuotes.filter(Boolean),
    crypto: cryptoQuotes.filter(Boolean),
  });
});

module.exports = app;
