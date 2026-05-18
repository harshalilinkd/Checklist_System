// Admin-managed holiday list. Rows here are merged with the always-Sunday
// rule by the occurrence generator (backend/lib/occurrences.js).
//
// The generator reads from an in-memory cache populated at server startup;
// any mutation here calls reloadHolidays() so the cache stays fresh, plus
// it applies the change to master_checklist:
//   - Adding a holiday → deletes any non-Done occurrence on that date.
//   - Removing a holiday → backfills the missing occurrences by re-running
//     generateOccurrences for every active task (no-op upserts elsewhere).

const express = require('express');
const { query, withTx } = require('../db');
const { generateOccurrences, FY_END, reloadHolidays, getHolidays } = require('../lib/occurrences');
const { invalidateMaster } = require('../cache');
const { requireAdmin } = require('../auth');

const router = express.Router();

async function regenerateAllTasks(client) {
  // Re-issue every active task's occurrences. Upsert with DO NOTHING so we
  // don't disturb Done rows or anything that already matches.
  const tasks = (await client.query("select task_id, doer_email, frequency, start_date, end_date from tasks where status = 'Active'")).rows;
  const BATCH = 500;
  const cols = ['occurrence_key', 'task_id', 'doer_email', 'planned_date', 'freq', 'status'];
  let total = 0;
  for (const t of tasks) {
    const occs = generateOccurrences({
      task_id: t.task_id, doer_email: t.doer_email, frequency: t.frequency,
      start_date: t.start_date, end_date: t.end_date,
    }, { rangeTo: FY_END });
    for (let i = 0; i < occs.length; i += BATCH) {
      const slice = occs.slice(i, i + BATCH);
      const params = [];
      const tuples = slice.map((row, rIdx) => {
        const placeholders = cols.map((_, cIdx) => `$${rIdx * cols.length + cIdx + 1}`);
        params.push(...cols.map(col => col === 'status' ? 'Scheduled' : row[col]));
        return `(${placeholders.join(', ')})`;
      });
      const r = await client.query(
        `insert into master_checklist (${cols.join(', ')}) values ${tuples.join(', ')} on conflict (occurrence_key) do nothing`,
        params
      );
      total += r.rowCount;
    }
  }
  return total;
}

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
    const result = await withTx(async (client) => {
      const r = await client.query(
        `insert into holidays (holiday_date, name) values ($1, $2)
         on conflict (holiday_date) do update set name = excluded.name
         returning id, to_char(holiday_date, 'YYYY-MM-DD') as date, name`,
        [date, name || null]
      );
      // Apply to master_checklist: drop any non-Done occurrence on this date.
      const purge = await client.query(
        "delete from master_checklist where status != 'Done' and planned_date = $1 returning id",
        [date]
      );
      return { row: r.rows[0], purged: purge.rowCount };
    });
    await reloadHolidays(query);
    invalidateMaster();
    res.json({ ...result.row, occurrencesRemoved: result.purged });
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await withTx(async (client) => {
      const r = await client.query('delete from holidays where id = $1 returning id, to_char(holiday_date, \'YYYY-MM-DD\') as date', [req.params.id]);
      if (r.rowCount === 0) return null;
      return { id: r.rows[0].id, date: r.rows[0].date };
    });
    if (!result) return res.status(404).json({ error: 'Holiday not found', code: 404 });
    // Refresh cache BEFORE regenerating so the generator allows the un-blocked date.
    await reloadHolidays(query);
    const restored = await withTx(async (client) => regenerateAllTasks(client));
    invalidateMaster();
    res.json({ deleted: result.id, date: result.date, occurrencesRestored: restored });
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
