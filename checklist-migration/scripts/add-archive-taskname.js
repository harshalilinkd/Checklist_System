// Migration: add task_name column to archive so the original task name
// survives when the parent task row is deleted from the tasks table.
// Backfills from tasks table where the task still exists.
require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('Adding archive.task_name column (if missing)...');
  await c.query('alter table archive add column if not exists task_name text');
  console.log('Backfilling task_name from tasks where task still exists...');
  const r = await c.query(
    'update archive a set task_name = t.task_name from tasks t where a.task_id = t.task_id and a.task_name is null returning a.id'
  );
  console.log(`  backfilled ${r.rowCount} archive row(s)`);
  const orphan = await c.query(
    'select count(*)::int as n from archive where task_name is null'
  );
  console.log(`  ${orphan.rows[0].n} row(s) still have no task_name (their tasks were deleted before this migration)`);
  await c.end();
})();
