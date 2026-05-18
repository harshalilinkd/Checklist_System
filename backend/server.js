const path = require('path');
// Env vars: locally we read .env from checklist-migration; in production they
// come from the host's dashboard (Vercel / Render). dotenv silently no-ops when
// the file is missing, so the production path needs no special handling.
require('dotenv').config({ path: path.join(__dirname, '..', 'checklist-migration', '.env') });

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { requireAuth } = require('./auth');
const bootstrapRoute = require('./routes/bootstrap');
const masterRoute = require('./routes/master');
const tasksRoute = require('./routes/tasks');
const doersRoute = require('./routes/doers');
const adminRoute = require('./routes/admin');
const scorecardRoute = require('./routes/scorecard');
const holidaysRoute = require('./routes/holidays');
const { runArchiveJob } = require('./jobs/archive');
const { runExtendJob } = require('./jobs/extend-occurrences');
const { query } = require('./db');
const { reloadHolidays } = require('./lib/occurrences');

// Populate the in-memory holiday set from the `holidays` table at startup.
// In serverless this runs per cold-start; in long-lived processes admin can
// trigger a refresh via POST /api/admin/holidays/reload.
reloadHolidays(query)
  .then(n => console.log(`Loaded ${n} holiday(s) from DB`))
  .catch(e => console.error('Failed to load holidays:', e.message));

const app = express();
const PORT = process.env.PORT || 3000;

// Disable ETag — every API response should be fresh; 304s break fetch().json()
app.set('etag', false);

// API responses are always dynamic — never cache.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  next();
});

// CORS: allow comma-separated FRONTEND_URL list in production; '*' otherwise.
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : '*',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const who = req.user?.email || '-';
    console.log(`[${req.method}] ${req.originalUrl} ${res.statusCode} ${ms}ms ${who}`);
  });
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

app.use('/api/bootstrap', requireAuth, bootstrapRoute.router);
app.use('/api/master',    requireAuth, masterRoute);
app.use('/api/tasks',     requireAuth, tasksRoute);
app.use('/api/doers',     requireAuth, doersRoute);
// Admin route is mounted twice: cron sub-paths (e.g. /api/admin/cron/archive)
// bypass requireAuth because Vercel Cron uses a shared-secret header instead.
// The route file does its own auth for those sub-paths.
app.use('/api/admin',     (req, res, next) => req.path.startsWith('/cron/') ? next() : requireAuth(req, res, next), adminRoute);
app.use('/api/scorecard', requireAuth, scorecardRoute);
app.use('/api/holidays',  requireAuth, holidaysRoute);

// Error handler — runs for any next(err) above.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const code = err.status || 500;
  if (code >= 500) console.error(err.stack || err);
  res.status(code).json({ error: err.message || 'Internal error', code });
});

// Detect serverless (Vercel sets process.env.VERCEL=1). In serverless we:
//   - Don't call app.listen() — the platform owns the lifecycle
//   - Skip node-cron (each request is a fresh process; use platform cron instead,
//     e.g. Vercel Cron → /api/admin/run-job)
//   - Skip SIGTERM handlers (no long-lived process)
if (!process.env.VERCEL) {
  const cron = require('node-cron');
  const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  cron.schedule('0 2 * * *', () => {
    runArchiveJob().catch(e => console.error('[cron archive]', e));
  }, { timezone: TZ });
  cron.schedule('0 3 * * 0', () => {
    runExtendJob().catch(e => console.error('[cron extend]', e));
  }, { timezone: TZ });
  console.log(`Cron registered (TZ=${TZ}): archive @ 02:00 daily, extend @ 03:00 Sun`);

  const server = app.listen(PORT, () => {
    console.log(`Listening on :${PORT}`);
  });

  const { pool } = require('./db');
  function shutdown(signal) {
    console.log(`[${signal}] shutting down`);
    server.close(() => {
      pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// Export for serverless platforms (Vercel imports this in api/index.js)
module.exports = app;
