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

  return { sentiment, score, note };
}

module.exports = { analyzeText };
