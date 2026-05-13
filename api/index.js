// Vercel serverless entry point.
//
// Vercel auto-detects this file under /api and invokes it for every request
// matching the rewrites in vercel.json (/api/* → /api). The Express app
// itself does the per-route dispatching.
//
// In a serverless context, each cold start creates a new module instance,
// so node-cron + LRU caches reset on cold-start. Hot invocations within
// ~5 minutes reuse the same instance and benefit from the cache.

module.exports = require('../backend/server.js');
