'use strict';

const STORAGE_KEY = 'finapp.watchlist';
const DEFAULT_WATCHLIST = ['AAPL', 'TSLA', 'NVDA', 'MSFT'];
const CRYPTO_STORAGE_KEY = 'finapp.crypto.watchlist';
const DEFAULT_CRYPTO_WATCHLIST = ['BTC', 'ETH', 'SOL'];
const MAX_WATCHLIST_SIZE = 12;
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
const PERIODS = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y'];
const cardPeriod = new Map(); // `${type}:${symbol}` -> selected chart period
const lastCandles = new Map(); // `${type}:${symbol}` -> last fetched candles (for resize redraws)
const zoomRanges = new Map(); // `${type}:${symbol}` -> [startIdx, endIdx) into lastCandles, when zoomed in
const CHART_STYLE_STORAGE_KEY = 'finapp.chartStyle';
const CHART_STYLES = [
  { id: 'candle', label: 'Candle' },
  { id: 'line', label: 'Line' },
];
// Default chart style applies app-wide (not per-card) - changing it on any
// open card updates every chart currently on screen and future ones too.
let chartStyle = localStorage.getItem(CHART_STYLE_STORAGE_KEY) || 'line';
if (!CHART_STYLES.some((s) => s.id === chartStyle)) chartStyle = 'line';

const DIVIDEND_MODE_STORAGE_KEY = 'finapp.dividendMode';
const DIVIDEND_MODES = ['price', 'dividend'];
// App-wide default (like chartStyle): 'price' = close only, 'dividend' = total
// return with dividends reinvested (compounded into more shares at payout).
let dividendMode = localStorage.getItem(DIVIDEND_MODE_STORAGE_KEY) || 'price';
if (!DIVIDEND_MODES.includes(dividendMode)) dividendMode = 'price';
const cardDividends = new Map(); // `${type}:${symbol}` -> sorted [{date, amount}] (empty if none)
const cardPaysDividend = new Map(); // `${type}:${symbol}` -> bool (dividend toggles greyed out when false)

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
const newsStocksBodyEl = document.getElementById('news-stocks-body');
const newsCryptoBodyEl = document.getElementById('news-crypto-body');
const newsRefreshBtn = document.getElementById('news-refresh');
const dividendCalcForm = document.getElementById('dividend-calc-form');
const dividendCalcSymbolEl = document.getElementById('dividend-calc-symbol');
const dividendCalcSharesEl = document.getElementById('dividend-calc-shares');
const dividendCalcAmountEl = document.getElementById('dividend-calc-amount');
const dividendCalcResultEl = document.getElementById('dividend-calc-result');
const dividendCalcLoadBtn = document.getElementById('dividend-calc-load');
const dividendCalcPreviewEl = document.getElementById('dividend-calc-preview');
const totalReturnForm = document.getElementById('total-return-form');
const totalReturnSymbolEl = document.getElementById('total-return-symbol');
const totalReturnFromEl = document.getElementById('total-return-from');
const totalReturnToEl = document.getElementById('total-return-to');
const totalReturnResultEl = document.getElementById('total-return-result');
const dividendRocForm = document.getElementById('dividend-roc-form');
const dividendRocSymbolsEl = document.getElementById('dividend-roc-symbols');
const dividendRocStatusEl = document.getElementById('dividend-roc-status');
const dividendRocChartBlockEl = document.getElementById('dividend-roc-chart-block');
const dividendRocCanvas = document.getElementById('dividend-roc-canvas');
const dividendRocLegendEl = document.getElementById('dividend-roc-legend');
const dividendRocZoomResetEl = document.getElementById('dividend-roc-zoom-reset');
const dividendRocZoomSelectionEl = document.getElementById('dividend-roc-zoom-selection');
const dividendRocPeriodButtonsEl = document.getElementById('dividend-roc-period-buttons');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
const pullRefreshEl = document.getElementById('pull-refresh-indicator');
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
      if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, MAX_WATCHLIST_SIZE);
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
      if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, MAX_WATCHLIST_SIZE);
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

function addTicker(symbolRaw) {
  const symbol = symbolRaw.trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    alert('Enter a valid ticker symbol (letters/numbers, up to 10 chars).');
    return;
  }
  if (watchlist.includes(symbol)) return;
  if (watchlist.length >= MAX_WATCHLIST_SIZE) {
    alert(`You can track up to ${MAX_WATCHLIST_SIZE} stocks at a time. Remove one before adding another.`);
    return;
  }
  watchlist.push(symbol);
  saveWatchlist(watchlist);
  renderWatchlistBar();
  renderDashboard();
}

function removeTicker(symbol) {
  watchlist = watchlist.filter((s) => s !== symbol);
  saveWatchlist(watchlist);
  streamUnsubscribe(symbol, 'stock');
  renderWatchlistBar();
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
  if (cryptoWatchlist.length >= MAX_WATCHLIST_SIZE) {
    alert(`You can track up to ${MAX_WATCHLIST_SIZE} coins at a time. Remove one before adding another.`);
    return;
  }
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

// Maps sentiment -> CSS class for the small bullish/neutral/bearish indicator dot.
const SENTIMENT_DOT_CLASS = { Bullish: 'green', Bearish: 'red', Neutral: 'yellow' };

function sentimentDotHtml(speculation) {
  if (!speculation?.sentiment) return '';
  const cls = SENTIMENT_DOT_CLASS[speculation.sentiment] || 'yellow';
  return `<span class="sentiment-dot ${cls}" title="${escapeHtml(speculation.sentiment)}" aria-label="${escapeHtml(speculation.sentiment)}"></span>`;
}

function affectedTickersHtml(speculation) {
  const tickers = speculation?.tickers || [];
  const sectors = speculation?.sectors || [];
  if (!tickers.length && !sectors.length) return '';

  const tickerBlock = tickers.length
    ? `
      <div class="affected-tickers">
        <span class="affected-tickers-label">Potentially affects:</span>
        ${tickers.map((t) => `<button type="button" class="ticker-link-btn affected-ticker-chip" data-symbol="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}
      </div>
    `
    : '';

  const sectorBlock = sectors.length
    ? `
      <div class="affected-tickers">
        <span class="affected-tickers-label">Sector:</span>
        ${sectors.map((s) => `<span class="affected-ticker-chip sector-chip">${escapeHtml(s)}</span>`).join('')}
      </div>
    `
    : '';

  return `${tickerBlock}${sectorBlock}`;
}

function newsItemHtml(item) {
  const image = item.image
    ? `<img src="${escapeHtml(item.image)}" alt="" class="news-item-img" loading="lazy" onerror="this.remove()" />`
    : '';
  const summary = item.summary?.trim()
    ? `<p class="news-item-summary-text">${escapeHtml(item.summary)}</p>`
    : '<p class="muted">No summary available.</p>';
  return `
    <div class="news-item collapsible">
      <div class="news-item-summary">
        ${image}
        <div class="news-item-body">
          <div class="news-item-title-row">
            ${sentimentDotHtml(item.speculation)}
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.headline)}</a>
          </div>
          <div class="news-meta">${escapeHtml(item.source)} · ${escapeHtml(timeAgo(item.datetime))}</div>
        </div>
        <span class="news-item-chevron" aria-hidden="true">▾</span>
      </div>
      <div class="news-item-details" hidden>
        ${summary}
        ${affectedTickersHtml(item.speculation)}
        ${speculationBlock(item.speculation)}
      </div>
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
  'Twice-Weekly': 104, Weekly: 52, Monthly: 12, Quarterly: 4, 'Semi-Annual': 2, Annual: 1,
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

