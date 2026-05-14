// Remove leftover __TEST__ rows from the delete-preserves-name verification script.
require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const arc = await c.query("delete from archive where task_name like '__TEST__%' returning id, task_name");
  const mst = await c.query("delete from master_checklist where task_id in (select task_id from tasks where task_name like '__TEST__%') returning id");
  const tsk = await c.query("delete from tasks where task_name like '__TEST__%' returning task_id, task_name");
  console.log('Removed:');
  console.log('  archive          :', arc.rowCount, 'row(s)');
  console.log('  master_checklist :', mst.rowCount, 'row(s)');
  console.log('  tasks            :', tsk.rowCount, 'row(s)');
  await c.end();
})();
