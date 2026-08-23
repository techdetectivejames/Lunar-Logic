# Lunar Logic

A finance dashboard backed by the [Finnhub](https://finnhub.io/) API and [yahoo-finance2](https://github.com/gadicc/yahoo-finance2):

- **User authentication** via [Supabase Auth](https://supabase.com/auth) (email/password sign-up + sign-in).
- **Password reset flow** using Supabase recovery emails (`Forgot password` -> update password form).
- **Guest mode + route-level API exceptions**: market/congress data endpoints are public, while user profile/watchlist sync routes require auth.
- **Per-user watchlist persistence** in Supabase (`user_profiles` + `user_watchlists`).
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
- **Congressional trades** — filterable by ticker, with representative name, district, owner,
  transaction type and amount, sourced from the free public
  [House Stock Watcher](https://housestockwatcher.com/) dataset (no API key required).

## Prerequisites

- Node.js 18+
- A free [Finnhub API key](https://finnhub.io/register)
- A [Supabase](https://supabase.com/) project (this app expects Auth enabled)

## Setup

```bash
# 1. Install Node dependencies
npm install

# 2. Add your Finnhub + Supabase keys
cp .env.example .env
# then edit .env and set:
# FINNHUB_API_KEY=...
# SUPABASE_URL=https://<your-project-ref>.supabase.co
# SUPABASE_ANON_KEY=...
# SUPABASE_SERVICE_ROLE_KEY=...

# 3. Start the server
npm start
```

### Supabase SQL setup

Run this once in Supabase SQL Editor:

```sql
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_watchlists (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stocks jsonb not null default '[]'::jsonb,
  crypto jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
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
- `server/auth.js` — Supabase JWT verification middleware + public auth config endpoint helper.
- `server/supabaseStore.js` — server-side Supabase REST persistence for user profile + watchlists.
- `public/` — Static frontend (vanilla HTML/CSS/JS, no build step).

## Security notes

- The Finnhub API key lives only in `.env` (gitignored) and is never sent to the browser.
- Supabase JWT access tokens are verified server-side against Supabase JWKS before any `/api/*` data route is served.
- The Supabase anon key is delivered to the browser via `/api/auth/config` (safe/public by design); never expose your service-role key in the frontend.
- `SUPABASE_SERVICE_ROLE_KEY` must stay server-only in `.env`/host secrets; it is used only by the backend to upsert `user_profiles` and `user_watchlists`.
- All ticker/coin input is validated against a strict symbol regex before being used in API calls.
- All API response text rendered in the DOM is HTML-escaped to prevent XSS from third-party news content.

