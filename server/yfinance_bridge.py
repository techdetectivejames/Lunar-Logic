#!/usr/bin/env python3
"""Fetch dividend info for a single ticker via yfinance and print JSON to stdout.

Used as a bridge because Finnhub's dividend endpoints (/stock/dividend,
/stock/dividend2) require a paid plan on the configured API key. yfinance
(scrapes Yahoo Finance) fills that gap for free.
"""
import sys
import json
from datetime import datetime, timedelta, timezone


def unix_to_date(ts):
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime('%Y-%m-%d')
    except (ValueError, OSError, OverflowError):
        return None


def recent_dividends(dividends, days=370):
    if dividends is None or len(dividends) == 0:
        return []
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)
    return [(d, v) for d, v in zip(dividends.index, dividends.values) if d.to_pydatetime().astimezone(timezone.utc) >= cutoff]


def classify_frequency(count):
    if count == 0:
        return 'No recent dividend'
    if count == 1:
        return 'Annual'
    if count == 2:
        return 'Semi-Annual'
    if 3 <= count <= 6:
        return 'Quarterly'
    if 10 <= count <= 15:
        return 'Monthly'
    if count >= 40:
        return 'Weekly'
    return 'Irregular'


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Missing symbol argument'}))
        return

    symbol = sys.argv[1]

    try:
        import yfinance as yf
    except ImportError:
        print(json.dumps({'error': 'yfinance not installed'}))
        return

    try:
        ticker = yf.Ticker(symbol)
        info = ticker.info or {}
        dividends = ticker.dividends
        recent = recent_dividends(dividends)
        pays_dividend = bool(info.get('dividendRate')) or len(recent) > 0

        # Yahoo's `info` dict is frequently incomplete for actively-managed
        # income ETFs (e.g. weekly covered-call funds) - fall back to the raw
        # dividend history whenever the summary fields are missing.
        dividend_rate = info.get('dividendRate')
        if not dividend_rate and recent:
            dividend_rate = round(sum(v for _, v in recent), 4)

        last_value = info.get('lastDividendValue')
        last_date = unix_to_date(info.get('lastDividendDate'))
        if (last_value is None or last_date is None) and len(dividends) > 0:
            last_date_ts, last_value_raw = dividends.index[-1], dividends.values[-1]
            last_value = last_value if last_value is not None else round(float(last_value_raw), 4)
            last_date = last_date or last_date_ts.strftime('%Y-%m-%d')

        payout_ratio = info.get('payoutRatio')
        ex_date = unix_to_date(info.get('exDividendDate'))
        frequency = classify_frequency(len(recent))

        result = {
            'symbol': symbol.upper(),
            'paysDividend': pays_dividend,
            # Yield is computed client-side from this + the live Finnhub quote price,
            # since yfinance's own yield field has shifted units across versions.
            'dividendPerShareAnnual': dividend_rate,
            'payoutRatioPct': round(payout_ratio * 100, 2) if isinstance(payout_ratio, (int, float)) else None,
            'lastDividendValue': last_value,
            'lastDividendDate': last_date,
            'exDividendDate': ex_date,
            'frequency': frequency,
            'source': 'yfinance',
        }
        print(json.dumps(result))
    except Exception as exc:  # noqa: BLE001 - always surface as JSON, never a stack trace
        print(json.dumps({'error': str(exc), 'symbol': symbol.upper()}))


if __name__ == '__main__':
    main()
