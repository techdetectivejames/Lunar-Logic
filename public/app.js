'use strict';

const STORAGE_KEY = 'finapp.watchlist';
const DEFAULT_WATCHLIST = ['AAPL', 'TSLA', 'NVDA', 'MSFT'];
const CRYPTO_STORAGE_KEY = 'finapp.crypto.watchlist';
const DEFAULT_CRYPTO_WATCHLIST = ['BTC', 'ETH', 'SOL'];
// Lets people type a coin's common name and still resolve to the ticker our
// data providers (Binance quotes / Yahoo Finance candles) actually recognize.
const CRYPTO_NAME_ALIASES = {
  CARDANO: 'ADA', CIVIC: 'CVC', DOGECOIN: 'DOGE', POLKADOT: 'DOT',
  CHAINLINK: 'LINK', POLYGON: 'MATIC', LITECOIN: 'LTC', RIPPLE: 'XRP',
  SHIBAINU: 'SHIB', AVALANCHE: 'AVAX', COSMOS: 'ATOM', UNISWAP: 'UNI',
  STELLAR: 'XLM', ALGORAND: 'ALGO', TRON: 'TRX', MONERO: 'XMR',
  TEZOS: 'XTZ', VECHAIN: 'VET', FILECOIN: 'FIL', HEDERA: 'HBAR',
  INTERNETCOMPUTER: 'ICP', APTOS: 'APT', ARBITRUM: 'ARB', OPTIMISM: 'OP',
  NEAR: 'NEAR', SUI: 'SUI', SEI: 'SEI', BITCOIN: 'BTC', ETHEREUM: 'ETH',
  SOLANA: 'SOL',
};
const REFRESH_MS = 30_000;
const PERIODS = ['5d', '1mo', '3mo', '6mo', '1y'];
const cardPeriod = new Map(); // `${type}:${symbol}` -> selected chart period
const lastCandles = new Map(); // `${type}:${symbol}` -> last fetched candles (for resize redraws)
const INDEX_ITEMS = [
  { symbol: 'DIA', label: 'DOW' },
  { symbol: 'SPY', label: 'S&P 500' },
  { symbol: 'QQQ', label: 'NASDAQ' },
  { symbol: 'IWM', label: 'RUSSELL 2000' },
  { symbol: 'VIXY', label: 'VIX' },
];

const dashboardEl = document.getElementById('dashboard');
const watchlistBarEl = document.getElementById('watchlist-bar');
const addForm = document.getElementById('add-ticker-form');
const tickerInput = document.getElementById('ticker-input');
const cryptoDashboardEl = document.getElementById('crypto-dashboard');
const cryptoWatchlistBarEl = document.getElementById('crypto-watchlist-bar');
const addCryptoForm = document.getElementById('add-crypto-form');
const cryptoInput = document.getElementById('crypto-input');
const congressFilterEl = document.getElementById('congress-ticker-filter');
const congressCustomEl = document.getElementById('congress-ticker-custom');
const congressRepFilterEl = document.getElementById('congress-rep-filter');
const congressRefreshBtn = document.getElementById('congress-refresh');
const congressBodyEl = document.getElementById('congress-body');
const congressUpdatedEl = document.getElementById('congress-updated');
const dividendCalcForm = document.getElementById('dividend-calc-form');
const dividendCalcSymbolEl = document.getElementById('dividend-calc-symbol');
const dividendCalcSharesEl = document.getElementById('dividend-calc-shares');
const dividendCalcAmountEl = document.getElementById('dividend-calc-amount');
const dividendCalcResultEl = document.getElementById('dividend-calc-result');
const dividendCalcLoadBtn = document.getElementById('dividend-calc-load');
const dividendCalcPreviewEl = document.getElementById('dividend-calc-preview');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
const tickerTapeTrackEl = document.getElementById('ticker-tape-track');
const tickerModalOverlayEl = document.getElementById('ticker-modal-overlay');
const tickerModalBodyEl = document.getElementById('ticker-modal-body');
const tickerModalCloseEl = document.getElementById('ticker-modal-close');

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// jittered grid keeps stars spread evenly while each cell's exact spot + sparkle timing stays random
function renderStarsField() {
  const el = document.getElementById('stars-field');
  if (!el) return;
  const cols = 8;
  const rows = 4;
  const stars = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = ((col + 0.15 + Math.random() * 0.7) / cols) * 100;
      const y = ((row + 0.15 + Math.random() * 0.7) / rows) * 100;
      const size = (1 + Math.random() * 1.8).toFixed(1);
      const dur = (1.8 + Math.random() * 3).toFixed(2);
      const delay = (Math.random() * 5).toFixed(2);
      stars.push(
        `<span class="star" style="--x:${x.toFixed(2)}%; --y:${y.toFixed(2)}%; --size:${size}px; --dur:${dur}s; --delay:${delay}s;"></span>`
      );
    }
  }
  el.innerHTML = stars.join('');
}

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch { /* ignore malformed storage */ }
  return [...DEFAULT_WATCHLIST];
}