// --- Total return calculator ---

async function calculateTotalReturn(e) {
  e.preventDefault();
  const symbol = totalReturnSymbolEl.value.trim().toUpperCase();
  const from = totalReturnFromEl.value;
  const to = totalReturnToEl.value;

  if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
    totalReturnResultEl.innerHTML = '<p class="error-text">Enter a valid ticker symbol.</p>';
    return;
  }
  if (!from || !to || from >= to) {
    totalReturnResultEl.innerHTML = '<p class="error-text">Start date must be before end date.</p>';
    return;
  }

  totalReturnResultEl.innerHTML = '<p class="spinner">Calculating…</p>';

  try {
    const r = await fetchJson(`/api/total-return?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`);
    const priceChange = r.endPrice - r.startPrice;
    const priceReturnPct = (priceChange / r.startPrice) * 100;
    const dividendReturnPct = (r.dividendsTotal / r.startPrice) * 100;
    const dripEndingValue = r.dripEndingShares * r.endPrice;

    totalReturnResultEl.innerHTML = `
      <div class="total-return-method">
        <strong>Cash Dividends <span class="muted small">(simple - dividends banked, not reinvested)</span></strong>
        <div class="total-return-grid">
          <div>Start<span>$${fmtMoney(r.startPrice)} <span class="muted small">(${escapeHtml(r.startDate)})</span></span></div>
          <div>End<span>$${fmtMoney(r.endPrice)} <span class="muted small">(${escapeHtml(r.endDate)})</span></span></div>
          <div>Price Change<span class="${changeClass(priceChange)}">${fmtMoney(priceChange)} (${fmtPct(priceReturnPct)})</span></div>
          <div>Dividends Received<span>$${fmtMoney(r.dividendsTotal)}${r.dividendCount ? ` <span class="muted small">(${r.dividendCount} payment${r.dividendCount === 1 ? '' : 's'})</span>` : ''}</span></div>
          <div>Dividend Return<span>${fmtPct(dividendReturnPct)}</span></div>
          <div>Total Return<span class="${changeClass(r.totalReturnPct)}">${fmtPct(r.totalReturnPct)}</span></div>
        </div>
      </div>
      <div class="total-return-method">
        <strong>DRIP <span class="muted small">(each payment reinvested into more shares at that day's price)</span></strong>
        <div class="total-return-grid">
          <div>Starting Shares<span>1.0000</span></div>
          <div>Ending Shares<span>${r.dripEndingShares.toFixed(4)}</span></div>
          <div>Ending Value<span>$${fmtMoney(dripEndingValue)}</span></div>
          <div>Total Return<span class="${changeClass(r.dripTotalReturnPct)}">${fmtPct(r.dripTotalReturnPct)}</span></div>
        </div>
      </div>
      <p class="muted small">Per-share basis, 1 share bought at ${escapeHtml(r.startDate)}, held to ${escapeHtml(r.endDate)}. Simple: Total Return % = [(End − Start) + Dividends] / Start × 100. DRIP: Ending shares = 1 × ∏(1 + dividend / price at payment); Total Return % = (Ending shares × End Price − Start) / Start × 100.</p>
    `;
  } catch (err) {
    totalReturnResultEl.innerHTML = `<p class="error-text">Failed to calculate: ${escapeHtml(err.message)}</p>`;
  }
}

totalReturnForm.addEventListener('submit', calculateTotalReturn);

// --- Dividend ROC (rate of change) chart ---

const ROC_LINE_COLORS = ['#4d9bff', '#2ecc71', '#e74c3c', '#f1c40f', '#9b59b6', '#1abc9c', '#ff8a65', '#ec7fa9'];
const MAX_ROC_TICKERS = 8;
let lastRocSeries = null; // redrawn on resize / tab reveal since a hidden canvas has zero size
let rocZoomRange = null; // [startMs, endMs] drag-zoomed date range, or null for the full history

// Turns a sorted [{date, amount}] payment history into % change vs. the
// previous payment (there's no "previous" for the first entry, so it's dropped).
function computeDividendRocSeries(history) {
  const points = [];
  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1];
    const cur = history[i];
    if (!prev.amount) continue;
    points.push({
      date: cur.date,
      amount: cur.amount,
      pct: Math.round(((cur.amount - prev.amount) / prev.amount) * 10000) / 100,
    });
  }
  return points;
}

function updateRocZoomResetVisibility(zoomed) {
  if (dividendRocZoomResetEl) dividendRocZoomResetEl.hidden = !zoomed;
}

