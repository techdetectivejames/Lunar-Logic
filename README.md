# FIN_APP

A finance dashboard backed by the [Finnhub](https://finnhub.io/) API and [yfinance](https://pypi.org/project/yfinance/):

- **Live quotes** for a customizable stock watchlist and crypto watchlist, streamed in
  real time over a WebSocket (falls back to periodic polling if the stream drops).
- **Scrolling market ticker tape** (DOW, S&P 500, NASDAQ, Russell 2000, VIX) along the header.
- **Candlestick charts** per ticker (5d/1mo/3mo/6mo/1y) drawn on canvas.
- **Dividend info** (per-share amount, yield, pay frequency, last/ex-dividend dates) via yfinance,
  since Finnhub's dividend endpoints require a paid plan.
- **Incoming predictions** — next earnings date/EPS estimate and analyst recommendation consensus.
- **Stock & crypto news with speculation** — recent headlines, each annotated with a local
  keyword-based Bullish/Bearish/Neutral note (Finnhub's paid news-sentiment endpoint isn't required).
- **Congressional trades** — filterable by ticker, with representative name, district, owner,
  transaction type and amount, sourced from the free public
  [House Stock Watcher](https://housestockwatcher.com/) dataset (no API key required).

## Prerequisites

- Node.js 18+
- Python 3 (used only to run the bundled yfinance bridge scripts)
- A free [Finnhub API key](https://finnhub.io/register)

## Setup

```bash
# 1. Install Node dependencies
npm install

# 2. Create a local Python venv for the yfinance bridge (dividends & candles)
python3 -m venv .venv
.venv/bin/pip install yfinance

# 3. Add your Finnhub API key
cp .env.example .env
# then edit .env and set FINNHUB_API_KEY=...

# 4. Start the server
npm start
```

Visit   

> The Python venv is required — the system Python has no pip on some distros, and the
> app always calls `.venv/bin/python` directly (never the system Python).

## Project layout

- `server/index.js` — Express app + WebSocket server (`/ws`); serves the frontend and proxies Finnhub/yfinance.
- `server/finnhub.js` — Finnhub REST API client with in-memory caching.
- `server/finnhubSocket.js` — Single upstream connection to Finnhub's trade WebSocket, ref-counted subscriptions shared across browser clients.
- `server/yfinance.js` — Node bridge that calls the Python scripts below via `child_process.execFile`.
- `server/yfinance_bridge.py` / `server/candles_bridge.py` — Python scripts using yfinance to fetch dividend info and OHLC candles.
- `server/speculation.js` — Keyword heuristic used to generate the speculation notes.
- `public/` — Static frontend (vanilla HTML/CSS/JS, no build step).

## Security notes

- The Finnhub API key lives only in `.env` (gitignored) and is never sent to the browser.
- All ticker/coin input is validated against a strict symbol regex before being used in API calls.
- All API response text rendered in the DOM is HTML-escaped to prevent XSS from third-party news content.