function saveWatchlist(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

let watchlist = loadWatchlist();

function loadCryptoWatchlist() {
  try {
    const raw = localStorage.getItem(CRYPTO_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch { /* ignore malformed storage */ }
  return [...DEFAULT_CRYPTO_WATCHLIST];
}

function saveCryptoWatchlist(list) {
  localStorage.setItem(CRYPTO_STORAGE_KEY, JSON.stringify(list));
}

let cryptoWatchlist = loadCryptoWatchlist();

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function fmtMoney(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function timeAgo(unixSeconds) {
  if (!unixSeconds) return '';
  const diffMs = Date.now() - unixSeconds * 1000;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// --- Watchlist chips ---

function renderWatchlistBar() {
  watchlistBarEl.innerHTML = watchlist.map((sym) => `
    <span class="chip" data-symbol="${escapeHtml(sym)}">
      <button type="button" class="chip-symbol-btn" data-symbol="${escapeHtml(sym)}" data-asset-type="stock">${escapeHtml(sym)}</button>
      <button type="button" class="chip-remove" aria-label="Remove ${escapeHtml(sym)}" data-remove="${escapeHtml(sym)}">×</button>
    </span>
  `).join('');

  watchlistBarEl.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeTicker(btn.dataset.remove));
  });
}

function renderCongressFilterOptions() {
  const current = congressFilterEl.value;
  congressFilterEl.innerHTML = '<option value="">Recent activity (all tickers)</option>' +
    watchlist.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  if (watchlist.includes(current)) congressFilterEl.value = current;
}

function addTicker(symbolRaw) {
  const symbol = symbolRaw.trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    alert('Enter a valid ticker symbol (letters/numbers, up to 10 chars).');
    return;
  }
  if (watchlist.includes(symbol)) return;
  watchlist.push(symbol);
  saveWatchlist(watchlist);
  renderWatchlistBar();
  renderCongressFilterOptions();
  renderDashboard();
}

function removeTicker(symbol) {
  watchlist = watchlist.filter((s) => s !== symbol);
  saveWatchlist(watchlist);
  streamUnsubscribe(symbol, 'stock');
  renderWatchlistBar();
  renderCongressFilterOptions();
  renderDashboard();
}

function renderCryptoWatchlistBar() {
  cryptoWatchlistBarEl.innerHTML = cryptoWatchlist.map((sym) => `
    <span class="chip" data-symbol="${escapeHtml(sym)}">
      <button type="button" class="chip-symbol-btn" data-symbol="${escapeHtml(sym)}" data-asset-type="crypto">${escapeHtml(sym)}</button>
      <button type="button" class="chip-remove" aria-label="Remove ${escapeHtml(sym)}" data-remove-crypto="${escapeHtml(sym)}">×</button>
    </span>
  `).join('');

  cryptoWatchlistBarEl.querySelectorAll('[data-remove-crypto]').forEach((btn) => {
    btn.addEventListener('click', () => removeCrypto(btn.dataset.removeCrypto));
  });
}

function addCrypto(symbolRaw) {
  const cleaned = symbolRaw.trim().toUpperCase().replace(/[\s-]/g, '');
  const symbol = CRYPTO_NAME_ALIASES[cleaned] || cleaned;
  if (!symbol || !/^[A-Z0-9]{2,10}$/.test(symbol)) {
    alert('Enter a valid coin symbol or name (e.g. BTC or Bitcoin).');
    return;
  }
  if (cryptoWatchlist.includes(symbol)) return;
  cryptoWatchlist.push(symbol);
  saveCryptoWatchlist(cryptoWatchlist);
  renderCryptoWatchlistBar();
  renderCryptoDashboard();
}

function removeCrypto(symbol) {
  cryptoWatchlist = cryptoWatchlist.filter((s) => s !== symbol);
  saveCryptoWatchlist(cryptoWatchlist);
  streamUnsubscribe(symbol, 'crypto');
  renderCryptoWatchlistBar();
  renderCryptoDashboard();
}

// --- Dashboard cards ---

function changeClass(change) {
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'flat';
}

function speculationBlock(speculation) {
  if (!speculation) return '';
  return `
    <div class="speculation ${escapeHtml(speculation.sentiment)}">
      <span class="speculation-tag">${escapeHtml(speculation.sentiment)} speculation:</span>
      ${escapeHtml(speculation.note)}
    </div>
  `;
}

function newsItemHtml(item) {
  return `
    <div class="news-item">
      <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.headline)}</a>
      <div class="news-meta">${escapeHtml(item.source)} · ${escapeHtml(timeAgo(item.datetime))}</div>
      ${speculationBlock(item.speculation)}
    </div>
  `;
}

function dividendBlockHtml(dividend, currentPrice) {
  if (!dividend || !dividend.paysDividend) {
    return `
      <div class="dividend-block no-dividend">
        <strong>Dividend</strong>
        <p class="muted">No dividend currently paid.</p>
      </div>
    `;
  }

  const perShare = dividend.dividendPerShareAnnual;
  const yieldPct = typeof perShare === 'number' && typeof currentPrice === 'number' && currentPrice > 0
    ? (perShare / currentPrice) * 100
    : null;

  return `
    <div class="dividend-block">
      <strong>Dividend</strong>
      <div class="dividend-grid">
        <div>Per Share (Annual)<span>${perShare != null ? `$${fmtMoney(perShare)}` : '—'}</span></div>
        <div>Yield<span>${yieldPct != null ? `${yieldPct.toFixed(2)}%` : '—'}</span></div>
        <div>Pay Frequency<span>${escapeHtml(dividend.frequency || '—')}</span></div>
        <div>Payout Ratio<span>${dividend.payoutRatioPct != null ? `${dividend.payoutRatioPct}%` : '—'}</span></div>
        <div>Last Paid<span>${escapeHtml(dividend.lastDividendValue != null ? `$${fmtMoney(dividend.lastDividendValue)} · ${dividend.lastDividendDate || ''}` : '—')}</span></div>
        <div>Ex-Dividend<span>${escapeHtml(dividend.exDividendDate || '—')}</span></div>
      </div>
    </div>
  `;
}

// --- Dividend calculator ---

const PAYMENTS_PER_YEAR = {
  Weekly: 52, Monthly: 12, Quarterly: 4, 'Semi-Annual': 2, Annual: 1,
};

async function calculateDividend(e) {
  e.preventDefault();
  const symbol = dividendCalcSymbolEl.value.trim().toUpperCase();
  const shares = parseFloat(dividendCalcSharesEl.value.replace(/[,$\s]/g, ''));
  const avgCost = parseFloat(dividendCalcAmountEl.value.replace(/[,$\s]/g, ''));

  if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    dividendCalcResultEl.innerHTML = '<p class="error-text">Enter a valid ticker symbol.</p>';
    return;
  }
  if (!(shares > 0) || !(avgCost > 0)) {
    dividendCalcResultEl.innerHTML = '<p class="error-text">Qty and Avg. Cost must be greater than 0.</p>';
    return;
  }

  dividendCalcResultEl.innerHTML = '<p class="spinner">Calculating…</p>';

  try {
    // Live price is a nice-to-have (current value/yield), not required for the
    // core dividend math, so a Finnhub rate-limit on the quote shouldn't fail
    // the whole calculation - only the dividend lookup is treated as fatal.
    const [quoteResult, dividend] = await Promise.all([
      fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`).catch((err) => ({ error: err })),
      fetchJson(`/api/dividend?symbol=${encodeURIComponent(symbol)}`),
    ]);

    if (!dividend.paysDividend) {
      dividendCalcResultEl.innerHTML = `
        <div class="dividend-calc-grid">
          <div>Ticker<span>${escapeHtml(symbol)}</span></div>
        </div>
        <p class="muted">${escapeHtml(symbol)} doesn't currently pay a dividend.</p>
      `;
      return;
    }

    const currentPrice = quoteResult.error ? null : quoteResult.quote?.c ?? null;
    const perShareAnnual = dividend.dividendPerShareAnnual ?? 0;
    const paymentsPerYear = PAYMENTS_PER_YEAR[dividend.frequency] || null;

    const amountSpent = avgCost * shares;
    const annualIncome = perShareAnnual * shares;
    const perPaymentIncome = paymentsPerYear ? annualIncome / paymentsPerYear : null;
    const yieldOnCost = (annualIncome / amountSpent) * 100;
    const currentYield = typeof currentPrice === 'number' && currentPrice > 0
      ? (perShareAnnual / currentPrice) * 100
      : null;
    const currentValue = typeof currentPrice === 'number' ? currentPrice * shares : null;

    dividendCalcResultEl.innerHTML = `
      <div class="dividend-calc-grid">
        <div>Qty<span>${shares.toLocaleString()}</span></div>
        <div>Avg. Cost<span>$${fmtMoney(avgCost)}</span></div>
        <div>Total Invested<span>$${fmtMoney(amountSpent)}</span></div>
        <div>Current Price<span>${currentPrice != null ? `$${fmtMoney(currentPrice)}` : '—'}</span></div>
        <div>Current Value<span>${currentValue != null ? `$${fmtMoney(currentValue)}` : '—'}</span></div>
        <div>Pay Frequency<span>${escapeHtml(dividend.frequency || '—')}</span></div>
        <div>Per-Payment Income<span>${perPaymentIncome != null ? `$${fmtMoney(perPaymentIncome)}` : '—'}</span></div>
        <div>Estimated Annual Income<span>$${fmtMoney(annualIncome)}</span></div>
        <div>Yield on Cost<span>${fmtPct(yieldOnCost).replace('+', '')}</span></div>
        <div>Current Yield<span>${currentYield != null ? fmtPct(currentYield).replace('+', '') : '—'}</span></div>
      </div>
      <p class="muted small">Based on ${escapeHtml(symbol)}'s trailing annual dividend of $${fmtMoney(perShareAnnual)}/share${dividend.exDividendDate ? ` · next ex-dividend date ${escapeHtml(dividend.exDividendDate)}` : ''}. Actual future payouts can change.</p>
      ${quoteResult.error ? `<p class="muted small">Live price temporarily unavailable (${escapeHtml(quoteResult.error.message)}) - current value/yield omitted.</p>` : ''}
    `;
  } catch (err) {
    dividendCalcResultEl.innerHTML = `<p class="error-text">Failed to calculate: ${escapeHtml(err.message)}</p>`;
  }
}

dividendCalcForm.addEventListener('submit', calculateDividend);

// Quick preview (last price + dividend yield) without needing qty/avg cost.
async function loadDividendPreview() {
  const symbol = dividendCalcSymbolEl.value.trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    dividendCalcPreviewEl.innerHTML = '<span class="error-text">Enter a valid ticker symbol.</span>';
    return;
  }

  dividendCalcPreviewEl.innerHTML = '<span class="spinner">Loading…</span>';

  try {
    const [quoteResult, dividend] = await Promise.all([
      fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`).catch((err) => ({ error: err })),
      fetchJson(`/api/dividend?symbol=${encodeURIComponent(symbol)}`),
    ]);

    const currentPrice = quoteResult.error ? null : quoteResult.quote?.c ?? null;
    const priceText = currentPrice != null ? `\$${fmtMoney(currentPrice)}` : '—';

    if (!dividend.paysDividend) {
      dividendCalcPreviewEl.innerHTML = `
        <em>${escapeHtml(symbol)} last price:</em> <strong>${priceText}</strong><br/>
        <span class="muted">Doesn't currently pay a dividend.</span>
      `;
      return;
    }

    const perShareAnnual = dividend.dividendPerShareAnnual ?? 0;
    const yieldPct = typeof currentPrice === 'number' && currentPrice > 0
      ? (perShareAnnual / currentPrice) * 100
      : null;

    dividendCalcPreviewEl.innerHTML = `
      <em>${escapeHtml(symbol)} last price:</em> <strong>${priceText}</strong><br/>
      <em>Dividend yield:</em> <strong>${yieldPct != null ? fmtPct(yieldPct).replace('+', '') : '—'}</strong> (\$${fmtMoney(perShareAnnual)} / year)
    `;
  } catch (err) {
    dividendCalcPreviewEl.innerHTML = `<span class="error-text">Failed to load: ${escapeHtml(err.message)}</span>`;
  }
}