function drawDividendRocChart(canvas, series) {
  const wrap = canvas.parentElement;
  const tooltip = wrap.querySelector('.chart-tooltip');
  const selectionEl = wrap.querySelector('.chart-zoom-selection');
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 160;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  // Dates within the current zoom range (if any), scoped per series so each
  // line's own scale reflects only what's currently visible.
  const plotted = rocZoomRange
    ? series.map((s) => ({
      ...s,
      points: s.points.filter((p) => {
        const t = new Date(p.date).getTime();
        return t >= rocZoomRange[0] && t <= rocZoomRange[1];
      }),
    }))
    : series;

  const allPoints = plotted.flatMap((s) => s.points);
  if (!allPoints.length) {
    ctx.fillStyle = '#8b93a7';
    ctx.font = '12px sans-serif';
    ctx.fillText('No dividend history in this range.', 8, cssHeight / 2);
    return;
  }

  const padding = { top: 8, bottom: 16, left: 4, right: 50 };
  const plotW = cssWidth - padding.left - padding.right;
  const plotH = cssHeight - padding.top - padding.bottom;

  const times = allPoints.map((p) => new Date(p.date).getTime());
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const timeRange = maxT - minT || 1;

  const pcts = allPoints.map((p) => p.pct);
  let minPct = Math.min(0, ...pcts);
  let maxPct = Math.max(0, ...pcts);
  if (minPct === maxPct) { minPct -= 1; maxPct += 1; }
  const pctRange = maxPct - minPct;

  const xFor = (t) => padding.left + ((t - minT) / timeRange) * plotW;
  const yFor = (pct) => padding.top + plotH - ((pct - minPct) / pctRange) * plotH;

  const GRID_LINES = 4;
  ctx.font = '10px sans-serif';
  for (let i = 0; i <= GRID_LINES; i += 1) {
    const val = minPct + (pctRange * i) / GRID_LINES;
    const y = yFor(val);
    ctx.strokeStyle = 'rgba(139, 147, 167, 0.15)';
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(cssWidth - padding.right, y);
    ctx.stroke();
    ctx.fillStyle = '#8b93a7';
    ctx.textAlign = 'left';
    ctx.fillText(`${val.toFixed(1)}%`, cssWidth - padding.right + 4, y + 3);
  }

  if (minPct < 0 && maxPct > 0) {
    ctx.strokeStyle = 'rgba(139, 147, 167, 0.4)';
    ctx.beginPath();
    ctx.moveTo(padding.left, yFor(0));
    ctx.lineTo(cssWidth - padding.right, yFor(0));
    ctx.stroke();
  }

  const TICKS = 5;
  ctx.textAlign = 'center';
  for (let i = 0; i < TICKS; i += 1) {
    const t = minT + (timeRange * i) / (TICKS - 1);
    ctx.fillText(formatAxisDate(new Date(t).toISOString().slice(0, 10)), xFor(t), cssHeight - 2);
  }
  ctx.textAlign = 'left';

  plotted.forEach((s) => {
    if (!s.points.length) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = xFor(new Date(p.date).getTime());
      const y = yFor(p.pct);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  // Snapshot of the static lines/grid, repainted each mousemove so the traced
  // hover circles can be redrawn without leaving trails behind on the canvas.
  const baseSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Drag-select a date range on the chart to zoom in on it, same interaction
  // as the per-card price charts.
  let dragStartX = null;

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (dragStartX != null) {
      if (selectionEl) {
        const left = Math.min(dragStartX, x);
        const width = Math.abs(x - dragStartX);
        selectionEl.hidden = false;
        selectionEl.style.left = `${left}px`;
        selectionEl.style.width = `${width}px`;
      }

      // While highlighting a range, show the summed payout + elapsed time for
      // whatever falls inside the drag instead of a single-point readout.
      if (tooltip) {
        const tA = minT + ((Math.min(dragStartX, x) - padding.left) / plotW) * timeRange;
        const tB = minT + ((Math.max(dragStartX, x) - padding.left) / plotW) * timeRange;

        const sums = plotted
          .map((s) => {
            const inRange = s.points.filter((p) => {
              const t = new Date(p.date).getTime();
              return t >= tA && t <= tB;
            });
            if (!inRange.length) return null;
            const total = inRange.reduce((sum, p) => sum + p.amount, 0);
            return { symbol: s.symbol, color: s.color, total, count: inRange.length };
          })
          .filter(Boolean);

        if (sums.length) {
          const days = Math.max(0, Math.round((tB - tA) / (24 * 60 * 60 * 1000)));
          tooltip.innerHTML = `
            ${sums.map((s) => `<strong style="color:${s.color}">${escapeHtml(s.symbol)}</strong> \u03a3 $${fmtMoney(s.total)}/share (${s.count} payment${s.count === 1 ? '' : 's'})`).join('<br>')}
            <br><em>${days} day${days === 1 ? '' : 's'} selected</em>
          `;
          tooltip.hidden = false;
          tooltip.style.left = `${Math.min(x + 12, cssWidth - tooltip.offsetWidth - 4)}px`;
          tooltip.style.top = `${Math.min(y + 12, cssHeight - tooltip.offsetHeight - 4)}px`;
        } else {
          tooltip.hidden = true;
        }
      }
      return;
    }

    const t = minT + ((x - padding.left) / plotW) * timeRange;

    const hits = [];
    plotted.forEach((s) => {
      if (!s.points.length) return;
      let closest = s.points[0];
      let closestDiff = Math.abs(new Date(closest.date).getTime() - t);
      s.points.forEach((p) => {
        const diff = Math.abs(new Date(p.date).getTime() - t);
        if (diff < closestDiff) { closest = p; closestDiff = diff; }
      });
      if (Math.abs(xFor(new Date(closest.date).getTime()) - x) < 30) {
        hits.push({ symbol: s.symbol, color: s.color, point: closest });
      }
    });

    ctx.putImageData(baseSnapshot, 0, 0);
    hits.forEach((h) => {
      const hx = xFor(new Date(h.point.date).getTime());
      const hy = yFor(h.point.pct);
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = h.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    });

    if (!tooltip) return;
    if (!hits.length) { tooltip.hidden = true; return; }

    tooltip.innerHTML = hits
      .map((h) => `<strong style="color:${h.color}">${escapeHtml(h.symbol)}</strong> $${fmtMoney(h.point.amount)}/share · ${fmtPct(h.point.pct)} · ${escapeHtml(h.point.date)}`)
      .join('<br>');
    tooltip.hidden = false;
    // Anchored to the cursor's bottom-right, clamped so it never overflows the chart.
    tooltip.style.left = `${Math.min(x + 12, cssWidth - tooltip.offsetWidth - 4)}px`;
    tooltip.style.top = `${Math.min(y + 12, cssHeight - tooltip.offsetHeight - 4)}px`;
  };

  canvas.onmousedown = (e) => {
    if (allPoints.length < 3) return;
    const rect = canvas.getBoundingClientRect();
    dragStartX = e.clientX - rect.left;
  };

  canvas.onmouseup = (e) => {
    if (dragStartX == null) return;
    const rect = canvas.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const startX = dragStartX;
    dragStartX = null;
    if (selectionEl) selectionEl.hidden = true;
    if (tooltip) tooltip.hidden = true; // clear the accumulated-selection readout
    if (Math.abs(endX - startX) < 12) return; // too small a drag - treat as a plain click

    const tA = minT + ((Math.min(startX, endX) - padding.left) / plotW) * timeRange;
    const tB = minT + ((Math.max(startX, endX) - padding.left) / plotW) * timeRange;
    if (tB - tA < 24 * 60 * 60 * 1000) return; // less than a day selected - not a useful zoom

    rocZoomRange = [tA, tB];
    updateRocZoomResetVisibility(true);
    drawDividendRocChart(canvas, series);
  };

  canvas.ondblclick = () => {
    if (!rocZoomRange) return;
    rocZoomRange = null;
    updateRocZoomResetVisibility(false);
    drawDividendRocChart(canvas, series);
  };

  canvas.onmouseleave = () => {
    dragStartX = null;
    if (selectionEl) selectionEl.hidden = true;
    ctx.putImageData(baseSnapshot, 0, 0);
    if (tooltip) tooltip.hidden = true;
  };
}

let lastRocSymbols = []; // re-used when switching the lookback period buttons
let rocYears = 5;

async function loadDividendRoc(symbols, years) {
  lastRocSymbols = symbols;
  rocYears = years;
  dividendRocStatusEl.textContent = 'Loading dividend history…';
  dividendRocChartBlockEl.hidden = true;

  const results = await Promise.all(symbols.map(async (symbol) => {
    try {
      const res = await fetchJson(`/api/dividend-history?symbol=${encodeURIComponent(symbol)}&years=${years}`);
      return { symbol, history: res.history || [] };
    } catch {
      return { symbol, history: [] };
    }
  }));

  const series = results.map((r, i) => ({
    symbol: r.symbol,
    color: ROC_LINE_COLORS[i % ROC_LINE_COLORS.length],
    points: computeDividendRocSeries(r.history),
  }));

  const missing = series.filter((s) => !s.points.length).map((s) => s.symbol);
  const usable = series.filter((s) => s.points.length);

  if (!usable.length) {
    dividendRocStatusEl.textContent = `No dividend history found for ${missing.join(', ')}.`;
    dividendRocChartBlockEl.hidden = true;
    lastRocSeries = null;
    return;
  }

  dividendRocStatusEl.textContent = missing.length
    ? `No dividend history for ${missing.join(', ')} - showing the rest.`
    : '';

  dividendRocLegendEl.innerHTML = usable
    .map((s) => `<span class="roc-legend-item"><i style="background:${s.color}"></i>${escapeHtml(s.symbol)}</span>`)
    .join('');

  dividendRocChartBlockEl.hidden = false;
  lastRocSeries = usable;
  rocZoomRange = null;
  updateRocZoomResetVisibility(false);
  drawDividendRocChart(dividendRocCanvas, usable);
}

async function plotDividendRoc(e) {
  e.preventDefault();
  const symbols = [...new Set(
    dividendRocSymbolsEl.value.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
  )].slice(0, MAX_ROC_TICKERS);

  if (!symbols.length) {
    dividendRocStatusEl.textContent = 'Enter at least one ticker.';
    dividendRocChartBlockEl.hidden = true;
    return;
  }

  await loadDividendRoc(symbols, rocYears);
}

dividendRocForm.addEventListener('submit', plotDividendRoc);

dividendRocPeriodButtonsEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('.period-btn');
  const years = parseInt(btn?.dataset.years, 10);
  if (!years || !lastRocSymbols.length) return;
  dividendRocPeriodButtonsEl.querySelectorAll('.period-btn').forEach((b) => b.classList.toggle('active', b === btn));
  loadDividendRoc(lastRocSymbols, years);
});

