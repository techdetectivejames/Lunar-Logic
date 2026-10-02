'use strict';

// Single source of truth for which features are free vs premium. Shared by the
// server-side gate middleware (server/auth.js) AND sent to the browser via
// GET /api/features, so the UI's upgrade prompts always match what the server
// actually enforces.
//
// tier:
//   'public'  - no account needed (live prices, search)
//   'free'    - any signed-in user
//   'premium' - requires an active paid subscription

const FEATURES = {
  quotes:                  { tier: 'public',  category: 'core',   label: 'Live prices' },
  search:                  { tier: 'public',  category: 'core',   label: 'Symbol search' },

  // Charts + the info shown alongside them are open to everyone (guests too).
  'charts.candles':        { tier: 'public',  category: 'charts', label: 'Price charts' },
  'data.dividend':         { tier: 'public',  category: 'charts', label: 'Dividend info' },
  'charts.predictions':    { tier: 'public',  category: 'charts', label: 'Analyst predictions' },

  // News + congressional trades + tools require an account (premium where noted).
  'news.ticker':           { tier: 'free',    category: 'news',   label: 'Per-ticker news' },
  'news.crypto':           { tier: 'free',    category: 'news',   label: 'Crypto news' },
  'tools.dividendCalc':    { tier: 'free',    category: 'tools',  label: 'Dividend calculator' },

  'news.market':           { tier: 'premium', category: 'news',   label: 'Market news feed' },
  'data.congress':         { tier: 'premium', category: 'charts', label: 'Congressional trades' },
  'tools.totalReturn':     { tier: 'premium', category: 'tools',  label: 'Total return calculator' },
  'tools.dividendHistory': { tier: 'premium', category: 'tools',  label: 'Dividend history chart' },
};

function featureTier(id) {
  return FEATURES[id] ? FEATURES[id].tier : 'premium';
}

module.exports = { FEATURES, featureTier };