dividendCalcLoadBtn.addEventListener('click', loadDividendPreview);

function chartBlockHtml(symbol, type = 'stock') {
  const period = cardPeriod.get(`${type}:${symbol}`) || '1mo';
  const buttons = PERIODS.map((p) => `
    <button type="button" class="period-btn${p === period ? ' active' : ''}" data-symbol="${escapeHtml(symbol)}" data-period="${p}">${p}</button>
  `).join('');

  return `
    <div class="chart-block">
      <div class="chart-header">
        <strong>Price Chart</strong>
        <div class="period-buttons">${buttons}</div>
      </div>
      <div class="chart-canvas-wrap">
        <canvas class="candle-canvas" data-symbol="${escapeHtml(symbol)}"></canvas>
        <div class="chart-tooltip" hidden></div>
      </div>
    </div>
  `;
}

function drawCandles(canvas, candles) {
  const tooltip = canvas.parentElement.querySelector('.chart-tooltip');
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 140;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  if (!candles || !candles.length) {
    ctx.fillStyle = '#8b93a7';
    ctx.font = '12px sans-serif';
    ctx.fillText('No chart data available.', 8, cssHeight / 2);
    return;
  }

  const padding = { top: 8, bottom: 8, left: 4, right: 4 };
  const plotW = cssWidth - padding.left - padding.right;
  const plotH = cssHeight - padding.top - padding.bottom;

  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const range = max - min || 1;

  const n = candles.length;
  const slot = plotW / n;
  const bodyWidth = Math.max(2, slot * 0.6);

  const yFor = (val) => padding.top + plotH - ((val - min) / range) * plotH;

  candles.forEach((candle, i) => {
    const x = padding.left + i * slot + slot / 2;
    const bullish = candle.c >= candle.o;
    const color = bullish ? '#2ecc71' : '#e74c3c';

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yFor(candle.h));
    ctx.lineTo(x, yFor(candle.l));
    ctx.stroke();

    ctx.fillStyle = color;
    const yOpen = yFor(candle.o);
    const yClose = yFor(candle.c);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  });

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.min(n - 1, Math.max(0, Math.floor((x - padding.left) / slot)));
    const candle = candles[idx];
    if (!candle || !tooltip) return;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(x + 8, cssWidth - 130)}px`;
    tooltip.style.top = '4px';
    tooltip.innerHTML = `
      <strong>${escapeHtml(candle.t)}</strong>
      O ${fmtMoney(candle.o)} · H ${fmtMoney(candle.h)}<br>
      L ${fmtMoney(candle.l)} · C ${fmtMoney(candle.c)}
    `;
  };
  canvas.onmouseleave = () => {
    if (tooltip) tooltip.hidden = true;
  };
}

async function loadChartForCard(card) {
  if (!card) return;
  const { symbol, assetType: type = 'stock' } = card.dataset;
  const canvas = card.querySelector('.candle-canvas');
  if (!canvas) return;

  const period = cardPeriod.get(`${type}:${symbol}`) || '1mo';
  const apiPath = type === 'crypto' ? '/api/crypto/candles' : '/api/candles';
  try {
    const res = await fetchJson(`${apiPath}?symbol=${encodeURIComponent(symbol)}&period=${period}`);
    lastCandles.set(`${type}:${symbol}`, res.candles);
    drawCandles(canvas, res.candles);
  } catch {
    drawCandles(canvas, []);
  }
}

function redrawChartForCard(card) {
  if (!card) return;
  const { symbol, assetType: type = 'stock' } = card.dataset;
  const canvas = card.querySelector('.candle-canvas');
  const cached = lastCandles.get(`${type}:${symbol}`);
  if (canvas && cached) drawCandles(canvas, cached);
}

function predictionsBlockHtml(predictions) {
  if (!predictions) return '';
  const { nextEarnings, recommendation } = predictions;

  const earningsHtml = nextEarnings
    ? `
      <div>Next Earnings<span>${escapeHtml(nextEarnings.date)}${nextEarnings.hour ? ` (${escapeHtml(nextEarnings.hour.toUpperCase())})` : ''}</span></div>
      <div>EPS Estimate<span>${nextEarnings.epsEstimate != null ? `$${fmtMoney(nextEarnings.epsEstimate)}` : '—'}</span></div>
      <div>Revenue Estimate<span>${nextEarnings.revenueEstimate != null ? `$${(nextEarnings.revenueEstimate / 1e9).toFixed(2)}B` : '—'}</span></div>
    `
    : '<div>Next Earnings<span>No date scheduled</span></div>';

  const consensus = recommendation?.consensus;
  const recHtml = recommendation
    ? `
      <div class="rec-consensus ${consensus ? escapeHtml(consensus.label.replace(/\s+/g, '')) : ''}">
        Analyst consensus: <strong>${consensus ? escapeHtml(consensus.label) : 'N/A'}</strong>
        <span class="muted">(as of ${escapeHtml(recommendation.period)})</span>
      </div>
      <div class="rec-bars">
        <div class="rec-bar strongbuy" style="flex:${recommendation.strongBuy || 0}" title="Strong Buy: ${recommendation.strongBuy}"></div>
        <div class="rec-bar buy" style="flex:${recommendation.buy || 0}" title="Buy: ${recommendation.buy}"></div>
        <div class="rec-bar hold" style="flex:${recommendation.hold || 0}" title="Hold: ${recommendation.hold}"></div>
        <div class="rec-bar sell" style="flex:${recommendation.sell || 0}" title="Sell: ${recommendation.sell}"></div>
        <div class="rec-bar strongsell" style="flex:${recommendation.strongSell || 0}" title="Strong Sell: ${recommendation.strongSell}"></div>
      </div>
    `
    : '<p class="muted">No analyst recommendation data.</p>';

  return `
    <div class="predictions-block">
      <strong>Incoming Predictions</strong>
      <div class="predictions-grid">${earningsHtml}</div>
      ${recHtml}
    </div>
  `;
}

function cardSkeleton(symbol) {
  return `
    <article class="ticker-card" data-symbol="${escapeHtml(symbol)}" data-asset-type="stock">
      <div class="ticker-card-head">
        <div>
          <div class="ticker-symbol">${escapeHtml(symbol)}</div>
          <div class="ticker-name muted">Loading…</div>
        </div>
      </div>
      <div class="spinner">Loading quote…</div>
    </article>
  `;
}

async function fillStockCard(card, symbol, { showNews = true, collapsed = false } = {}) {
  try {
    const [quoteRes, newsRes, dividendRes, predictionsRes] = await Promise.all([
      fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`),
      showNews ? fetchJson(`/api/news?symbol=${encodeURIComponent(symbol)}`) : Promise.resolve({ items: [] }),
      fetchJson(`/api/dividend?symbol=${encodeURIComponent(symbol)}`).catch(() => ({ paysDividend: false })),
      fetchJson(`/api/predictions?symbol=${encodeURIComponent(symbol)}`).catch(() => null),
    ]);

    const q = quoteRes.quote || {};
    const profile = quoteRes.profile || {};
    const change = q.d ?? 0;
    const pct = q.dp ?? 0;

    const newsHtml = newsRes.items?.length
      ? newsRes.items.map(newsItemHtml).join('')
      : '<p class="muted">No recent news found.</p>';

    const dividendHtml = dividendBlockHtml(dividendRes, q.c);
    const predictionsHtml = predictionsBlockHtml(predictionsRes);

    card.classList.toggle('collapsible', collapsed);
    card.innerHTML = `
      <div class="ticker-card-summary">
        <div class="ticker-card-head">
          <div>
            <div class="ticker-symbol">${escapeHtml(symbol)} <span class="live-dot" data-live="badge" title="Live price stream"></span></div>
            <div class="ticker-name">${escapeHtml(profile.name || '')}</div>
          </div>
          <div style="text-align:right">
            <div class="price" data-live="price">${fmtMoney(q.c)}</div>
            <div class="change ${changeClass(change)}" data-live="change">${fmtMoney(change)} (${fmtPct(pct)})</div>
          </div>
        </div>
        <div class="quote-grid">
          <div>Open<span>${fmtMoney(q.o)}</span></div>
          <div>High<span>${fmtMoney(q.h)}</span></div>
          <div>Low<span>${fmtMoney(q.l)}</span></div>
          <div>Prev Close<span>${fmtMoney(q.pc)}</span></div>
          <div>Market Cap<span>${profile.marketCapitalization ? Math.round(profile.marketCapitalization).toLocaleString() + 'M' : '—'}</span></div>
          <div>Exchange<span>${escapeHtml(profile.exchange || '—')}</span></div>
        </div>
        ${collapsed ? '<span class="expand-indicator" aria-hidden="true">▾</span>' : ''}
      </div>
      <div class="ticker-card-details"${collapsed ? ' hidden' : ''}>
        ${chartBlockHtml(symbol, 'stock')}
        ${dividendHtml}
        ${predictionsHtml}
        ${showNews ? `
        <div class="news-list">
          <strong>Stock News &amp; Speculation</strong>
          ${newsHtml}
        </div>` : ''}
      </div>
    `;
    card.dataset.prevClose = q.pc ?? q.c ?? 0;
    card.dataset.lastPrice = q.c ?? 0;
    if (!collapsed) loadChartForCard(card);
    streamSubscribe(symbol, 'stock');
  } catch (err) {
    card.innerHTML = `
      <div class="ticker-card-head">
        <div class="ticker-symbol">${escapeHtml(symbol)}</div>
      </div>
      <p class="error-text">Failed to load: ${escapeHtml(err.message)}</p>
    `;
  }
}

