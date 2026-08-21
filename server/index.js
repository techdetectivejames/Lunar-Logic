'use strict';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const finnhub = require('./finnhub');
const yfinance = require('./yfinance');
const { analyzeText } = require('./speculation');
const FinnhubSocket = require('./finnhubSocket');
const houseStockWatcher = require('./houseStockWatcher');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_STREAM_SYMBOLS_PER_CLIENT = 60;

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
    res.json({ symbol, quote, profile });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);

  try {
    const news = await finnhub.getCompanyNews(symbol, toDateStr(from), toDateStr(to));
    const items = (Array.isArray(news) ? news : [])
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .slice(0, 8)
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

app.get('/api/dividend', async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  try {
    // Finnhub's dividend endpoints are premium-only on the configured key,
    // so dividend data is sourced from yfinance instead.
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
    // so OHLC candle data is sourced from yfinance instead.
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
    res.json({ symbol: base, quote });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/crypto/candles', async (req, res) => {
  const base = String(req.query.symbol || '').toUpperCase();
  const period = String(req.query.period || '1mo');
  if (!isValidCryptoSymbol(base)) return res.status(400).json({ error: 'Invalid crypto symbol' });
  if (!VALID_PERIODS.has(period)) return res.status(400).json({ error: 'Invalid period' });

  try {
    // Finnhub's /crypto/candle endpoint is premium-only on the configured key,
    // so OHLC candle data is sourced from yfinance instead (e.g. BTC -> BTC-USD).
    const result = await yfinance.getCandles(`${base}-USD`, period);
    res.json({ ...result, symbol: base });
  } catch (err) {
    res.status(502).json({ error: err.message, symbol: base, candles: [], source: 'yfinance' });
  }
});

app.get('/api/crypto/news', async (req, res) => {
  const base = String(req.query.symbol || '').toUpperCase();
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
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        headline: item.headline,
        summary: item.summary,
        source: item.source,
        url: item.url,
        datetime: item.datetime,
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

// --- Real-time trade stream (WebSocket proxy over Finnhub's trade feed) ---

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const finnhubSocket = new FinnhubSocket(process.env.FINNHUB_API_KEY);
const streamSubscribers = new Map(); // streamSymbol -> Set<ws>

function toStreamSymbol(symbol, assetType) {
  return assetType === 'crypto' ? `BINANCE:${symbol}USDT` : symbol;
}

function fromStreamSymbol(streamSymbol) {
  if (streamSymbol.startsWith('BINANCE:') && streamSymbol.endsWith('USDT')) {
    return { assetType: 'crypto', symbol: streamSymbol.slice(8, -4) };
  }
  return { assetType: 'stock', symbol: streamSymbol };
}

finnhubSocket.on('trade', (streamSymbol, price, timestamp) => {
  const subs = streamSubscribers.get(streamSymbol);
  if (!subs || !subs.size) return;
  const { assetType, symbol } = fromStreamSymbol(streamSymbol);
  const payload = JSON.stringify({ type: 'trade', symbol, assetType, price, timestamp });
  for (const client of subs) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
});

wss.on('connection', (ws) => {
  const mySymbols = new Set(); // streamSymbols this client is subscribed to

  function subscribeOne(rawSymbol, assetType) {
    if (mySymbols.size >= MAX_STREAM_SYMBOLS_PER_CLIENT) return;
    const symbol = String(rawSymbol || '').toUpperCase();
    const valid = assetType === 'crypto' ? isValidCryptoSymbol(symbol) : isValidSymbol(symbol);
    if (!valid) return;

    const streamSymbol = toStreamSymbol(symbol, assetType);
    if (mySymbols.has(streamSymbol)) return;
    mySymbols.add(streamSymbol);

    if (!streamSubscribers.has(streamSymbol)) streamSubscribers.set(streamSymbol, new Set());
    streamSubscribers.get(streamSymbol).add(ws);
    finnhubSocket.subscribe(streamSymbol);
  }

  function unsubscribeOne(rawSymbol, assetType) {
    const symbol = String(rawSymbol || '').toUpperCase();
    const streamSymbol = toStreamSymbol(symbol, assetType);
    if (!mySymbols.has(streamSymbol)) return;
    mySymbols.delete(streamSymbol);

    const subs = streamSubscribers.get(streamSymbol);
    if (subs) {
      subs.delete(ws);
      if (!subs.size) streamSubscribers.delete(streamSymbol);
    }
    finnhubSocket.unsubscribe(streamSymbol);
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.items)) return;

    if (msg.type === 'subscribe') {
      for (const item of msg.items.slice(0, MAX_STREAM_SYMBOLS_PER_CLIENT)) {
        if (item && typeof item.symbol === 'string') subscribeOne(item.symbol, item.assetType);
      }
    } else if (msg.type === 'unsubscribe') {
      for (const item of msg.items) {
        if (item && typeof item.symbol === 'string') unsubscribeOne(item.symbol, item.assetType);
      }
    }
  });

  ws.on('close', () => {
    for (const streamSymbol of Array.from(mySymbols)) {
      const { symbol, assetType } = fromStreamSymbol(streamSymbol);
      unsubscribeOne(symbol, assetType);
    }
  });
});

server.listen(PORT, () => {
  console.log(`FIN_APP server running at http://localhost:${PORT}`);
});

// Kick off the recurring congressional-disclosure sync so the cache is warm
// on first request instead of waiting on lazy on-demand fetches.
// NOTE: House-only for now - there is no free, actively-maintained Senate
// trade disclosure feed analogous to the House Stock Watcher mirror (the one
// community dataset that exists hasn't been updated since March 2021, and
// the official efdsearch.senate.gov site has no public API and requires
// agreeing to usage terms, so it isn't wired in here).
houseStockWatcher.startSync();
