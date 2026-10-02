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

## Accounts & saved dashboards (optional)

Sign-in and saved dashboards are powered by [Supabase](https://supabase.com/)
(auth + Postgres). Without it the app still runs fully in **guest mode**: the
default dashboard works, but there's no sign-in and saving a dashboard just
prompts you to sign in.

To enable it:

1. Create a free Supabase project.
2. In the project's **SQL editor**, run [`supabase/schema.sql`](supabase/schema.sql).
   This creates the `profiles` and `dashboards` tables, row-level security
   policies (so each user can only read/write their own rows), and triggers
   that auto-create a profile on signup and keep `updated_at` current.
3. Under **Authentication → Providers**, enable **Email**, and **Google**
   (paste your Google OAuth client id/secret). Add your site URL + redirect
   URLs under **Authentication → URL Configuration**.
4. Copy the project URL and **anon** public key from **Settings → API** into
   `.env`:

   ```bash
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_ANON_KEY=eyJ...
   ```

   The anon key is designed to be public — row-level security, not key
   secrecy, is what protects user data. Never put the `service_role` key here.

Dashboard layouts are stored as **versioned JSON** (`{ version, watchlist,
cryptoWatchlist, chartStyle, dividendMode, currency }`) so new widgets can be
added later without a schema migration. Guests' layouts live in
`localStorage`; signing in and saving copies the current layout into the
database. You can save, load, duplicate and delete dashboards from the
**Dashboards** panel in the header.

## Project layout

- `server/app.js` — The Express app itself (all `/api/*` routes + static file serving); no `.listen()` call, so it can be reused by both entrypoints below.
- `server/index.js` — Local/traditional-host entrypoint: calls `app.listen()` and starts the recurring congressional-disclosure sync job.
- `api/index.js` — Vercel serverless entrypoint: exports the same Express app with no `.listen()` and no background sync (serverless functions can't host either).
- `vercel.json` — Rewrites every request to `api/index.js`.
- `server/finnhub.js` — Finnhub REST API client with in-memory caching.
- `server/yfinance.js` — Dividend info and OHLC candle data via the pure-JS `yahoo-finance2` package (no Python required, works on serverless).
- `server/speculation.js` — Keyword heuristic used to generate the speculation notes.
- `public/` — Static frontend (vanilla HTML/CSS/JS, no build step).
- `public/supabase-client.js` — Loads the public Supabase config from `/api/config` and lazily creates the browser client (returns `null` in guest mode).
- `public/account.js` — Sign-in/out (email + Google) and the save/load/duplicate/delete dashboard UI; reads/writes the current layout via `window.LunarDashboard`.
- `supabase/schema.sql` — One-off database setup (tables, RLS policies, triggers).

## Security notes

- The Finnhub API key lives only in `.env` (gitignored) and is never sent to the browser.
- The Supabase **anon** key is the only key exposed to the browser (by design); the `service_role` key is never used client-side. Row-level security ensures users can only read/write their own `profiles`/`dashboards` rows.
- All ticker/coin input is validated against a strict symbol regex before being used in API calls.
- All API response text rendered in the DOM is HTML-escaped to prevent XSS from third-party news content.