async function loadCard(symbol) {
  const card = dashboardEl.querySelector(`.ticker-card[data-symbol="${CSS.escape(symbol)}"]`);
  if (!card) return;
  await fillStockCard(card, symbol, { showNews: false, collapsed: true });
}

function renderDashboard() {
  dashboardEl.innerHTML = watchlist.map(cardSkeleton).join('');
  watchlist.forEach(loadCard);
}

// --- Crypto dashboard cards ---

function cryptoCardSkeleton(symbol) {
  return `
    <article class="ticker-card" data-symbol="${escapeHtml(symbol)}" data-asset-type="crypto">
      <div class="ticker-card-head">
        <div>
          <div class="ticker-symbol">${escapeHtml(symbol)}</div>
          <div class="ticker-name muted">Loading…</div>
        </div>
      </div>
      <div class="spinner">Loading quote…</div>
    </article>
  `;
}

async function fillCryptoCard(card, symbol, { showNews = true, collapsed = false } = {}) {
  try {
    const [quoteRes, newsRes] = await Promise.all([
      fetchJson(`/api/crypto/quote?symbol=${encodeURIComponent(symbol)}`),
      showNews ? fetchJson(`/api/crypto/news?symbol=${encodeURIComponent(symbol)}`).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    ]);

    const q = quoteRes.quote || {};
    const change = q.d ?? 0;
    const pct = q.dp ?? 0;

    const newsHtml = newsRes.items?.length
      ? newsRes.items.map(newsItemHtml).join('')
      : '<p class="muted">No recent news found.</p>';

    card.classList.toggle('collapsible', collapsed);
    card.innerHTML = `
      <div class="ticker-card-summary">
        <div class="ticker-card-head">
          <div>
            <div class="ticker-symbol">${escapeHtml(symbol)} <span class="live-dot" data-live="badge" title="Live price stream"></span></div>
            <div class="ticker-name">${escapeHtml(symbol)}/USD · Binance</div>
          </div>
          <div style="text-align:right">
            <div class="price" data-live="price">${fmtMoney(q.c)}</div>
            <div class="change ${changeClass(change)}" data-live="change">${fmtMoney(change)} (${fmtPct(pct)})</div>
          </div>
        </div>
        <div class="quote-grid">
          <div>Open<span>${fmtMoney(q.o)}</span></div>
          <div>High<span>${fmtMoney(q.h)}</span></div>
          <div>Low<span>${fmtMoney(q.l)}</span></div>
          <div>Prev Close<span>${fmtMoney(q.pc)}</span></div>
        </div>
        ${collapsed ? '<span class="expand-indicator" aria-hidden="true">▾</span>' : ''}
      </div>
      <div class="ticker-card-details"${collapsed ? ' hidden' : ''}>
        ${chartBlockHtml(symbol, 'crypto')}
        ${showNews ? `
        <div class="news-list">
          <strong>Crypto News &amp; Speculation</strong>
          ${newsHtml}
        </div>` : ''}
      </div>
    `;
    card.dataset.prevClose = q.pc ?? q.c ?? 0;
    card.dataset.lastPrice = q.c ?? 0;
    if (!collapsed) loadChartForCard(card);
    streamSubscribe(symbol, 'crypto');
  } catch (err) {
    card.innerHTML = `
      <div class="ticker-card-head">
        <div class="ticker-symbol">${escapeHtml(symbol)}</div>
      </div>
      <p class="error-text">Failed to load: ${escapeHtml(err.message)}</p>
    `;
  }
}

