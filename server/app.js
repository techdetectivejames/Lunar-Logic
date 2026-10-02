'use strict';

const path = require('path');
const express = require('express');
const finnhub = require('./finnhub');
const yfinance = require('./yfinance');
const { analyzeText } = require('./speculation');
const houseStockWatcher = require('./houseStockWatcher');
const senateTrades = require('./senateTrades');
const { withUser, requireUser, requireFeature, gateActive } = require('./auth');
const { isPremiumActive } = require('./entitlements');
const { FEATURES } = require('./featureFlags');
const stripeBilling = require('./stripe');
const revenuecat = require('./revenuecat');
const { getAdmin } = require('./supabaseAdmin');

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

// Stripe webhook needs the RAW request body for signature verification, so it
// must be registered with express.raw BEFORE the JSON body parser below.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  try {
    const type = await stripeBilling.handleWebhook(req.body, signature);
    res.json({ received: true, type });
  } catch (err) {
    // Bad signature / misconfiguration -> 400 so Stripe retries.
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.use(express.json());
// Attach req.user / req.entitlement from the bearer token when present (guests pass through).
app.use(withUser);

// --- API routes ---

// Public Supabase config for the browser client. The anon key is designed to
// be exposed to the browser - row-level security (not key secrecy) is what
// protects user data. Returns empty strings when unset so the frontend quietly
// falls back to guest-only mode (default dashboard, no sign-in / saving).
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    // Public RevenueCat SDK keys (safe for clients) used by the native apps.
    revenuecat: {
      ios: process.env.REVENUECAT_IOS_KEY || '',
      android: process.env.REVENUECAT_ANDROID_KEY || '',
      entitlement: process.env.REVENUECAT_ENTITLEMENT_ID || 'premium',
    },
  });
});

// Feature-flag map + the caller's entitlement. The browser uses this to show
// upgrade prompts that mirror exactly what the server enforces.
app.get('/api/features', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const premium = isPremiumActive(req.entitlement);
  res.json({
    gateActive: gateActive(),
    billingEnabled: stripeBilling.billingEnabled(),
    user: req.user ? { id: req.user.id, email: req.user.email } : null,
    entitlement: req.user
      ? {
          plan: (req.entitlement && req.entitlement.plan) || 'free',
          status: (req.entitlement && req.entitlement.status) || 'inactive',
          premium,
          currentPeriodEnd: (req.entitlement && req.entitlement.current_period_end) || null,
        }
      : null,
    features: FEATURES,
  });
});

// --- Billing (Stripe Checkout + Customer Portal) ---

app.post('/api/billing/checkout', requireUser, async (req, res) => {
  try {
    const url = await stripeBilling.createCheckoutSession(req, req.user);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/billing/portal', requireUser, async (req, res) => {
  try {
    const url = await stripeBilling.createPortalSession(req, req.user);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Mobile: RevenueCat (in-app purchases sync to the same entitlements) ---

// RevenueCat posts subscription events here. Access is granted/revoked in the
// same `entitlements` table used by Stripe, so web + mobile share one source.
app.post('/api/revenuecat/webhook', async (req, res) => {
  try {
    const type = await revenuecat.handleWebhook(req.body, req.headers.authorization || '');
    res.json({ received: true, type });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// --- Mobile: device push-notification token registration ---

app.post('/api/push/register', requireUser, async (req, res) => {
  const admin = getAdmin();
  if (!admin) return res.status(503).json({ error: 'Not configured' });
  const token = String(req.body && req.body.token || '').trim();
  const platform = String(req.body && req.body.platform || '').slice(0, 16) || null;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const { error } = await admin
      .from('push_tokens')
      .upsert({ user_id: req.user.id, token, platform }, { onConflict: 'user_id,token' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Account deletion (required by the app stores) ---
// Removes the auth user; FK "on delete cascade" wipes profiles, dashboards,
// entitlements and push tokens. Subscriptions should be cancelled separately
// via Stripe/Apple/Google (noted in the UI confirmation).
app.delete('/api/account', requireUser, async (req, res) => {
  const admin = getAdmin();
  if (!admin) return res.status(503).json({ error: 'Not configured' });
  try {
    const { error } = await admin.auth.admin.deleteUser(req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/news', requireFeature('news.ticker'), async (req, res) => {
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
app.get('/api/news/market', requireFeature('news.market'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  try {
    const news = await finnhub.getMarketNews();
    const items = (Array.isArray(news) ? news : [])
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .map((item) => ({
        id: item.id,
        headline: item.headline,
        summary: item.summary,
        source: item.source,
        url: item.url,
        datetime: item.datetime,
        image: item.image,
        speculation: analyzeText(`${item.headline || ''} ${item.summary || ''}`),
      }))
      // General feed only - drop headlines that don't tie to a specific ticker or sector.
      .filter((item) => item.speculation.tickers.length || item.speculation.sectors.length)
      .slice(0, limit);
    res.json({ items });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/dividend', requireFeature('data.dividend'), async (req, res) => {
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

app.get('/api/dividend-history', requireFeature('tools.dividendHistory'), async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const years = Math.min(Math.max(parseInt(req.query.years, 10) || 5, 1), 10);
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  try {
    const result = await yfinance.getDividendHistory(symbol, years);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message, symbol, history: [], source: 'yfinance' });
  }
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.get('/api/total-return', requireFeature('tools.totalReturn'), async (req, res) => {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
    return res.status(400).json({ error: '"from" and "to" must be YYYY-MM-DD dates' });
  }
  if (new Date(from).getTime() >= new Date(to).getTime()) {
    return res.status(400).json({ error: '"from" must be before "to"' });
  }

  try {
    const result = await yfinance.getTotalReturn(symbol, from, to);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to compute total return' });
  }
});

const VALID_PERIODS = new Set(['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y']);

app.get('/api/candles', requireFeature('charts.candles'), async (req, res) => {
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

app.get('/api/predictions', requireFeature('charts.predictions'), async (req, res) => {
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

app.get('/api/crypto/candles', requireFeature('charts.candles'), async (req, res) => {
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

app.get('/api/crypto/news', requireFeature('news.crypto'), async (req, res) => {
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
    let mapped = items
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
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
    // General (all-crypto) feed only - a specific base symbol was already text-filtered above.
    if (!base) {
      mapped = mapped.filter((item) => item.speculation.tickers.length);
    }
    mapped = mapped.slice(0, limit);
    res.json({ symbol: base || null, items: mapped });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/congress', requireFeature('data.congress'), async (req, res) => {
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
    const [houseTrades, senateTradesList, houseLatest, senateLatest] = await Promise.all([
      houseStockWatcher.getTransactions({
        symbol,
        representative,
        fromDate: toDateStr(from),
        toDate: toDateStr(to),
        limit,
        dateField,
        forceRefresh,
      }),
      senateTrades.getTransactions({
        symbol,
        representative,
        fromDate: toDateStr(from),
        toDate: toDateStr(to),
        limit,
        dateField,
        forceRefresh,
      }).catch(() => []), // Senate feed is a bonus on top of House data - don't fail the whole request if Bargo's free tier is rate-limited
      houseStockWatcher.getLatestDisclosureDate(),
      senateTrades.getLatestDisclosureDate().catch(() => null),
    ]);

    let trades = [...houseTrades, ...senateTradesList].sort(
      (a, b) => (Date.parse(b[dateField]) || 0) - (Date.parse(a[dateField]) || 0)
    );
    if (typeof limit === 'number') trades = trades.slice(0, limit);

    const latestDisclosureDate = [houseLatest, senateLatest].filter(Boolean).sort().pop() || null;
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
