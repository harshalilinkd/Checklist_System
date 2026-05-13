const express = require('express');
const crypto = require('crypto');
const { query, withTx } = require('../db');
const { generateOccurrences } = require('../lib/occurrences');
const { invalidateMaster, invalidateTasks } = require('../cache');
const { requireAdmin } = require('../auth');

const router = express.Router();

function makeTaskId(taskName, email) {
  const h = crypto.createHash('sha1').update(`${taskName}|${email}`).digest('hex');
  return 't_' + h.slice(0, 16);
}

async function upsertOccurrences(client, occurrences) {
  if (occurrences.length === 0) return 0;
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < occurrences.length; i += BATCH) {
    const slice = occurrences.slice(i, i + BATCH);
    const cols = ['occurrence_key', 'task_id', 'doer_email', 'planned_date', 'freq', 'status'];
    const params = [];
    const tuples = slice.map((row, rIdx) => {
      const placeholders = cols.map((_, cIdx) => `$${rIdx * cols.length + cIdx + 1}`);
      params.push(...cols.map(c => row[c]));
      return `(${placeholders.join(', ')})`;
    });
    const sql = `
      insert into master_checklist (${cols.join(', ')})
      values ${tuples.join(', ')}
      on conflict (occurrence_key) do nothing
    `;
    const r = await client.query(sql, params);
    inserted += r.rowCount;
  }
  return inserted;
}

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { task_name, doer_email, frequency, start_date, end_date, assigned_by, status } = req.body || {};
    if (!task_name || !doer_email || !frequency || !start_date) {
      return res.status(400).json({ error: 'task_name, doer_email, frequency, start_date are required', code: 400 });
    }
    const task_id = req.body.task_id || makeTaskId(task_name, doer_email);
    const finalStatus = status || 'Active';

    const result = await withTx(async (client) => {
      const r = await client.query(
        `insert into tasks (task_id, task_name, doer_email, frequency, start_date, end_date, assigned_by, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (task_id) do update
           set task_name = excluded.task_name,
               doer_email = excluded.doer_email,
               frequency = excluded.frequency,
               start_date = excluded.start_date,
               end_date = excluded.end_date,
               assigned_by = excluded.assigned_by,
               status = excluded.status
         returning *`,
        [task_id, task_name, doer_email, frequency, start_date, end_date, assigned_by, finalStatus]
      );
      const task = r.rows[0];
      const occurrences = generateOccurrences(task);
      const inserted = await upsertOccurrences(client, occurrences);
      return { task, occurrencesGenerated: occurrences.length, inserted };
    });

    invalidateTasks();
    invalidateMaster();
    res.json(result);
  } catch (e) { next(e); }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { task_name, doer_email, frequency, start_date, end_date, assigned_by, status } = req.body || {};
    const task_id = req.params.id;

    const result = await withTx(async (client) => {
      const r = await client.query(
        `update tasks set
           task_name = coalesce($2, task_name),
           doer_email = coalesce($3, doer_email),
           frequency = coalesce($4, frequency),
           start_date = coalesce($5, start_date),
           end_date = $6,
           assigned_by = $7,
           status = coalesce($8, status)
         where task_id = $1
         returning *`,
        [task_id, task_name, doer_email, frequency, start_date, end_date, assigned_by, status]
      );
      if (r.rowCount === 0) return null;
      const task = r.rows[0];
      const occurrences = generateOccurrences(task);
      const inserted = await upsertOccurrences(client, occurrences);
      return { task, occurrencesGenerated: occurrences.length, inserted };
    });

    if (!result) return res.status(404).json({ error: 'Task not found', code: 404 });
    invalidateTasks();
    invalidateMaster();
    res.json(result);
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const r = await query('delete from tasks where task_id = $1 returning task_id', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Task not found', code: 404 });
    invalidateTasks();
    invalidateMaster();
    res.json({ deleted: r.rows[0].task_id });
  } catch (e) { next(e); }
});

module.exports = router;
