#!/usr/bin/env python3
"""Fetch recent daily OHLC candles for a ticker via yfinance and print JSON.

Finnhub's /stock/candle endpoint is premium-only on the configured API key,
so candlestick data is sourced from yfinance instead.
"""
import sys
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Missing symbol argument'}))
        return

    symbol = sys.argv[1]
    period = sys.argv[2] if len(sys.argv) > 2 else '1mo'

    try:
        import yfinance as yf
    except ImportError:
        print(json.dumps({'error': 'yfinance not installed'}))
        return

    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period=period, interval='1d')

        candles = []
        for ts, row in hist.iterrows():
            candles.append({
                't': ts.strftime('%Y-%m-%d'),
                'o': round(float(row['Open']), 4),
                'h': round(float(row['High']), 4),
                'l': round(float(row['Low']), 4),
                'c': round(float(row['Close']), 4),
                'v': int(row['Volume']) if row['Volume'] == row['Volume'] else 0,
            })

        print(json.dumps({'symbol': symbol.upper(), 'candles': candles, 'source': 'yfinance'}))
    except Exception as exc:  # noqa: BLE001 - always surface as JSON, never a stack trace
        print(json.dumps({'error': str(exc), 'symbol': symbol.upper()}))


if __name__ == '__main__':
    main()