async function loadCryptoCard(symbol) {
  const card = cryptoDashboardEl.querySelector(`.ticker-card[data-symbol="${CSS.escape(symbol)}"]`);
  if (!card) return;
  await fillCryptoCard(card, symbol, { showNews: false, collapsed: true });
}

function renderCryptoDashboard() {
  cryptoDashboardEl.innerHTML = cryptoWatchlist.map(cryptoCardSkeleton).join('');
  cryptoWatchlist.forEach(loadCryptoCard);
}

// --- Ticker detail modal ---

function openTickerDetail(symbol, assetType) {
  tickerModalBodyEl.dataset.symbol = symbol;
  tickerModalBodyEl.dataset.assetType = assetType;
  tickerModalBodyEl.innerHTML = `
    <div class="ticker-card-head">
      <div>
        <div class="ticker-symbol">${escapeHtml(symbol)}</div>
        <div class="ticker-name muted">Loading…</div>
      </div>
    </div>
    <div class="spinner">Loading quote & news…</div>
  `;
  tickerModalOverlayEl.hidden = false;
  document.body.classList.add('modal-open');
  if (assetType === 'crypto') fillCryptoCard(tickerModalBodyEl, symbol);
  else fillStockCard(tickerModalBodyEl, symbol);
}

function closeTickerDetail() {
  tickerModalOverlayEl.hidden = true;
  document.body.classList.remove('modal-open');
  tickerModalBodyEl.innerHTML = '';
  delete tickerModalBodyEl.dataset.symbol;
}

function handleChipSymbolClick(e) {
  const btn = e.target.closest('.chip-symbol-btn');
  if (!btn) return;
  btn.classList.remove('bounce');
  void btn.offsetWidth; // restart animation
  btn.classList.add('bounce');
  openTickerDetail(btn.dataset.symbol, btn.dataset.assetType);
}

watchlistBarEl.addEventListener('click', handleChipSymbolClick);
cryptoWatchlistBarEl.addEventListener('click', handleChipSymbolClick);
congressBodyEl.addEventListener('click', (e) => {
  const tickerBtn = e.target.closest('.ticker-link-btn');
  if (tickerBtn && tickerBtn.dataset.symbol) {
    openTickerDetail(tickerBtn.dataset.symbol, 'stock');
    return;
  }

  const groupRow = e.target.closest('.congress-group-row.expandable');
  if (groupRow) {
    const expanded = groupRow.classList.toggle('expanded');
    const gid = groupRow.dataset.group;
    congressBodyEl.querySelectorAll(`.congress-detail-row[data-group="${gid}"]`).forEach((row) => {
      row.classList.toggle('hidden', !expanded);
    });
  }
});

tickerModalCloseEl.addEventListener('click', closeTickerDetail);
tickerModalOverlayEl.addEventListener('click', (e) => {
  if (e.target === tickerModalOverlayEl) closeTickerDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tickerModalOverlayEl.hidden) closeTickerDetail();
});

