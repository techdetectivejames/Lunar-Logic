'use strict';

/**
 * Lightweight, dependency-free keyword heuristic used to produce a "speculation"
 * blurb under each news headline. This is NOT financial advice - it's a rough
 * signal based on word choice in the headline/summary, meant to help a reader
 * skim sentiment quickly. Finnhub's premium news-sentiment endpoint is not
 * available on the configured API plan, so this fills that gap locally.
 */

const BULLISH_WORDS = [
  'surge', 'surges', 'surged', 'soar', 'soars', 'soared', 'rally', 'rallies', 'rallied',
  'jump', 'jumps', 'jumped', 'gain', 'gains', 'gained', 'rise', 'rises', 'rising', 'rose',
  'beat', 'beats', 'beat estimates', 'outperform', 'upgrade', 'upgraded', 'buy rating',
  'record high', 'all-time high', 'bullish', 'growth', 'expands', 'expansion', 'profit',
  'strong demand', 'raises guidance', 'raised guidance', 'breakthrough', 'partnership',
  'acquire', 'acquires', 'acquisition', 'boost', 'boosts', 'boosted', 'top estimates',
  'exceeds', 'exceeded', 'positive', 'optimis', 'top pick', 'buyback', 'dividend hike'
];

const BEARISH_WORDS = [
  'plunge', 'plunges', 'plunged', 'slump', 'slumps', 'slumped', 'tumble', 'tumbles', 'tumbled',
  'fall', 'falls', 'fell', 'falling', 'drop', 'drops', 'dropped', 'sink', 'sinks', 'sank',
  'miss', 'misses', 'missed estimates', 'downgrade', 'downgraded', 'sell rating',
  'record low', 'bearish', 'decline', 'declines', 'declined', 'shrink', 'shrinks', 'loss',
  'losses', 'weak demand', 'cuts guidance', 'cut guidance', 'lawsuit', 'investigation',
  'recall', 'layoff', 'layoffs', 'bankruptcy', 'default', 'warns', 'warning', 'probe',
  'fraud', 'scandal', 'sued', 'negative', 'pessimis', 'sell-off', 'selloff', 'volatile'
];

// Common company/coin names -> ticker, used to spot which symbols a headline
// likely affects even when it names the company instead of the ticker itself.
// Not exhaustive - just the names frequent enough in general market/crypto news.
const NAME_TO_TICKER = {
  apple: 'AAPL', tesla: 'TSLA', nvidia: 'NVDA', microsoft: 'MSFT', amazon: 'AMZN',
  alphabet: 'GOOGL', google: 'GOOGL', meta: 'META', facebook: 'META', netflix: 'NFLX',
  broadcom: 'AVGO', amd: 'AMD', intel: 'INTC', qualcomm: 'QCOM', oracle: 'ORCL',
  salesforce: 'CRM', adobe: 'ADBE', ibm: 'IBM', cisco: 'CSCO', paypal: 'PYPL',
  disney: 'DIS', boeing: 'BA', walmart: 'WMT', costco: 'COST', nike: 'NKE',
  mcdonald: 'MCD', starbucks: 'SBUX', 'coca cola': 'KO', pepsico: 'PEP',
  jpmorgan: 'JPM', 'goldman sachs': 'GS', 'bank of america': 'BAC', citigroup: 'C',
  visa: 'V', mastercard: 'MA', exxon: 'XOM', chevron: 'CVX', pfizer: 'PFE',
  moderna: 'MRNA', 'johnson & johnson': 'JNJ', unitedhealth: 'UNH', berkshire: 'BRK.B',
  ford: 'F', 'general motors': 'GM', uber: 'UBER', airbnb: 'ABNB', palantir: 'PLTR',
  spotify: 'SPOT', shopify: 'SHOP', snowflake: 'SNOW', coinbase: 'COIN',
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', dogecoin: 'DOGE', cardano: 'ADA',
  ripple: 'XRP', litecoin: 'LTC', polkadot: 'DOT', chainlink: 'LINK', binance: 'BNB',
};

