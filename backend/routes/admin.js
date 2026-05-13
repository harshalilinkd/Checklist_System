const express = require('express');
const { query } = require('../db');
const { requireAdmin } = require('../auth');
const { runArchiveJob } = require('../jobs/archive');
const { runExtendJob } = require('../jobs/extend-occurrences');

const router = express.Router();

// Cron-only endpoints (called by Vercel Cron, no JWT). Authenticated by a
// shared secret in the Authorization header — set CRON_SECRET in env, then
// Vercel Cron auto-attaches `Authorization: Bearer ${CRON_SECRET}`.
router.get('/cron/archive', async (req, res, next) => {
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET || ''}` || !process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Cron auth required', code: 401 });
  }
  try { res.json(await runArchiveJob()); } catch (e) { next(e); }
});
router.get('/cron/extend', async (req, res, next) => {
  if ((req.headers.authorization || '') !== `Bearer ${process.env.CRON_SECRET || ''}` || !process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Cron auth required', code: 401 });
  }
  try { res.json(await runExtendJob()); } catch (e) { next(e); }
});

// All other admin routes require admin JWT
router.use(requireAdmin);

router.get('/stats', async (req, res, next) => {
  try {
    const r = await query(`
      select
        (select count(*)::int from doers)             as doers,
        (select count(*)::int from tasks)             as tasks,
        (select count(*)::int from master_checklist)  as master,
        (select count(*)::int from archive)           as archive,
        (select min(planned_date) from master_checklist) as oldest_planned,
        (select max(planned_date) from master_checklist) as newest_planned,
        (select max(archived_at) from archive)        as last_archive_run
    `);
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.post('/run-job', async (req, res, next) => {
  try {
    const job = (req.body?.job || '').toLowerCase();
    if (job === 'archive') {
      const result = await runArchiveJob();
      return res.json({ job, result });
    }
    if (job === 'extend') {
      const result = await runExtendJob();
      return res.json({ job, result });
    }
    return res.status(400).json({ error: "job must be 'archive' or 'extend'", code: 400 });
  } catch (e) { next(e); }
});

module.exports = router;
