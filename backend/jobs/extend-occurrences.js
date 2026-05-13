// Weekly job: extend occurrences for tasks that won't end soon.
// Generates the next 12 months of occurrences for each qualifying task,
// using ON CONFLICT DO NOTHING so it's idempotent.
const { addMonths, format } = require('date-fns');
const { withTx } = require('../db');
const { generateOccurrences } = require('../lib/occurrences');
const { invalidateMaster } = require('../cache');

const BATCH = 500;

async function upsertOccurrences(client, occurrences) {
  if (occurrences.length === 0) return 0;
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
    const sql = `insert into master_checklist (${cols.join(', ')}) values ${tuples.join(', ')} on conflict (occurrence_key) do nothing`;
    const r = await client.query(sql, params);
    inserted += r.rowCount;
  }
  return inserted;
}

async function runExtendJob() {
  const start = Date.now();
  const today = new Date();
  const sixMonthsFromNow = format(addMonths(today, 6), 'yyyy-MM-dd');
  const todayIso = format(today, 'yyyy-MM-dd');
  const twelveMonthsOut = format(addMonths(today, 12), 'yyyy-MM-dd');

  const result = await withTx(async (client) => {
    const r = await client.query(`
      select task_id, task_name, doer_email, frequency, start_date, end_date
        from tasks
       where status = 'Active'
         and (end_date is null or end_date > $1)
    `, [sixMonthsFromNow]);

    let totalGenerated = 0;
    let totalInserted = 0;
    for (const task of r.rows) {
      const occurrences = generateOccurrences(task, {
        rangeFrom: todayIso,
        rangeTo: twelveMonthsOut,
      });
      totalGenerated += occurrences.length;
      totalInserted += await upsertOccurrences(client, occurrences);
    }
    return { tasks: r.rows.length, generated: totalGenerated, inserted: totalInserted };
  });

  invalidateMaster();
  console.log(`[extend] ${result.tasks} tasks → ${result.generated} occurrences considered, ${result.inserted} new in ${Date.now() - start}ms`);
  return result;
}

module.exports = { runExtendJob };