// --- Congressional trades ---

function tradeAction(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('purchase')) return { label: 'Bought', cls: 'buy' };
  if (t.includes('sale')) return { label: t.includes('partial') ? 'Sold (partial)' : 'Sold', cls: 'sell' };
  if (t.includes('exchange')) return { label: 'Exchanged', cls: 'other' };
  return { label: type || '—', cls: 'other' };
}

const PARTY_LABELS = { D: 'Democrat', R: 'Republican', I: 'Independent', L: 'Libertarian' };

function partyBadge(party) {
  if (!party) return `<span class="badge party unknown" title="Unknown">—</span>`;
  const label = PARTY_LABELS[party] || party;
  return `<span class="badge party ${escapeHtml(label.toLowerCase())}" title="${escapeHtml(label)}">${escapeHtml(party)}</span>`;
}

function daysAgo(dateStr) {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return '';
  const days = Math.max(0, Math.round((Date.now() - t) / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

// STOCK Act filings only disclose a dollar *range* (e.g. "$1,001 - $15,000"), never
// an exact amount, so the best we can do is the midpoint of that bracket.
function amountMidValue(t) {
  if (typeof t.amount_mid === 'number' && !Number.isNaN(t.amount_mid)) return t.amount_mid;
  const nums = String(t.amount || '').match(/[\d,]+/g);
  if (!nums || !nums.length) return null;
  const vals = nums.map((n) => parseInt(n.replace(/,/g, ''), 10)).filter((n) => !Number.isNaN(n));
  if (!vals.length) return null;
  return vals.length > 1 ? (vals[0] + vals[1]) / 2 : vals[0];
}

function fmtAmountEstimate(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return `~$${Math.round(n).toLocaleString()}`;
}

function formatAmountCell(t) {
  const mid = fmtAmountEstimate(amountMidValue(t));
  const range = t.amount || '—';
  if (!mid) return escapeHtml(range);
  return `${escapeHtml(mid)}<div class="muted small">${escapeHtml(range)}</div>`;
}

// Collapses consecutive-or-not trades from the same representative into one
// expandable group so a single busy filer doesn't dominate the feed.
function groupByRepresentative(trades) {
  const order = [];
  const groups = new Map();
  trades.forEach((t) => {
    const key = t.representative || 'Unknown';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(t);
  });
  return order.map((key) => ({ representative: key, trades: groups.get(key) }));
}

function tradeRowCells(t, { byDisclosure, primary, secondary }) {
  const action = tradeAction(t.type);
  return `
      <td>${escapeHtml(primary || '—')}<div class="muted small">${escapeHtml(daysAgo(primary))}</div></td>
      <td class="trader-cell">
        <div class="trader-name">${escapeHtml(t.representative || '—')}</div>
        <div class="muted small">${partyBadge(t.party)} ${escapeHtml(t.district || '—')} · ${escapeHtml(t.owner || 'Self')}</div>
      </td>
      <td><span class="badge ${action.cls}">${escapeHtml(action.label)}</span></td>
      <td class="ticker-cell">${t.ticker ? `<button type="button" class="ticker-link-btn" data-symbol="${escapeHtml(t.ticker)}">${escapeHtml(t.ticker)}</button>` : '—'}</td>
      <td>${formatAmountCell(t)}</td>
      <td class="muted small">${escapeHtml(secondary || '—')}</td>
  `;
}

function renderCongressTrades(trades, { sortedBy = 'transaction' } = {}) {
  if (!trades.length) {
    congressBodyEl.innerHTML = '<p class="muted">No congressional trades found for this ticker/date range.</p>';
    return;
  }

  // In "recent activity" mode the feed is sorted by disclosure date - filings trickle
  // in weeks after the actual trade, so disclosure date is the freshest signal we have.
  const byDisclosure = sortedBy === 'disclosure';
  const primaryLabel = byDisclosure ? 'Disclosed' : 'Date';
  const secondaryLabel = byDisclosure ? 'Traded' : 'Disclosed';

  const groups = groupByRepresentative(trades);

  const rows = groups.map((group, gi) => {
    const first = group.trades[0];
    const isGroup = group.trades.length > 1;
    const primaryDate = byDisclosure ? first.disclosure_date : first.transaction_date;
    const secondaryDate = byDisclosure ? first.transaction_date : first.disclosure_date;

    if (!isGroup) {
      return `<tr>${tradeRowCells(first, { byDisclosure, primary: primaryDate, secondary: secondaryDate })}</tr>`;
    }

    const buyTrades = group.trades.filter((t) => tradeAction(t.type).cls === 'buy');
    const sellTrades = group.trades.filter((t) => tradeAction(t.type).cls === 'sell');
    const buyTotal = fmtAmountEstimate(buyTrades.reduce((sum, t) => sum + (amountMidValue(t) || 0), 0));
    const sellTotal = fmtAmountEstimate(sellTrades.reduce((sum, t) => sum + (amountMidValue(t) || 0), 0));
    const tickers = [...new Set(group.trades.map((t) => t.ticker).filter(Boolean))];
    const tickerPreview = tickers.slice(0, 4).join(', ') + (tickers.length > 4 ? `, +${tickers.length - 4} more` : '');

    const headerRow = `
    <tr class="congress-group-row expandable" data-group="${gi}">
      <td>${escapeHtml(primaryDate || '—')}<div class="muted small">${escapeHtml(daysAgo(primaryDate))}</div></td>
      <td class="trader-cell">
        <div class="trader-name"><span class="expand-caret">▸</span> ${escapeHtml(group.representative)} <span class="muted small">(${group.trades.length} trades)</span></div>
        <div class="muted small">${partyBadge(first.party)} ${escapeHtml(first.district || '—')} · ${escapeHtml(first.owner || 'Self')}</div>
      </td>
      <td>${buyTrades.length ? `<span class="badge buy">${buyTrades.length} Buy</span>` : ''}${sellTrades.length ? ` <span class="badge sell">${sellTrades.length} Sell</span>` : ''}</td>
      <td class="ticker-cell">${escapeHtml(tickerPreview)}</td>
      <td>${buyTotal ? `<div class="amount-buy">${escapeHtml(buyTotal)} bought</div>` : ''}${sellTotal ? `<div class="amount-sell">${escapeHtml(sellTotal)} sold</div>` : ''}<div class="muted small">click to expand</div></td>
      <td class="muted small">—</td>
    </tr>`;

    const detailRows = group.trades.map((t) => {
      const pDate = byDisclosure ? t.disclosure_date : t.transaction_date;
      const sDate = byDisclosure ? t.transaction_date : t.disclosure_date;
      return `<tr class="congress-detail-row hidden" data-group="${gi}">${tradeRowCells(t, { byDisclosure, primary: pDate, secondary: sDate })}</tr>`;
    }).join('');

    return headerRow + detailRows;
  }).join('');

  congressBodyEl.innerHTML = `
    <table class="congress-table">
      <thead>
        <tr>
          <th>${primaryLabel}</th><th>Who</th><th>Action</th><th>Ticker</th><th>Amount</th><th>${secondaryLabel}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderCongressUpdated(latestDisclosureDate) {
  const parts = [`Fetched ${new Date().toLocaleTimeString()}`];
  if (latestDisclosureDate) {
    parts.push(`Latest disclosure on file: ${latestDisclosureDate} (${daysAgo(latestDisclosureDate)}) — filers have up to 45 days to report a trade`);
  }
  congressUpdatedEl.textContent = parts.join(' · ');
}

async function loadCongressTrades({ forceRefresh = false } = {}) {
  const custom = congressCustomEl.value.trim().toUpperCase();
  const selected = congressFilterEl.value;
  const tickersToQuery = custom ? [custom] : (selected ? [selected] : null);
  const repQuery = congressRepFilterEl.value.trim();

  congressBodyEl.innerHTML = '<p class="spinner">Loading congressional trades…</p>';

  try {
    if (tickersToQuery) {
      const results = await Promise.all(
        tickersToQuery.map((sym) => {
          const params = new URLSearchParams({ symbol: sym });
          if (repQuery) params.set('rep', repQuery);
          if (forceRefresh) params.set('refresh', '1');
          return fetchJson(`/api/congress?${params}`).catch((err) => ({
            symbol: sym, available: false, trades: [], message: err.message,
          }));
        })
      );

      const unavailable = results.find((r) => r.available === false);
      if (unavailable) {
        congressBodyEl.innerHTML = `<div class="notice">${escapeHtml(unavailable.message || 'Congressional trading data is unavailable.')}</div>`;
        return;
      }

      const allTrades = results.flatMap((r) => r.trades || []);
      renderCongressTrades(allTrades, { sortedBy: 'transaction' });
      renderCongressUpdated(results.map((r) => r.latestDisclosureDate).filter(Boolean).sort().pop());
    } else {
      // No ticker picked: show the most recently *disclosed* trades across every
      // ticker - who is buying/selling what right now. A representative search
      // widens the window to their full history instead of just the last 2 weeks.
      const params = new URLSearchParams({ limit: '150' });
      if (repQuery) params.set('rep', repQuery);
      else params.set('days', '14');
      if (forceRefresh) params.set('refresh', '1');

      const result = await fetchJson(`/api/congress?${params}`);
      if (result.available === false) {
        congressBodyEl.innerHTML = `<div class="notice">${escapeHtml(result.message || 'Congressional trading data is unavailable.')}</div>`;
        return;
      }
      renderCongressTrades(result.trades || [], { sortedBy: 'disclosure' });
      renderCongressUpdated(result.latestDisclosureDate);
    }
  } catch (err) {
    congressBodyEl.innerHTML = `<p class="error-text">Failed to load congressional trades: ${escapeHtml(err.message)}</p>`;
  }
}

// --- Live price stream (polling) ---
// Serverless hosts can't hold a persistent per-client WebSocket, so "live"
// prices come from polling a batched quote endpoint instead of a pushed feed.
const LIVE_POLL_MS = 5000;
const liveSubs = { stock: new Set(), crypto: new Set() };
let livePollTimer = null;

function startLivePolling() {
  watchlist.forEach((symbol) => streamSubscribe(symbol, 'stock'));
  cryptoWatchlist.forEach((symbol) => streamSubscribe(symbol, 'crypto'));
  INDEX_ITEMS.forEach(({ symbol }) => streamSubscribe(symbol, 'stock'));

  schedulePoll(0);
}

// Back off when polls keep failing (e.g. upstream rate limiting) instead of
// hammering the batch endpoint every LIVE_POLL_MS regardless.
let livePollFailures = 0;
const LIVE_POLL_MAX_MS = 30_000;

function schedulePoll(delay) {
  if (livePollTimer) clearTimeout(livePollTimer);
  livePollTimer = setTimeout(async () => {
    await pollLiveQuotes();
    const nextDelay = livePollFailures
      ? Math.min(LIVE_POLL_MS * 2 ** livePollFailures, LIVE_POLL_MAX_MS)
      : LIVE_POLL_MS;
    schedulePoll(nextDelay);
  }, delay);
}

async function pollLiveQuotes() {
  if (!liveSubs.stock.size && !liveSubs.crypto.size) return;

  const params = new URLSearchParams();
  if (liveSubs.stock.size) params.set('stocks', [...liveSubs.stock].join(','));
  if (liveSubs.crypto.size) params.set('crypto', [...liveSubs.crypto].join(','));

  try {
    const { stocks = [], crypto = [] } = await fetchJson(`/api/quotes-batch?${params}`);
    document.body.classList.add('live-connected');
    livePollFailures = 0;
    stocks.forEach((q) => applyLiveQuote({ ...q, assetType: 'stock' }));
    crypto.forEach((q) => applyLiveQuote({ ...q, assetType: 'crypto' }));
  } catch {
    document.body.classList.remove('live-connected');
    livePollFailures = Math.min(livePollFailures + 1, 4);
  }
}

function streamSubscribe(symbol, assetType) {
  liveSubs[assetType]?.add(symbol);
}

function streamUnsubscribe(symbol, assetType) {
  liveSubs[assetType]?.delete(symbol);
}

function applyLiveQuote(msg) {
  const { symbol, assetType, price } = msg;
  const container = assetType === 'crypto' ? cryptoDashboardEl : dashboardEl;
  const targets = [container.querySelector(`.ticker-card[data-symbol="${CSS.escape(symbol)}"]`)];
  if (assetType === 'stock') {
    targets.push(...tickerTapeTrackEl.querySelectorAll(`.tape-item[data-symbol="${CSS.escape(symbol)}"]`));
  }

  targets.filter(Boolean).forEach((el) => updateLivePriceEl(el, price));
}

function updateLivePriceEl(el, price) {
  const priceEl = el.querySelector('[data-live="price"]');
  const changeEl = el.querySelector('[data-live="change"]');
  if (!priceEl) return;

  const prevPrice = parseFloat(el.dataset.lastPrice || price);
  const prevClose = parseFloat(el.dataset.prevClose || price);
  el.dataset.lastPrice = price;

  const change = price - prevClose;
  const pct = prevClose ? (change / prevClose) * 100 : 0;

  priceEl.textContent = fmtMoney(price);
  if (changeEl) {
    changeEl.textContent = `${fmtMoney(change)} (${fmtPct(pct)})`;
    const baseClass = changeEl.dataset.baseClass || 'change';
    changeEl.className = `${baseClass} ${changeClass(change)}`;
  }

  // Ticker-tape items skip the flash restart: the forced reflow it requires was
  // stalling the main thread on every trade tick, stuttering the scroll animation.
  if (el.classList.contains('tape-item')) return;

  priceEl.classList.remove('flash-up', 'flash-down');
  void priceEl.offsetWidth; // restart animation
  priceEl.classList.add(price >= prevPrice ? 'flash-up' : 'flash-down');
}

function tapeItemHtml({ symbol, label }) {
  return `
    <div class="tape-item" data-symbol="${escapeHtml(symbol)}">
      <span class="tape-label">${escapeHtml(label)}</span>
      <span class="tape-price" data-live="price">—</span>
      <span class="tape-change flat" data-live="change" data-base-class="tape-change">—</span>
    </div>
  `;
}

function renderTickerTape() {
  const itemsHtml = INDEX_ITEMS.map(tapeItemHtml).join('');
  // measure one copy, then duplicate enough times that the track never runs out
  // of content mid-loop on wide viewports (which used to show a blank gap)
  tickerTapeTrackEl.innerHTML = itemsHtml;
  const singleWidth = tickerTapeTrackEl.scrollWidth || 1;
  const viewportWidth = tickerTapeTrackEl.parentElement?.clientWidth || window.innerWidth;
  const copies = Math.max(2, Math.ceil(viewportWidth / singleWidth) + 2);
  tickerTapeTrackEl.innerHTML = itemsHtml.repeat(copies);
  tickerTapeTrackEl.style.setProperty('--tape-copies', copies);
}

async function loadTickerTape() {
  await Promise.all(INDEX_ITEMS.map(async ({ symbol }) => {
    try {
      const res = await fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
      const q = res.quote || {};
      const change = q.d ?? 0;
      const pct = q.dp ?? 0;

      tickerTapeTrackEl.querySelectorAll(`.tape-item[data-symbol="${CSS.escape(symbol)}"]`).forEach((el) => {
        el.dataset.prevClose = q.pc ?? q.c ?? 0;
        el.dataset.lastPrice = q.c ?? 0;
        const priceEl = el.querySelector('[data-live="price"]');
        const changeEl = el.querySelector('[data-live="change"]');
        if (priceEl) priceEl.textContent = fmtMoney(q.c);
        if (changeEl) changeEl.className = `tape-change ${changeClass(change)}`;
        if (changeEl) changeEl.textContent = `${fmtMoney(change)} (${fmtPct(pct)})`;
      });
    } catch {
      // leave placeholder dashes for this index on failure
    }
  }));
}

// --- Event wiring ---

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  addTicker(tickerInput.value);
  tickerInput.value = '';
});

addCryptoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  addCrypto(cryptoInput.value);
  cryptoInput.value = '';
});

congressFilterEl.addEventListener('change', () => {
  congressCustomEl.value = '';
  loadCongressTrades();
});
congressRefreshBtn.addEventListener('click', () => loadCongressTrades({ forceRefresh: true }));
congressCustomEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadCongressTrades();
  }
});

let congressRepDebounce = null;
congressRepFilterEl.addEventListener('input', () => {
  clearTimeout(congressRepDebounce);
  congressRepDebounce = setTimeout(loadCongressTrades, 400);
});
congressRepFilterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(congressRepDebounce);
    loadCongressTrades();
  }
});

function handlePeriodClick(e) {
  const btn = e.target.closest('.period-btn');
  if (!btn) return;
  const card = btn.closest('.ticker-card');
  const { symbol, assetType: type = 'stock' } = card.dataset;
  const { period } = btn.dataset;
  const key = `${type}:${symbol}`;
  if (cardPeriod.get(key) === period) return;
  cardPeriod.set(key, period);
  btn.parentElement.querySelectorAll('.period-btn').forEach((b) => b.classList.toggle('active', b === btn));
  loadChartForCard(card);
}

dashboardEl.addEventListener('click', handlePeriodClick);
cryptoDashboardEl.addEventListener('click', handlePeriodClick);
tickerModalBodyEl.addEventListener('click', handlePeriodClick);

function toggleCardExpand(card) {
  const details = card.querySelector('.ticker-card-details');
  if (!details) return;
  const expanding = details.hidden;
  details.hidden = !expanding;
  card.classList.toggle('expanded', expanding);
  card.classList.remove('bounce');
  void card.offsetWidth; // restart animation
  card.classList.add('bounce');
  // chart canvas has zero size while [hidden], so it needs a redraw once visible
  if (expanding) {
    if (lastCandles.has(`${card.dataset.assetType || 'stock'}:${card.dataset.symbol}`)) redrawChartForCard(card);
    else loadChartForCard(card);
  }
}

function handleCardSummaryClick(e) {
  const summary = e.target.closest('.ticker-card-summary');
  if (!summary) return;
  const card = summary.closest('.ticker-card.collapsible');
  if (card) toggleCardExpand(card);
}

dashboardEl.addEventListener('click', handleCardSummaryClick);
cryptoDashboardEl.addEventListener('click', handleCardSummaryClick);

window.addEventListener('resize', () => {
  document.querySelectorAll('.ticker-card').forEach(redrawChartForCard);
});

let tapeResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(tapeResizeTimer);
  // rebuild copy count for the new viewport width, then repopulate the fresh nodes
  tapeResizeTimer = setTimeout(() => {
    renderTickerTape();
    loadTickerTape();
  }, 250);
});

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabButtons.forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    tabPanels.forEach((panel) => {
      panel.hidden = panel.id !== `tab-${target}`;
    });
    // canvases drawn while hidden fall back to a default size, so redraw once visible
    document.querySelectorAll(`#tab-${target} .ticker-card`).forEach(redrawChartForCard);
  });
});

// --- Init ---

renderStarsField();
renderWatchlistBar();
renderCongressFilterOptions();
renderDashboard();
renderCryptoWatchlistBar();
renderCryptoDashboard();
renderTickerTape();
loadTickerTape();
loadCongressTrades();
startLivePolling();

setInterval(() => {
  watchlist.forEach(loadCard);
  cryptoWatchlist.forEach(loadCryptoCard);
  loadTickerTape();
}, REFRESH_MS);

// Filings trickle in over hours/days, so the congress panel refreshes on its
// own slower cadence instead of the 30s price loop.
const CONGRESS_REFRESH_MS = 5 * 60_000;
setInterval(loadCongressTrades, CONGRESS_REFRESH_MS);
