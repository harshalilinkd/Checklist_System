// Admin-managed holiday list. Rows here are merged with the always-Sunday
// rule by the occurrence generator (backend/lib/occurrences.js).
//
// The generator reads from an in-memory cache populated at server startup;
// any mutation here calls reloadHolidays() so the cache stays fresh.

const express = require('express');
const { query } = require('../db');
const { reloadHolidays, getHolidays } = require('../lib/occurrences');
const { invalidateMaster } = require('../cache');
const { requireAdmin } = require('../auth');

const router = express.Router();

router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const r = await query("select id, to_char(holiday_date, 'YYYY-MM-DD') as date, name, created_at from holidays order by holiday_date");
    res.json(r.rows);
  } catch (e) { next(e); }
});

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { date, name } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)', code: 400 });
    const r = await query(
      `insert into holidays (holiday_date, name) values ($1, $2)
       on conflict (holiday_date) do update set name = excluded.name
       returning id, to_char(holiday_date, 'YYYY-MM-DD') as date, name`,
      [date, name || null]
    );
    await reloadHolidays(query);
    invalidateMaster();
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const r = await query('delete from holidays where id = $1 returning id', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Holiday not found', code: 404 });
    await reloadHolidays(query);
    invalidateMaster();
    res.json({ deleted: r.rows[0].id });
  } catch (e) { next(e); }
});

// Manual cache refresh — admin hits this after editing the table directly
// in Supabase Studio. The in-memory set updates without a server restart.
router.post('/reload', requireAdmin, async (req, res, next) => {
  try {
    const n = await reloadHolidays(query);
    res.json({ loaded: n, dates: [...getHolidays()].sort() });
  } catch (e) { next(e); }
});

module.exports = router;
