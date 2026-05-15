// Wipe master_checklist and regenerate every row from the tasks table's
// start_date → end_date range (FY-clamped). Leaves tasks, doers, and
// archive untouched.
//
// Usage:  node scripts/regen-master-from-tasks.js [--dry]

require('dotenv').config();
const { Client } = require('pg');
const { generateOccurrences, FY_START, FY_END } = require('../../backend/lib/occurrences');

const BATCH = 500;
const DRY = process.argv.includes('--dry');

async function bulkInsert(client, rows) {
  if (rows.length === 0) return;
  const cols = ['occurrence_key', 'task_id', 'doer_email', 'planned_date', 'freq', 'status'];
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = slice.map((row, rIdx) => {
      const placeholders = cols.map((_, cIdx) => `$${rIdx * cols.length + cIdx + 1}`);
      params.push(...cols.map(c => row[c]));
      return `(${placeholders.join(', ')})`;
    });
    const sql = `insert into master_checklist (${cols.join(', ')}) values ${tuples.join(', ')} on conflict (occurrence_key) do nothing`;
    await client.query(sql, params);
    process.stdout.write(`\r  inserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('Connected.');
  console.log(`FY clamp: ${FY_START} .. ${FY_END}\n`);

  const tasks = (await c.query('select task_id, doer_email, frequency, start_date, end_date, status from tasks where status = $1', ['Active'])).rows;
  console.log(`Active tasks in DB: ${tasks.length}`);

  // Generate occurrences per task — pass rangeTo=FY_END so tasks with null
  // end_date still fill the whole FY (otherwise they cap at start+12 months).
  const rows = [];
  const dedupe = new Set();
  let perTask = [];
  for (const t of tasks) {
    const startIso = t.start_date instanceof Date ? t.start_date.toISOString().slice(0,10) : String(t.start_date);
    const endIso = t.end_date ? (t.end_date instanceof Date ? t.end_date.toISOString().slice(0,10) : String(t.end_date)) : null;
    const occs = generateOccurrences({
      task_id: t.task_id,
      doer_email: t.doer_email,
      frequency: t.frequency,
      start_date: startIso,
      end_date: endIso,
    }, { rangeFrom: process.env.START_FROM || undefined, rangeTo: FY_END });
    for (const o of occs) {
      if (dedupe.has(o.occurrence_key)) continue;
      dedupe.add(o.occurrence_key);
      rows.push({
        occurrence_key: o.occurrence_key,
        task_id: o.task_id,
        doer_email: o.doer_email,
        planned_date: o.planned_date,
        freq: o.freq,
        status: 'Scheduled',
      });
    }
    perTask.push({ task_id: t.task_id, freq: t.frequency, n: occs.length });
  }

  const byFreq = perTask.reduce((m, r) => (m[r.freq] = (m[r.freq]||0) + r.n, m), {});
  console.log(`Total occurrences generated: ${rows.length}`);
  console.log('By frequency:', byFreq);

  if (DRY) {
    console.log('\n[DRY RUN] master_checklist not touched.');
    await c.end();
    return;
  }

  console.log('\n── Wiping master_checklist + inserting fresh occurrences ──');
  await c.query('begin');
  try {
    const before = await c.query('select count(*)::int n from master_checklist');
    await c.query('truncate table master_checklist restart identity');
    console.log(`Cleared ${before.rows[0].n} rows from master_checklist`);
    await bulkInsert(c, rows);
    await c.query('commit');
    console.log('Commit OK.');
  } catch (e) {
    await c.query('rollback');
    console.error('Failed, rolled back:', e);
    process.exitCode = 1;
    await c.end();
    return;
  }

  const after = await c.query('select count(*)::int n, min(planned_date) min, max(planned_date) max from master_checklist');
  const status = (await c.query("select status, count(*)::int n from master_checklist group by status order by status")).rows;
  console.log('\n── Final state ──');
  console.log(`  master_checklist: ${after.rows[0].n} rows`);
  console.log(`  range:            ${after.rows[0].min} .. ${after.rows[0].max}`);
  status.forEach(r => console.log(`  ${r.status.padEnd(16)} ${r.n}`));

  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
