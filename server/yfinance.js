'use strict';

const path = require('path');
const { execFile } = require('child_process');

const PYTHON_BIN = path.join(__dirname, '..', '.venv', 'bin', 'python');
const DIVIDEND_SCRIPT = path.join(__dirname, 'yfinance_bridge.py');
const CANDLES_SCRIPT = path.join(__dirname, 'candles_bridge.py');
const TIMEOUT_MS = 15_000;

function runBridge(script, args, cache, ttlMs) {
  const cacheKey = args.join('|');
  const entry = cache.get(cacheKey);
  if (entry && Date.now() - entry.time < ttlMs) return Promise.resolve(entry.data);

  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, [script, ...args], { timeout: TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        reject(new Error(`yfinance bridge failed: ${err.message}`));
        return;
      }
      let data;
      try {
        data = JSON.parse(stdout);
      } catch {
        reject(new Error('yfinance bridge returned invalid JSON'));
        return;
      }
      if (data.error) {
        reject(new Error(data.error));
        return;
      }
      cache.set(cacheKey, { data, time: Date.now() });
      resolve(data);
    });
  });
}

const dividendCache = new Map();
const DIVIDEND_TTL_MS = 6 * 60 * 60 * 1000; // dividend schedules rarely change intraday

function getDividendInfo(symbol) {
  return runBridge(DIVIDEND_SCRIPT, [symbol], dividendCache, DIVIDEND_TTL_MS);
}

const candlesCache = new Map();
const CANDLES_TTL_MS = 5 * 60 * 1000;

function getCandles(symbol, period) {
  return runBridge(CANDLES_SCRIPT, [symbol, period || '1mo'], candlesCache, CANDLES_TTL_MS);
}

module.exports = { getDividendInfo, getCandles };

