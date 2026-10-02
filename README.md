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

## Premium / paywall (optional)

A subscription paywall (Stripe) gates premium features. It builds on the
Supabase setup above and is **off** until configured — when off, everything
behaves like the account-only (Phase 1) gating.

Tiers (see [`server/featureFlags.js`](server/featureFlags.js), the single
source of truth shared by the server gate and the UI):

- **Guest** — live prices (watchlists, ticker tape, card summaries).
- **Free** (signed in) — price charts, dividend info, per-ticker & crypto news,
  dividend calculator.
- **Premium** (paid) — market news feed, analyst predictions, congressional
  trades, total-return calculator, dividend-history charts.

Gating is enforced **server-side** (per-route middleware in
[`server/auth.js`](server/auth.js) + RLS on `entitlements`), so hiding the UI is
only cosmetic — the API returns `401 { authRequired }` / `403 { upgradeRequired }`
for content the caller isn't entitled to.

To enable it:

1. Run [`supabase/phase2-stripe.sql`](supabase/phase2-stripe.sql) in the Supabase
   SQL editor (adds the `entitlements` table, RLS, and a free-plan default on
   signup).
2. In Stripe, create a recurring **Premium** product/price and copy its price id.
3. Add a webhook endpoint pointing at `/api/stripe/webhook` (events:
   `checkout.session.completed`, `customer.subscription.created|updated|deleted`)
   and copy its signing secret. Locally you can use
   `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
4. Set these in `.env` (and your host's env):

   ```bash
   SUPABASE_SERVICE_ROLE_KEY=...   # server-only, bypasses RLS — keep secret
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PRICE_ID=price_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   APP_URL=https://your-app.example   # optional; for Checkout/Portal redirects
   ```

Users upgrade via **Stripe Checkout** (account menu → *Upgrade to Premium*) and
manage/cancel via the **Customer Portal** (account menu → *Manage billing*).
Entitlements update automatically from the webhook.

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
- `public/account.js` — Sign-in/out (email + Google), save/load/duplicate/delete dashboard UI, and the Stripe upgrade/billing flow; reads/writes the current layout via `window.LunarDashboard` and publishes auth/entitlement state via `window.LunarAuth` / `window.LunarFeatures`.
- `server/supabaseAdmin.js` — Server-only Supabase client (service_role) for verifying JWTs and writing entitlements.
- `server/auth.js` — Express middleware: attaches the user/entitlement from the bearer token and enforces per-feature gating.
- `server/entitlements.js` — Entitlement read/write helpers.
- `server/featureFlags.js` — The free-vs-premium feature map (shared by server + client).
- `server/stripe.js` — Stripe Checkout, Customer Portal, and webhook reconciliation.
- `supabase/schema.sql` — One-off database setup (profiles, dashboards, RLS, triggers).
- `supabase/phase2-stripe.sql` — One-off paywall setup (entitlements table + RLS).