dividendRocZoomResetEl?.addEventListener('click', () => {
  if (!lastRocSeries) return;
  rocZoomRange = null;
  updateRocZoomResetVisibility(false);
  drawDividendRocChart(dividendRocCanvas, lastRocSeries);
});

function chartBlockHtml(symbol, assetType = 'stock') {
  const period = cardPeriod.get(`${assetType}:${symbol}`) || '1mo';
  const periodButtons = PERIODS.map((p) => `
    <button type="button" class="period-btn${p === period ? ' active' : ''}" data-symbol="${escapeHtml(symbol)}" data-period="${p}">${p}</button>
  `).join('');
  const currentStyle = CHART_STYLES.find((s) => s.id === chartStyle) || CHART_STYLES[0];

  return `
    <div class="chart-block">
      <div class="chart-header">
        <strong>Price Chart</strong>
        <div class="chart-controls">
          <div class="period-buttons">${periodButtons}</div>
          <button type="button" class="chart-zoom-reset" hidden>Reset Zoom</button>
        </div>
      </div>
      <div class="dividend-mode-toggle" role="group" aria-label="Return view">
        <button type="button" class="div-mode-btn active" data-div-mode="price">Price</button>
        <button type="button" class="div-mode-btn" data-div-mode="dividend" disabled title="Mark each dividend payment on the price chart">Dividend</button>
      </div>
      <div class="chart-canvas-wrap">
        <canvas class="candle-canvas" data-symbol="${escapeHtml(symbol)}"></canvas>
        <div class="chart-zoom-selection" hidden></div>
        <div class="chart-tooltip" hidden></div>
      </div>
      <p class="muted small chart-hint">Drag on the chart to zoom in for more precise pricing · double-click or Reset Zoom to zoom back out.</p>
      <button type="button" class="chart-style-toggle" title="Chart style: ${currentStyle.label} (click to switch)">${currentStyle.label}</button>
    </div>
  `;
}

// Shortens a "YYYY-MM-DD" candle date into a compact "M/D" axis tick label.
function formatAxisDate(dateStr) {
  const parts = String(dateStr || '').split('-');
  if (parts.length !== 3) return dateStr || '';
  return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
}

function visibleCandles(key) {
  const full = lastCandles.get(key);
  if (!full) return full;
  const range = zoomRanges.get(key);
  return range ? full.slice(range[0], range[1]) : full;
}

function updateZoomResetVisibility(canvas, zoomed) {
  const resetBtn = canvas.closest('.chart-block')?.querySelector('.chart-zoom-reset');
  if (resetBtn) resetBtn.hidden = !zoomed;
}

// Dividends whose date actually falls inside the visible candle range -
// shared by dividendMarkers and the toggle-enable check so both
// agree on what counts as "this period has a dividend to show".
function dividendsInWindow(candles, dividends) {
  if (!candles.length || !dividends || !dividends.length) return [];
  const start = candles[0].t;
  const end = candles[candles.length - 1].t;
  return dividends.filter((d) => d.date > start && d.date <= end && d.amount > 0);
}

// Maps each in-window dividend payment to the candle it lands on (or the
// next one, if the ex-date itself isn't a trading day in this data), so it
// can be drawn as a marker directly on the price/candle line at that point.
function dividendMarkers(candles, dividends) {
  return dividendsInWindow(candles, dividends).map((d) => {
    let idx = candles.findIndex((c) => c.t >= d.date);
    if (idx === -1) idx = candles.length - 1;
    return { idx, amount: d.amount, date: d.date };
  });
}

