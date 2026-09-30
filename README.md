# Lunar Logic

A finance dashboard backed by the [Finnhub](https://finnhub.io/) API and [yahoo-finance2](https://github.com/gadicc/yahoo-finance2):

- **Live quotes** for a customizable stock watchlist and crypto watchlist, refreshed via
  short-interval polling of a batched quote endpoint (serverless-friendly - no persistent
  WebSocket connection required).
- **Scrolling market ticker tape** (DOW, S&P 500, NASDAQ, Russell 2000, VIX) along the header.
- **Candlestick charts** per ticker (5d/1mo/3mo/6mo/1y) drawn on canvas.
- **Dividend info** (per-share amount, yield, pay frequency, last/ex-dividend dates) via yahoo-finance2,
  since Finnhub's dividend endpoints require a paid plan.
- **Incoming predictions** — next earnings date/EPS estimate and analyst recommendation consensus.
- **Stock & crypto news with speculation** — recent headlines, each annotated with a local
  keyword-based Bullish/Bearish/Neutral note (Finnhub's paid news-sentiment endpoint isn't required).
- **Congressional trades** — filterable by ticker, with representative name, chamber, district,
  owner, transaction type and amount. House data comes from the free public
  [House Stock Watcher](https://housestockwatcher.com/) dataset; Senate data comes from the free
  [Bargo Congress Trades API](https://www.bargo.ai/free-apis/congress) (neither requires an API key,
  though an optional free `BARGO_API_KEY` raises Bargo's rate limit - see `.env.example`).

## Prerequisites

- Node.js 18+
- A free [Finnhub API key](https://finnhub.io/register)

## Setup

```bash
# 1. Install Node dependencies
npm install

# 2. Add your Finnhub API key
cp .env.example .env
# then edit .env and set FINNHUB_API_KEY=...

# 3. Start the server
npm start
```

Visit  

## Project layout

- `server/app.js` — The Express app itself (all `/api/*` routes + static file serving); no `.listen()` call, so it can be reused by both entrypoints below.
- `server/index.js` — Local/traditional-host entrypoint: calls `app.listen()` and starts the recurring congressional-disclosure sync job.
- `api/index.js` — Vercel serverless entrypoint: exports the same Express app with no `.listen()` and no background sync (serverless functions can't host either).
- `vercel.json` — Rewrites every request to `api/index.js`.
- `server/finnhub.js` — Finnhub REST API client with in-memory caching.
- `server/yfinance.js` — Dividend info and OHLC candle data via the pure-JS `yahoo-finance2` package (no Python required, works on serverless).
- `server/speculation.js` — Keyword heuristic used to generate the speculation notes.
- `public/` — Static frontend (vanilla HTML/CSS/JS, no build step).

