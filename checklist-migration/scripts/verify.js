require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const counts = await c.query(`
      select 'doers' as t, count(*)::int as n from doers union all
      select 'tasks', count(*)::int from tasks union all
      select 'master_checklist', count(*)::int from master_checklist union all
      select 'archive', count(*)::int from archive
    `);
    console.log('Row counts:');
    counts.rows.forEach(r => console.log(`  ${r.t.padEnd(20)} ${r.n}`));

    const byStatus = await c.query(`select status, count(*)::int as n from master_checklist group by status order by n desc`);
    console.log('\nMaster by status:');
    byStatus.rows.forEach(r => console.log(`  ${r.status.padEnd(20)} ${r.n}`));

    const byFreq = await c.query(`select frequency, count(*)::int as n from tasks group by frequency order by n desc`);
    console.log('\nTasks by frequency:');
    byFreq.rows.forEach(r => console.log(`  ${r.frequency.padEnd(6)} ${r.n}`));

    const sample = await c.query(`
      select m.occurrence_key, t.task_name, m.doer_email, m.planned_date, m.status
      from master_checklist m join tasks t on m.task_id = t.task_id
      where m.status = 'Today' order by m.planned_date desc limit 3
    `);
    console.log('\nSample (status=Today, top 3):');
    sample.rows.forEach(r => console.log(' ', r));

    const orphans = await c.query(`
      select count(*)::int as n from master_checklist m
      left join tasks t on m.task_id = t.task_id
      where t.task_id is null
    `);
    console.log(`\nOrphan master rows (no matching task): ${orphans.rows[0].n}`);
  } finally { await c.end(); }
})();
