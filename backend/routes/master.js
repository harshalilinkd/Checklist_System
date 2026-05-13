const express = require('express');
const { query, withTx, TODAY_SQL, APP_TZ } = require('../db');
const { COMPUTED_STATUS_SQL } = require('../lib/status');
const { invalidateMaster } = require('../cache');
const { requireAdmin } = require('../auth');

const router = express.Router();

const PAGE_DEFAULT = 500;
const PAGE_MAX = 500;

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || PAGE_DEFAULT, 10), PAGE_MAX);
    const cursor = req.query.cursor ? parseInt(req.query.cursor, 10) : null;
    const params = [limit + 1];
    let userFilter = '';
    let cursorClause = '';
    if (!req.user.isAdmin) {
      params.push(req.user.email);
      userFilter = `and m.doer_email = $${params.length}`;
    }
    if (cursor) {
      params.push(cursor);
      cursorClause = `and m.id > $${params.length}`;
    }
    const sql = `
      select m.id, m.occurrence_key, m.task_id, m.doer_email, m.planned_date,
             m.actual_date, m.freq, ${COMPUTED_STATUS_SQL} as status,
             t.task_name
        from master_checklist m
        join tasks t on t.task_id = m.task_id
       where 1=1 ${userFilter} ${cursorClause}
       order by m.id asc
       limit $1
    `;
    const r = await query(sql, params);
    const hasMore = r.rows.length > limit;
    const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
    res.json({
      rows,
      nextCursor: hasMore ? rows[rows.length - 1].id : null,
    });
  } catch (e) { next(e); }
});

// Ad-hoc range lookup (used by Scorecard heatmap drill-in for historical dates).
// Queries master_checklist + archive so dates outside the bootstrap window
// (typically archived Done rows older than 30 days) are reachable.
router.get('/range', async (req, res, next) => {
  try {
    const { from, to, email } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required', code: 400 });

    const targetEmail = req.user.isAdmin ? (email || null) : req.user.email;
    const params = [from, to];
    let emailM = '', emailA = '';
    if (targetEmail) {
      params.push(targetEmail);
      emailM = `and m.doer_email = $${params.length}`;
      emailA = `and a.doer_email = $${params.length}`;
    }

    const sql = `
      with combined as (
        select m.id, m.occurrence_key, m.task_id, m.doer_email, m.planned_date,
               m.actual_date, m.freq, ${COMPUTED_STATUS_SQL} as status
          from master_checklist m
         where m.planned_date between $1 and $2 ${emailM}
        union all
        select a.id, a.occurrence_key, a.task_id, a.doer_email, a.planned_date,
               a.actual_date, a.freq, a.status
          from archive a
         where a.planned_date between $1 and $2 ${emailA}
      )
      select c.*, t.task_name
        from combined c
        left join tasks t on t.task_id = c.task_id
       order by c.planned_date asc, c.id asc
       limit 5000
    `;
    const r = await query(sql, params);
    res.json({ rows: r.rows });
  } catch (e) { next(e); }
});

router.post('/:occurrenceKey/done', async (req, res, next) => {
  try {
    const occurrenceKey = req.params.occurrenceKey;
    const actualDate = req.body?.actual_date || null;

    // Non-admins can only mark their own rows done.
    const ownerCheck = await query(
      'select doer_email from master_checklist where occurrence_key = $1',
      [occurrenceKey]
    );
    if (ownerCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Occurrence not found', code: 404 });
    }
    if (!req.user.isAdmin && ownerCheck.rows[0].doer_email !== req.user.email) {
      return res.status(403).json({ error: 'Not your task', code: 403 });
    }

    const r = await query(
      `update master_checklist
          set status = 'Done',
              actual_date = coalesce($2::date, ((now() at time zone 'Asia/Kolkata')::date))
        where occurrence_key = $1
        returning occurrence_key, status, actual_date`,
      [occurrenceKey, actualDate]
    );
    invalidateMaster();
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

module.exports = router;
