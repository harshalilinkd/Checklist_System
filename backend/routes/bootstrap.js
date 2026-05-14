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

  // UNION master_checklist + archive so:
  //   - Past Done rows from deleted tasks (moved to archive) stay visible
  //   - Auto-archived Done rows (>30d) are also accessible if in window
  // LEFT JOIN tasks → orphan task_ids (deleted tasks) show as '(deleted task)'.
  const params = [WINDOW_LIMIT + 1];
  let userFilterM = '';
  let userFilterA = '';
  if (!user.isAdmin) {
    params.push(user.email);
    userFilterM = ` and m.doer_email = $${params.length}`;
    userFilterA = ` and a.doer_email = $${params.length}`;
  }

  const sql = `
    with combined as (
      select m.id, m.occurrence_key, m.task_id, m.doer_email, m.planned_date,
             m.actual_date, m.freq, ${COMPUTED_STATUS_SQL} as status,
             t.task_name as task_name
        from master_checklist m
        join tasks t on t.task_id = m.task_id
       where m.planned_date between ${TODAY_SQL} - ${WINDOW_DAYS_BEFORE}
                                and ${TODAY_SQL} + ${WINDOW_DAYS_AFTER}
         ${userFilterM}
      union all
      select a.id, a.occurrence_key, a.task_id, a.doer_email, a.planned_date,
             a.actual_date, a.freq, a.status,
             a.task_name as task_name
        from archive a
       where a.planned_date between ${TODAY_SQL} - ${WINDOW_DAYS_BEFORE}
                                and ${TODAY_SQL} + ${WINDOW_DAYS_AFTER}
         ${userFilterA}
    )
    select c.id, c.occurrence_key, c.task_id, c.doer_email, c.planned_date,
           c.actual_date, c.freq, c.status,
           coalesce(c.task_name, '(deleted task)') as task_name
      from combined c
     order by c.planned_date asc, c.id asc
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
    // Gate: allow only admins OR users whose email is in the doers table.
    // Anyone else (e.g. a random Google account that authenticated via OAuth)
    // gets a hard 403 here, regardless of their valid Supabase session.
    const isInDoers = doers.some(d => d.email === req.user.email);
    if (!req.user.isAdmin && !isInDoers) {
      return res.status(403).json({
        error: `Access denied — ${req.user.email} is not registered in the system. Ask an admin to add you as a doer first.`,
        code: 403,
      });
    }
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