const CASHTAG_RE = /\$([A-Z]{1,5})\b/g;
const EXCHANGE_TICKER_RE = /\b(?:NASDAQ|NYSE|NYSEARCA|OTC|OTCMKTS|CRYPTO)\s*:\s*([A-Z]{1,5})\b/gi;

// Best-effort scan for which tickers a headline/summary likely affects - a
// local heuristic (cashtags, exchange-qualified mentions, known company/coin
// names), not a substitute for a real entity-linking service.
function extractTickers(text) {
  const raw = text || '';
  const lower = raw.toLowerCase();
  const found = new Set();

  for (const match of raw.matchAll(CASHTAG_RE)) found.add(match[1].toUpperCase());
  for (const match of raw.matchAll(EXCHANGE_TICKER_RE)) found.add(match[1].toUpperCase());

  for (const [name, ticker] of Object.entries(NAME_TO_TICKER)) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) found.add(ticker);
  }

  return [...found];
}

// Broader fallback for articles that don't name a specific company/coin -
// which GICS-style sector(s) the language suggests it's actually about.
const SECTOR_KEYWORDS = {
  'Technology': ['software', 'hardware', 'semiconductor', 'chip', 'chipmaker', 'artificial intelligence', ' ai ', 'cloud computing', 'cybersecurity', 'data center'],
  'Energy': ['oil', 'crude', 'opec', 'drilling', 'pipeline', 'natural gas', 'refinery', 'renewable energy', 'solar', 'wind power'],
  'Healthcare': ['drug', 'pharma', 'pharmaceutical', 'biotech', 'vaccine', 'fda', 'hospital', 'medical device', 'clinical trial'],
  'Financials': ['bank', 'banking', 'interest rate', 'federal reserve', 'the fed', 'lending', 'mortgage rate', 'insurer', 'insurance'],
  'Consumer Discretionary': ['retailer', 'retail sales', 'e-commerce', 'auto sales', 'restaurant chain', 'airline', 'hospitality', 'apparel'],
  'Consumer Staples': ['grocery', 'beverage', 'packaged food', 'household goods', 'tobacco'],
  'Industrials': ['manufacturing', 'aerospace', 'defense contractor', 'logistics', 'shipping', 'freight', 'construction'],
  'Materials': ['mining', 'steel', 'copper', 'chemicals', 'commodities', 'metals'],
  'Real Estate': ['real estate', 'housing market', 'home prices', 'reit', 'property market'],
  'Utilities': ['electric utility', 'power grid', 'water utility'],
  'Communication Services': ['telecom', 'streaming service', 'media company', 'advertising', 'social media platform'],
  'Crypto / Digital Assets': ['crypto', 'blockchain', 'cryptocurrency', 'bitcoin', 'ethereum', 'defi', 'nft', 'stablecoin', 'altcoin', 'token'],
};

function extractSectors(text) {
  const lower = ` ${(text || '').toLowerCase()} `;
  const found = [];
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) found.push(sector);
  }
  return found;
}

function analyzeText(text) {
  const lower = (text || '').toLowerCase();
  let bullHits = [];
  let bearHits = [];

  for (const word of BULLISH_WORDS) {
    if (lower.includes(word)) bullHits.push(word);
  }
  for (const word of BEARISH_WORDS) {
    if (lower.includes(word)) bearHits.push(word);
  }

  const score = bullHits.length - bearHits.length;
  let sentiment = 'Neutral';
  if (score > 0) sentiment = 'Bullish';
  else if (score < 0) sentiment = 'Bearish';

  let note;
  if (sentiment === 'Bullish') {
    note = `Language leans positive (matched: ${bullHits.slice(0, 3).join(', ')}). Possible upside speculation.`;
  } else if (sentiment === 'Bearish') {
    note = `Language leans negative (matched: ${bearHits.slice(0, 3).join(', ')}). Possible downside speculation.`;
  } else {
    note = 'No strong directional language detected - likely informational or mixed signal.';
  }

  const tickers = extractTickers(text);

  return { sentiment, score, note, tickers, sectors: tickers.length ? [] : extractSectors(text) };
}

module.exports = { analyzeText };
