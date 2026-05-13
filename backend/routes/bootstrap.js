const express = require('express');
const { query, TODAY_SQL } = require('../db');
const { COMPUTED_STATUS_SQL } = require('../lib/status');
const { masterCache, masterKey, refCache } = require('../cache');

const router = express.Router();

// Default visible window: today-10 .. today+30.
const WINDOW_LIMIT = 20000;
const WINDOW_DAYS_BEFORE = 10;
const WINDOW_DAYS_AFTER = 30;

async function loadDoers() {
  let doers = refCache.get('doers');
  if (!doers) {
    const r = await query('select id, name, department, email from doers order by name');
    doers = r.rows;
    refCache.set('doers', doers);
  }
  return doers;
}

async function loadTasks() {
  let tasks = refCache.get('tasks');
  if (!tasks) {
    const r = await query(`
      select task_id, task_name, doer_email, frequency, start_date, end_date,
             assigned_by, status
        from tasks
       order by task_name
    `);
    tasks = r.rows;
    refCache.set('tasks', tasks);
  }
  return tasks;
}

async function loadMasterWindow(user) {
  const cacheKey = masterKey(user.email);
  const cached = masterCache.get(cacheKey);
  if (cached) return cached;

  const params = [WINDOW_LIMIT + 1];
  let userFilter = '';
  if (!user.isAdmin) {
    params.push(user.email);
    userFilter = ` and m.doer_email = $${params.length}`;
  }

  const sql = `
    select m.id, m.occurrence_key, m.task_id, m.doer_email, m.planned_date,
           m.actual_date, m.freq, ${COMPUTED_STATUS_SQL} as status,
           t.task_name
      from master_checklist m
      join tasks t on t.task_id = m.task_id
     where m.planned_date between ${TODAY_SQL} - ${WINDOW_DAYS_BEFORE}
                              and ${TODAY_SQL} + ${WINDOW_DAYS_AFTER}
       ${userFilter}
     order by m.planned_date asc
     limit $1
  `;

  const r = await query(sql, params);
  const rows = r.rows;
  const hasMore = rows.length > WINDOW_LIMIT;
  const trimmed = hasMore ? rows.slice(0, WINDOW_LIMIT) : rows;
  const result = {
    rows: trimmed,
    nextCursor: hasMore ? trimmed[trimmed.length - 1].id : null,
  };
  masterCache.set(cacheKey, result);
  return result;
}

router.get('/', async (req, res, next) => {
  try {
    const [doers, tasks, masterWindow] = await Promise.all([
      loadDoers(),
      loadTasks(),
      loadMasterWindow(req.user),
    ]);
    const visibleDoers = req.user.isAdmin ? doers : doers.filter(d => d.email === req.user.email);
    const visibleTasks = req.user.isAdmin ? tasks : tasks.filter(t => t.doer_email === req.user.email);
    res.json({
      user: req.user,
      doers: visibleDoers,
      tasks: visibleTasks,
      masterWindow,
    });
  } catch (e) { next(e); }
});

module.exports = { router, loadDoers, loadTasks, loadMasterWindow };
