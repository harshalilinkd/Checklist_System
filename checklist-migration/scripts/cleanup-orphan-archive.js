// One-off cleanup: remove archive rows whose task_name is NULL.
// These are orphan rows whose parent task was deleted BEFORE the
// task_name column was added (and therefore can't be recovered by name).
// User confirmed these should be removed.

require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // Preview
  const preview = await c.query(`
    select doer_email, count(*)::int as n
      from archive
     where task_name is null
     group by doer_email
     order by n desc
  `);
  console.log('Orphan archive rows by doer:');
  preview.rows.forEach(r => console.log(`  ${r.doer_email.padEnd(45)} ${r.n}`));
  const total = preview.rows.reduce((s, r) => s + r.n, 0);
  console.log(`\nTotal: ${total} orphan rows\n`);

  // Delete
  const r = await c.query('delete from archive where task_name is null returning id');
  console.log(`Deleted ${r.rowCount} orphan archive row(s).`);

  await c.end();
})();
