'use strict';

require('dotenv').config();
const app = require('./app');
const houseStockWatcher = require('./houseStockWatcher');
const senateTrades = require('./senateTrades');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FIN_APP server running at http://localhost:${PORT}`);
});

// Kick off the recurring congressional-disclosure sync so the cache is warm
// on first request instead of waiting on lazy on-demand fetches. Only runs
// here (the persistent local/traditional-host process) - the Vercel
// serverless entrypoint (api/index.js) does not call this, since a
// setInterval can't outlive a single invocation there.
houseStockWatcher.startSync();
senateTrades.startSync();
