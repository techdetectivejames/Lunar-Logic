'use strict';

require('dotenv').config();

// Vercel serverless entrypoint: exports the Express app directly (no
// .listen(), no background sync timer - both need a persistent process,
// which serverless functions don't provide).
module.exports = require('../server/app');
