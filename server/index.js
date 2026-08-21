'use strict';

require('dotenv').config();
const app = require('./app');
const houseStockWatcher = require('./houseStockWatcher');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FIN_APP server running at http://localhost:${PORT}`);
});

// Kick off the recurring congressional-disclosure sync so the cache is warm
// on first request instead of waiting on lazy on-demand fetches. Only runs
// here (the persistent local/traditional-host process) - the Vercel
// serverless entrypoint (api/index.js) does not call this, since a
// setInterval can't outlive a single invocation there.
// NOTE: House-only for now - there is no free, actively-maintained Senate
// trade disclosure feed analogous to the House Stock Watcher mirror (the one
// community dataset that exists hasn't been updated since March 2021, and
// the official efdsearch.senate.gov site has no public API and requires
// agreeing to usage terms, so it isn't wired in here).
houseStockWatcher.startSync();