function drawCandles(canvas, candles, { style = chartStyle, key = null } = {}) {
  const wrap = canvas.parentElement;
  const tooltip = wrap.querySelector('.chart-tooltip');
  const selectionEl = wrap.querySelector('.chart-zoom-selection');
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 140;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  if (!candles || !candles.length) {
    ctx.fillStyle = '#8b93a7';
    ctx.font = '12px sans-serif';
    ctx.fillText('No chart data available.', 8, cssHeight / 2);
    return;
  }

  // Dividend overlay: markers on the actual price/candle line showing each
  // per-share payment. Only active when a dividend actually landed within the
  // visible window - a quarterly payer viewed on "1mo"/"5d" usually has none.
  const divs = dividendMode !== 'price' && key ? cardDividends.get(key) : null;
  const divMarkers = divs ? dividendMarkers(candles, divs) : [];
  const divActive = divMarkers.length > 0;

  // Extra right/bottom padding makes room for the price and date axis labels.
  const padding = { top: 8, bottom: 16, left: 4, right: 44 };
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
  const xFor = (i) => padding.left + i * slot + slot / 2;

  // Price gridlines + axis labels, for precisely reading a value off the chart.
  const GRID_LINES = 4;
  ctx.font = '10px sans-serif';
  for (let i = 0; i <= GRID_LINES; i += 1) {
    const val = min + (range * i) / GRID_LINES;
    const y = yFor(val);
    ctx.strokeStyle = 'rgba(139, 147, 167, 0.15)';
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(cssWidth - padding.right, y);
    ctx.stroke();
    ctx.fillStyle = '#8b93a7';
    ctx.textAlign = 'left';
    ctx.fillText(`$${fmtMoney(val)}`, cssWidth - padding.right + 4, y + 3);
  }

  // Date axis ticks, evenly spaced across whatever range is currently shown.
  const TICKS = Math.min(5, n);
  ctx.textAlign = 'center';
  for (let i = 0; i < TICKS; i += 1) {
    const idx = Math.round((i / Math.max(1, TICKS - 1)) * (n - 1));
    const candle = candles[idx];
    if (!candle) continue;
    ctx.fillText(formatAxisDate(candle.t), xFor(idx), cssHeight - 2);
  }
  ctx.textAlign = 'left';

  if (style === 'line') {
    ctx.strokeStyle = '#4d9bff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    candles.forEach((candle, i) => {
      const x = xFor(i);
      const y = yFor(candle.c);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.lineTo(xFor(n - 1), padding.top + plotH);
    ctx.lineTo(xFor(0), padding.top + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(77, 155, 255, 0.12)';
    ctx.fill();
  } else {
    candles.forEach((candle, i) => {
      const x = xFor(i);
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
  }

  if (divActive) {
    // Candlesticks already fill the price area, so a marker following the
    // close price gets buried in/behind candle bodies - anchor it along the
    // bottom axis instead. The line style has no such crowding, so its
    // marker still tracks the price point with a guide line down to the axis.
    const bottomY = padding.top + plotH - 6;
    divMarkers.forEach((m) => {
      const x = xFor(m.idx);
      const y = style === 'line' ? yFor(candles[m.idx].c) : bottomY;

      if (style === 'line') {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = 'rgba(46, 204, 113, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, padding.top + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#2ecc71';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#0b0f17';
      ctx.stroke();
    });

    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.beginPath();
    ctx.arc(padding.left + 6, padding.top + 6, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#2ecc71';
    ctx.fill();
    ctx.fillStyle = '#c9d1e0';
    ctx.fillText('Dividend payment', padding.left + 14, padding.top + 9);
  }

  const indexForX = (x) => Math.min(n - 1, Math.max(0, Math.floor((x - padding.left) / slot)));

  // Snapshot of the static chart (including dividend markers), so hover state
  // can be repainted on top each mousemove without redrawing from scratch.
  const baseSnapshot = (divActive || style === 'line') ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;

  // Drag-select a range on the chart to zoom in on it for a more precise view.
  let dragStartX = null;

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (dragStartX != null && selectionEl) {
      const left = Math.min(dragStartX, x);
      const width = Math.abs(x - dragStartX);
      selectionEl.hidden = false;
      selectionEl.style.left = `${left}px`;
      selectionEl.style.width = `${width}px`;
    }

    const idx = indexForX(x);
    const candle = candles[idx];
    if (!candle || !tooltip) return;

    if (baseSnapshot) {
      ctx.putImageData(baseSnapshot, 0, 0);
      // The floating hover dot only makes sense on the continuous line style -
      // candles already mark each date, and dividend markers are static.
      if (style === 'line') {
        const hx = xFor(idx);
        const hy = yFor(candle.c);
        ctx.beginPath();
        ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#4d9bff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    }

    const marker = divActive ? divMarkers.find((m) => m.idx === idx) : null;

    tooltip.hidden = false;
    // Follows the cursor, offset to its bottom-right, clamped so it stays inside the chart.
    tooltip.style.left = `${Math.min(x + 12, cssWidth - 150)}px`;
    tooltip.style.top = `${Math.min(y + 12, cssHeight - (marker ? 76 : 56))}px`;
    tooltip.innerHTML = `
      <strong>${escapeHtml(candle.t)}</strong>
      O ${fmtMoney(candle.o)} · H ${fmtMoney(candle.h)}<br>
      L ${fmtMoney(candle.l)} · C ${fmtMoney(candle.c)}
      ${marker ? `<br><span style="color:#2ecc71">Dividend $${fmtMoney(marker.amount)}/share</span>` : ''}
    `;
  };

  canvas.onmousedown = (e) => {
    if (!key || n < 3) return;
    const rect = canvas.getBoundingClientRect();
    dragStartX = e.clientX - rect.left;
  };

  canvas.onmouseup = (e) => {
    if (dragStartX == null) return;
    const rect = canvas.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const startX = dragStartX;
    dragStartX = null;
    if (selectionEl) selectionEl.hidden = true;
    if (!key || Math.abs(endX - startX) < 12) return; // too small a drag - treat as a plain click

    const idxA = indexForX(Math.min(startX, endX));
    const idxB = indexForX(Math.max(startX, endX));
    if (idxB - idxA < 2) return; // not enough candles selected to be a useful zoom

    // idxA/idxB index into whatever slice is currently shown, so offset by the
    // existing zoom's start (if any) to keep the range anchored on the full data.
    const base = zoomRanges.get(key)?.[0] || 0;
    zoomRanges.set(key, [base + idxA, base + idxB + 1]);
    const card = canvas.closest('.ticker-card');
    updateZoomResetVisibility(canvas, true);
    redrawChartForCard(card);
  };

  canvas.ondblclick = () => {
    if (!key || !zoomRanges.has(key)) return;
    zoomRanges.delete(key);
    updateZoomResetVisibility(canvas, false);
    redrawChartForCard(canvas.closest('.ticker-card'));
  };

  canvas.onmouseleave = () => {
    dragStartX = null;
    if (selectionEl) selectionEl.hidden = true;
    if (tooltip) tooltip.hidden = true;
    if (baseSnapshot) ctx.putImageData(baseSnapshot, 0, 0);
  };
}

// Lazily loads a stock's dividend history (cached per card) so the total-return
// overlays can be computed. Crypto never pays dividends, so it's skipped.
async function ensureCardDividends(key, symbol, type) {
  if (cardDividends.has(key)) return;
  if (type === 'crypto') {
    cardDividends.set(key, []);
    cardPaysDividend.set(key, false);
    return;
  }
  try {
    const res = await fetchJson(`/api/dividend-history?symbol=${encodeURIComponent(symbol)}&years=5`);
    const history = (res.history || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    cardDividends.set(key, history);
    cardPaysDividend.set(key, history.length > 0);
  } catch {
    cardDividends.set(key, []);
    cardPaysDividend.set(key, false);
  }
}

// Enables/greys-out the dividend toggle buttons for a card and keeps the active
// highlight in sync with the global mode. Falls back to Price when the ticker
// pays nothing at all, OR when it pays but none of its payments fall inside
// the currently visible period - either way the overlay would be a no-op, so
// users never see a toggle that silently does nothing.
function updateDividendToggle(card, pays, hasDivsInWindow) {
  const toggle = card.querySelector('.dividend-mode-toggle');
  if (!toggle) return;
  const usable = pays && hasDivsInWindow;
  const effectiveMode = usable ? dividendMode : 'price';
  toggle.classList.toggle('no-dividend', !usable);
  toggle.querySelectorAll('.div-mode-btn').forEach((btn) => {
    const mode = btn.dataset.divMode;
    if (mode === 'price') return;
    btn.disabled = !usable;
    btn.classList.toggle('active', mode === effectiveMode);
    btn.title = !pays
      ? "This ticker doesn't pay a dividend"
      : !hasDivsInWindow
        ? 'No dividend payments in the selected date range'
        : 'Mark each dividend payment on the price chart';
  });
}

async function loadChartForCard(card) {
  if (!card) return;
  const { symbol, assetType: type = 'stock' } = card.dataset;
  const canvas = card.querySelector('.candle-canvas');
  if (!canvas) return;
  const key = `${type}:${symbol}`;

  const period = cardPeriod.get(key) || '1mo';
  const apiPath = type === 'crypto' ? '/api/crypto/candles' : '/api/candles';
  try {
    const [res] = await Promise.all([
      fetchJson(`${apiPath}?symbol=${encodeURIComponent(symbol)}&period=${period}`),
      ensureCardDividends(key, symbol, type),
    ]);
    updateDividendToggle(card, cardPaysDividend.get(key), dividendsInWindow(res.candles, cardDividends.get(key)).length > 0);
    lastCandles.set(key, res.candles);
    zoomRanges.delete(key); // fresh data (new period) invalidates any prior zoom
    updateZoomResetVisibility(canvas, false);
    drawCandles(canvas, res.candles, { key });
  } catch {
    lastCandles.delete(key);
    zoomRanges.delete(key);
    drawCandles(canvas, [], { key });
  }
}

function redrawChartForCard(card) {
  if (!card) return;
  const { symbol, assetType: type = 'stock' } = card.dataset;
  const canvas = card.querySelector('.candle-canvas');
  const key = `${type}:${symbol}`;
  const candles = visibleCandles(key);
  if (canvas && candles) drawCandles(canvas, candles, { key });
}

function handleChartZoomResetClick(e) {
  const btn = e.target.closest('.chart-zoom-reset');
  if (!btn) return;
  const card = btn.closest('.ticker-card');
  if (!card) return;
  const { symbol, assetType: type = 'stock' } = card.dataset;
  zoomRanges.delete(`${type}:${symbol}`);
  btn.hidden = true;
  redrawChartForCard(card);
}

dashboardEl.addEventListener('click', handleChartZoomResetClick);
cryptoDashboardEl.addEventListener('click', handleChartZoomResetClick);
tickerModalBodyEl.addEventListener('click', handleChartZoomResetClick);

// Per-representative buy/sell rollup for a single ticker, shown inline on the
// stock card. Amounts are midpoints of the disclosed STOCK Act dollar ranges.
function congressCardBlockHtml(trades) {
  if (!trades.length) {
    return `
      <div class="congress-card-block no-trades">
        <strong>Congressional Trading</strong>
        <p class="muted">No disclosed congressional trades in the last year.</p>
      </div>
    `;
  }

  const rows = groupByRepresentative(trades).map((group) => {
    const first = group.trades[0];
    const buys = group.trades.filter((t) => tradeAction(t.type).cls === 'buy');
    const sells = group.trades.filter((t) => tradeAction(t.type).cls === 'sell');
    const sumMid = (list) => list.reduce((sum, t) => sum + (amountMidValue(t) || 0), 0);
    const buyTotal = buys.length ? fmtAmountEstimate(sumMid(buys)) : null;
    const sellTotal = sells.length ? fmtAmountEstimate(sumMid(sells)) : null;
    const latest = group.trades
      .map((t) => t.transaction_date)
      .filter(Boolean)
      .sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0))[0];

    return `
      <li>
        <div class="congress-card-who">
          <span class="trader-name">${escapeHtml(group.representative)}</span>
          <span class="muted small">${partyBadge(first.party)} ${escapeHtml(chamberLabel(first.chamber))} ${escapeHtml(first.district || '—')}</span>
        </div>
        <div class="congress-card-amounts">
          ${buyTotal ? `<span class="amount-buy">${escapeHtml(buyTotal)} bought<span class="muted small"> (${buys.length})</span></span>` : ''}
          ${sellTotal ? `<span class="amount-sell">${escapeHtml(sellTotal)} sold<span class="muted small"> (${sells.length})</span></span>` : ''}
        </div>
        <div class="muted small">${escapeHtml(latest || '—')}${latest ? ` · ${escapeHtml(daysAgo(latest))}` : ''}</div>
      </li>
    `;
  }).join('');

  return `
    <div class="congress-card-block">
      <strong>Congressional Trading <span class="muted small">(last 12 months, ${trades.length} filings)</span></strong>
      <ul class="congress-card-list">${rows}</ul>
    </div>
  `;
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
    const quoteRes = await fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`);

    const q = quoteRes.quote || {};
    const profile = quoteRes.profile || {};
    const change = q.d ?? 0;
    const pct = q.dp ?? 0;

    card.classList.toggle('collapsible', collapsed);
    card.dataset.detailsLoaded = 'false';
    card.innerHTML = `
      <div class="ticker-card-summary">
        <div class="ticker-card-head">
          <div>
            <div class="ticker-symbol">${escapeHtml(symbol)} <span class="live-dot" data-live="badge" title="Live price stream"></span>${collapsed ? ' <button type="button" class="card-lock-toggle" aria-pressed="false" title="Lock card open">🔓</button>' : ''}</div>
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
        <p class="spinner">Loading details…</p>
      </div>
    `;
    card.dataset.prevClose = q.pc ?? q.c ?? 0;
    card.dataset.lastPrice = q.c ?? 0;
    streamSubscribe(symbol, 'stock');
    // Dividend/predictions/news/chart are only fetched once the card is actually
    // expanded - fetching them for every collapsed dashboard card upfront was
    // tripping Finnhub/Yahoo's rate limits on a full watchlist load.
    if (!collapsed) await loadStockCardDetails(card, symbol, { showNews });
  } catch (err) {
    card.innerHTML = `
      <div class="ticker-card-head">
        <div class="ticker-symbol">${escapeHtml(symbol)}</div>
      </div>
      <p class="error-text">Failed to load: ${escapeHtml(err.message)}</p>
    `;
  }
}

async function loadStockCardDetails(card, symbol, { showNews = false } = {}) {
  const details = card.querySelector('.ticker-card-details');
  if (!details) return;
  try {
    const [newsRes, dividendRes, predictionsRes, congressRes] = await Promise.all([
      showNews ? fetchJson(`/api/news?symbol=${encodeURIComponent(symbol)}`) : Promise.resolve({ items: [] }),
      fetchJson(`/api/dividend?symbol=${encodeURIComponent(symbol)}`).catch(() => ({ paysDividend: false })),
      fetchJson(`/api/predictions?symbol=${encodeURIComponent(symbol)}`).catch(() => null),
      fetchJson(`/api/congress?symbol=${encodeURIComponent(symbol)}&days=365`).catch(() => ({ trades: [] })),
    ]);

    const newsHtml = newsRes.items?.length
      ? newsRes.items.map(newsItemHtml).join('')
      : '<p class="muted">No recent news found.</p>';

    const dividendHtml = dividendBlockHtml(dividendRes, parseFloat(card.dataset.lastPrice) || null);
    const predictionsHtml = predictionsBlockHtml(predictionsRes);
    const congressHtml = congressCardBlockHtml(congressRes.trades || []);

    details.innerHTML = `
      ${chartBlockHtml(symbol, 'stock')}
      ${dividendHtml}
      ${predictionsHtml}
      ${showNews ? `
      <div class="news-list">
        <strong>Stock News &amp; Speculation</strong>
        ${newsHtml}
      </div>` : ''}
      ${congressHtml}
    `;
    card.dataset.detailsLoaded = 'true';
    loadChartForCard(card);
  } catch (err) {
    details.innerHTML = `<p class="error-text">Failed to load details: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadCard(symbol) {
  const card = dashboardEl.querySelector(`.ticker-card[data-symbol="${CSS.escape(symbol)}"]`);
  if (!card) return;
  const wasExpanded = card.classList.contains('expanded');
  const wasLocked = card.classList.contains('locked');
  card.dataset.lazyLoaded = 'true';
  await fillStockCard(card, symbol, { showNews: false, collapsed: true });
  // fillStockCard rebuilds the card from scratch (fresh quote) - reapply state
  // that would otherwise be silently wiped by this periodic refresh.
  if (wasLocked) setCardLocked(card, true);
  if (wasExpanded) expandCard(card);
}

// Cards stacked below the fold (especially mobile's single-column layout)
// don't fetch a quote until scrolled into view, so a long watchlist doesn't
// fire a burst of requests all at once and trip provider rate limits.
function lazyLoadCard(card, loader) {
  if (!('IntersectionObserver' in window)) {
    loader();
    return;
  }
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      obs.unobserve(entry.target);
      loader();
    });
  }, { rootMargin: '200px 0px', threshold: 0.01 });
  observer.observe(card);
}

function loadedSymbols(containerEl, symbols) {
  return symbols.filter((symbol) => {
    const card = containerEl.querySelector(`.ticker-card[data-symbol="${CSS.escape(symbol)}"]`);
    return card?.dataset.lazyLoaded === 'true';
  });
}

function renderDashboard() {
  dashboardEl.innerHTML = watchlist.map(cardSkeleton).join('');
  watchlist.forEach((symbol) => {
    const card = dashboardEl.querySelector(`.ticker-card[data-symbol="${CSS.escape(symbol)}"]`);
    if (card) lazyLoadCard(card, () => loadCard(symbol));
  });
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
            <div class="ticker-symbol">${escapeHtml(symbol)} <span class="live-dot" data-live="badge" title="Live price stream"></span>${collapsed ? ' <button type="button" class="card-lock-toggle" aria-pressed="false" title="Lock card open">🔓</button>' : ''}</div>
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
  const wasExpanded = card.classList.contains('expanded');
  const wasLocked = card.classList.contains('locked');
  card.dataset.lazyLoaded = 'true';
  await fillCryptoCard(card, symbol, { showNews: false, collapsed: true });
  // fillCryptoCard rebuilds the card from scratch (fresh quote) - reapply state
  // that would otherwise be silently wiped by this periodic refresh.
  if (wasLocked) setCardLocked(card, true);
  if (wasExpanded) expandCard(card);
}

function renderCryptoDashboard() {
  cryptoDashboardEl.innerHTML = cryptoWatchlist.map(cryptoCardSkeleton).join('');
  cryptoWatchlist.forEach((symbol) => {
    const card = cryptoDashboardEl.querySelector(`.ticker-card[data-symbol="${CSS.escape(symbol)}"]`);
    if (card) lazyLoadCard(card, () => loadCryptoCard(symbol));
  });
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

function chamberLabel(chamber) {
  return chamber === 'senate' ? 'Senate ·' : 'House ·';
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

let newsTabLoaded = false;

async function loadNewsTab() {
  newsTabLoaded = true;
  newsStocksBodyEl.innerHTML = '<p class="spinner">Loading stock market news…</p>';
  newsCryptoBodyEl.innerHTML = '<p class="spinner">Loading crypto news…</p>';

  const [stockNews, cryptoNews] = await Promise.all([
    fetchJson('/api/news/market?limit=20').catch((err) => ({ items: [], error: err.message })),
    fetchJson('/api/crypto/news?limit=20').catch((err) => ({ items: [], error: err.message })),
  ]);

  newsStocksBodyEl.innerHTML = stockNews.items?.length
    ? stockNews.items.map(newsItemHtml).join('')
    : `<p class="${stockNews.error ? 'error-text' : 'muted'}">${escapeHtml(stockNews.error || 'No recent stock market news found.')}</p>`;

  newsCryptoBodyEl.innerHTML = cryptoNews.items?.length
    ? cryptoNews.items.map(newsItemHtml).join('')
    : `<p class="${cryptoNews.error ? 'error-text' : 'muted'}">${escapeHtml(cryptoNews.error || 'No recent crypto news found.')}</p>`;
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
    const pendingFlashes = [
      ...stocks.flatMap((q) => applyLiveQuote({ ...q, assetType: 'stock' })),
      ...crypto.flatMap((q) => applyLiveQuote({ ...q, assetType: 'crypto' })),
    ];
    // One forced reflow for the whole batch instead of one per card - reading
    // offsetWidth per card was serializing dozens of layout recalcs back to
    // back on the main thread, which is what was stalling input between polls.
    if (pendingFlashes.length) {
      void document.body.offsetWidth;
      pendingFlashes.forEach(({ priceEl, flashClass }) => priceEl.classList.add(flashClass));
    }
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

  // Returns any flash-animation restarts the caller still needs to apply after
  // a single shared forced reflow, instead of each card forcing its own.
  return targets.filter(Boolean).map((el) => updateLivePriceEl(el, price)).filter(Boolean);
}

function updateLivePriceEl(el, price) {
  const priceEl = el.querySelector('[data-live="price"]');
  const changeEl = el.querySelector('[data-live="change"]');
  if (!priceEl) return null;

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
  if (el.classList.contains('tape-item')) return null;

  priceEl.classList.remove('flash-up', 'flash-down');
  return { priceEl, flashClass: price >= prevPrice ? 'flash-up' : 'flash-down' };
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

newsRefreshBtn.addEventListener('click', () => loadNewsTab());

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

function handleChartStyleClick(e) {
  const btn = e.target.closest('.chart-style-toggle');
  if (!btn) return;
  e.stopPropagation();
  const idx = CHART_STYLES.findIndex((s) => s.id === chartStyle);
  chartStyle = CHART_STYLES[(idx + 1) % CHART_STYLES.length].id;
  localStorage.setItem(CHART_STYLE_STORAGE_KEY, chartStyle);
  const label = CHART_STYLES.find((s) => s.id === chartStyle).label;
  document.querySelectorAll('.chart-style-toggle').forEach((b) => {
    b.textContent = label;
    b.title = `Chart style: ${label} (click to switch)`;
  });
  // This is a global default, not a per-card setting - redraw every chart
  // currently on screen (not just the one that was clicked) to match.
  document.querySelectorAll('.candle-canvas').forEach((canvas) => {
    const container = canvas.closest('.ticker-card');
    if (container) redrawChartForCard(container);
  });
}

dashboardEl.addEventListener('click', handleChartStyleClick);
cryptoDashboardEl.addEventListener('click', handleChartStyleClick);
tickerModalBodyEl.addEventListener('click', handleChartStyleClick);

function handleDividendModeClick(e) {
  const btn = e.target.closest('.div-mode-btn');
  if (!btn || btn.disabled) return;
  e.stopPropagation();
  dividendMode = btn.dataset.divMode;
  localStorage.setItem(DIVIDEND_MODE_STORAGE_KEY, dividendMode);
  // App-wide default - update every open card's toggle + chart to match.
  document.querySelectorAll('.ticker-card').forEach((card) => {
    const { symbol, assetType: type = 'stock' } = card.dataset;
    const key = `${type}:${symbol}`;
    const hasDivsInWindow = dividendsInWindow(visibleCandles(key) || [], cardDividends.get(key)).length > 0;
    updateDividendToggle(card, cardPaysDividend.get(key), hasDivsInWindow);
    redrawChartForCard(card);
  });
}

dashboardEl.addEventListener('click', handleDividendModeClick);
cryptoDashboardEl.addEventListener('click', handleDividendModeClick);
tickerModalBodyEl.addEventListener('click', handleDividendModeClick);

function collapseCard(card) {
  const details = card.querySelector('.ticker-card-details');
  if (!details || details.hidden) return;
  details.hidden = true;
  card.classList.remove('expanded');
}

function expandCard(card) {
  const details = card.querySelector('.ticker-card-details');
  if (!details || !details.hidden) return;
  details.hidden = false;
  card.classList.add('expanded');

  const { symbol, assetType = 'stock' } = card.dataset;
  // Stock cards defer dividend/predictions/news/chart until first expand
  // to avoid firing those calls for every collapsed card on page load.
  if (assetType === 'stock' && card.dataset.detailsLoaded !== 'true') {
    loadStockCardDetails(card, symbol, { showNews: false });
    return;
  }
  // chart canvas has zero size while [hidden], so it needs a redraw once visible
  if (lastCandles.has(`${assetType}:${symbol}`)) redrawChartForCard(card);
  else loadChartForCard(card);
}

function setCardLocked(card, locked) {
  card.classList.toggle('locked', locked);
  const btn = card.querySelector('.card-lock-toggle');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(locked));
  btn.title = locked ? 'Unlock card (auto-collapses when another card opens)' : 'Lock card open';
  btn.textContent = locked ? '🔒' : '🔓';
}

function toggleCardExpand(card) {
  const details = card.querySelector('.ticker-card-details');
  if (!details) return;
  const expanding = details.hidden;

  card.classList.remove('bounce');
  void card.offsetWidth; // restart animation
  card.classList.add('bounce');

  if (!expanding) {
    collapseCard(card);
    return;
  }

  // Only one unlocked card stays open at a time within a dashboard - locked
  // cards are exempt so they can stay open alongside a newly opened one.
  const container = card.closest('.dashboard') || card.parentElement;
  container.querySelectorAll('.ticker-card.expanded').forEach((other) => {
    if (other !== card && !other.classList.contains('locked')) collapseCard(other);
  });
  expandCard(card);
}

function handleCardSummaryClick(e) {
  if (e.target.closest('.card-lock-toggle')) return; // handled by handleCardLockClick
  const summary = e.target.closest('.ticker-card-summary');
  if (!summary) return;
  const card = summary.closest('.ticker-card.collapsible');
  if (card) toggleCardExpand(card);
}

dashboardEl.addEventListener('click', handleCardSummaryClick);
cryptoDashboardEl.addEventListener('click', handleCardSummaryClick);

function handleCardLockClick(e) {
  const btn = e.target.closest('.card-lock-toggle');
  if (!btn) return;
  e.stopPropagation();
  const card = btn.closest('.ticker-card');
  if (!card) return;
  setCardLocked(card, !card.classList.contains('locked'));
}

dashboardEl.addEventListener('click', handleCardLockClick);
cryptoDashboardEl.addEventListener('click', handleCardLockClick);

function handleNewsItemClick(e) {
  if (e.target.closest('a')) return; // let the headline link navigate normally
  const summary = e.target.closest('.news-item-summary');
  if (!summary) return;
  const item = summary.closest('.news-item.collapsible');
  const details = item?.querySelector('.news-item-details');
  if (!details) return;
  const opening = details.hidden;
  if (opening) {
    // Only one article open at a time within the same news list.
    item.parentElement?.querySelectorAll(':scope > .news-item.expanded').forEach((other) => {
      if (other === item) return;
      other.classList.remove('expanded');
      const otherDetails = other.querySelector('.news-item-details');
      if (otherDetails) otherDetails.hidden = true;
    });
  }
  details.hidden = !opening;
  item.classList.toggle('expanded', opening);
}

// "Potentially affects" tickers under a news article resolve to whichever tab
// they're actually tracked in - CRYPTO_NAME_ALIASES doubles as the known-coin list.
const KNOWN_CRYPTO_TICKERS = new Set(Object.values(CRYPTO_NAME_ALIASES));

function handleAffectedTickerClick(e) {
  const btn = e.target.closest('.ticker-link-btn.affected-ticker-chip');
  if (!btn) return;
  const symbol = btn.dataset.symbol;
  openTickerDetail(symbol, KNOWN_CRYPTO_TICKERS.has(symbol) ? 'crypto' : 'stock');
}

[dashboardEl, cryptoDashboardEl, tickerModalBodyEl, newsStocksBodyEl, newsCryptoBodyEl].forEach((el) => {
  el.addEventListener('click', handleNewsItemClick);
  el.addEventListener('click', handleAffectedTickerClick);
});

window.addEventListener('resize', () => {
  document.querySelectorAll('.ticker-card').forEach(redrawChartForCard);
  if (lastRocSeries) drawDividendRocChart(dividendRocCanvas, lastRocSeries);
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
    if (target === 'tools' && lastRocSeries) drawDividendRocChart(dividendRocCanvas, lastRocSeries);
    if (target === 'news' && !newsTabLoaded) loadNewsTab();
  });
});

const subtabButtons = document.querySelectorAll('.subtab-btn');
const subtabPanels = document.querySelectorAll('.subtab-panel');
subtabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.subtab;
    subtabButtons.forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    subtabPanels.forEach((panel) => {
      panel.hidden = panel.id !== `subtab-${target}`;
    });
  });
});

