'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');

const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;

// Maintains a single upstream connection to Finnhub's trade websocket and
// dedupes subscribe/unsubscribe calls via reference counting, since many
// browser clients may care about the same symbol.
class FinnhubSocket extends EventEmitter {
  constructor(apiKey) {
    super();
    this.apiKey = apiKey;
    this.ws = null;
    this.connected = false;
    this.refCounts = new Map(); // streamSymbol -> subscriber count
    this.reconnectDelay = BASE_DELAY_MS;
    this._connect();
  }

  _connect() {
    this.ws = new WebSocket(`wss://ws.finnhub.io?token=${this.apiKey}`);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = BASE_DELAY_MS;
      for (const streamSymbol of this.refCounts.keys()) {
        this._send({ type: 'subscribe', symbol: streamSymbol });
      }
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'trade' && Array.isArray(msg.data)) {
        for (const trade of msg.data) {
          this.emit('trade', trade.s, trade.p, trade.t);
        }
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      setTimeout(() => this._connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_DELAY_MS);
    });

    this.ws.on('error', () => {
      // 'close' fires right after and triggers the reconnect loop
    });
  }

  _send(obj) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  subscribe(streamSymbol) {
    const count = this.refCounts.get(streamSymbol) || 0;
    this.refCounts.set(streamSymbol, count + 1);
    if (count === 0) this._send({ type: 'subscribe', symbol: streamSymbol });
  }

  unsubscribe(streamSymbol) {
    const count = this.refCounts.get(streamSymbol) || 0;
    if (count <= 1) {
      this.refCounts.delete(streamSymbol);
      this._send({ type: 'unsubscribe', symbol: streamSymbol });
    } else {
      this.refCounts.set(streamSymbol, count - 1);
    }
  }
}

module.exports = FinnhubSocket;
