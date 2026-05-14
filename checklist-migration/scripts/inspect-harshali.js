require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const EMAIL = 'harshali.linkd@gmail.com';

  console.log('=== master_checklist for', EMAIL, '===');
  const m = await c.query(
    'select status, count(*)::int as n from master_checklist where doer_email = $1 group by status order by n desc',
    [EMAIL]);
  console.log(m.rows);

  console.log('\n=== archive for', EMAIL, '===');
  const a = await c.query(
    "select task_id, count(*)::int as n, min(planned_date) as oldest, max(planned_date) as newest from archive where doer_email = $1 group by task_id",
    [EMAIL]);
  console.log(a.rows);

  console.log('\n=== which archive task_ids still exist in tasks table? ===');
  const orphan = await c.query(
    'select a.task_id, count(*)::int as n, max(t.task_name) as task_name_or_null from archive a left join tasks t on t.task_id = a.task_id where a.doer_email = $1 group by a.task_id',
    [EMAIL]);
  console.log(orphan.rows);

  console.log('\n=== Total rows in archive with no matching task in tasks (orphans = from deleted tasks): ===');
  const orphCount = await c.query(
    'select count(*)::int as n from archive a left join tasks t on t.task_id = a.task_id where a.doer_email = $1 and t.task_id is null',
    [EMAIL]);
  console.log(orphCount.rows[0]);

  await c.end();
})();