// --- Pull-to-refresh (touch devices) ---

function refreshActiveTab() {
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (activeTab === 'news') return loadNewsTab();
  if (activeTab === 'crypto') return Promise.all(loadedSymbols(cryptoDashboardEl, cryptoWatchlist).map(loadCryptoCard));
  if (activeTab === 'tools') return Promise.resolve();
  return Promise.all([...loadedSymbols(dashboardEl, watchlist).map(loadCard), loadTickerTape()]);
}

if (pullRefreshEl && ('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
  const PULL_THRESHOLD = 70;
  const PULL_MAX = 120;
  const pullTextEl = pullRefreshEl.querySelector('.pull-refresh-text');
  let pullStartY = null;
  let pulling = false;
  let refreshing = false;

  const setPullDistance = (distance) => {
    const shown = Math.min(Math.max(distance, 0), PULL_MAX);
    pullRefreshEl.style.transform = `translateY(${shown - 44}px)`;
    pullRefreshEl.classList.add('visible');
    const ready = shown >= PULL_THRESHOLD;
    pullRefreshEl.classList.toggle('ready', ready);
    pullTextEl.textContent = ready ? 'Release to refresh' : 'Pull to refresh';
  };

  const resetPull = () => {
    pulling = false;
    pullStartY = null;
    pullRefreshEl.classList.remove('visible', 'ready', 'dragging');
    pullRefreshEl.style.transform = '';
  };

  window.addEventListener('touchstart', (e) => {
    if (refreshing || window.scrollY > 0 || e.touches.length !== 1) return;
    pullStartY = e.touches[0].clientY;
    pulling = true;
    pullRefreshEl.classList.add('dragging');
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!pulling || pullStartY === null || refreshing) return;
    const distance = e.touches[0].clientY - pullStartY;
    if (distance <= 0 || window.scrollY > 0) { resetPull(); return; }
    e.preventDefault();
    setPullDistance(distance);
  }, { passive: false });

  window.addEventListener('touchend', () => {
    if (!pulling) return;
    const wasReady = pullRefreshEl.classList.contains('ready');
    pullRefreshEl.classList.remove('dragging');
    if (wasReady) {
      refreshing = true;
      pullRefreshEl.classList.add('refreshing');
      pullTextEl.textContent = 'Refreshing…';
      pullRefreshEl.style.transform = 'translateY(0)';
      Promise.resolve(refreshActiveTab()).finally(() => {
        refreshing = false;
        pullRefreshEl.classList.remove('refreshing');
        resetPull();
      });
    } else {
      resetPull();
    }
  });
}

// --- Init ---

renderStarsField();
renderWatchlistBar();
renderDashboard();
renderCryptoWatchlistBar();
renderCryptoDashboard();
renderTickerTape();
loadTickerTape();
startLivePolling();

setInterval(() => {
  // Only re-poll cards that have actually loaded once (i.e. were scrolled
  // into view) - re-fetching every off-screen card on a long watchlist would
  // undo the lazy-load burst reduction above.
  loadedSymbols(dashboardEl, watchlist).forEach(loadCard);
  loadedSymbols(cryptoDashboardEl, cryptoWatchlist).forEach(loadCryptoCard);
  loadTickerTape();
}, REFRESH_MS);

// News refreshes on a slower cadence than the 30s price loop, and only once the tab has been opened.
const NEWS_REFRESH_MS = 5 * 60_000;
setInterval(() => { if (newsTabLoaded) loadNewsTab(); }, NEWS_REFRESH_MS);
