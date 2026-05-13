// Daily archive job. Moves Done rows older than 30 days from
// master_checklist into archive (single transaction, atomic).
const { withTx, APP_TZ } = require('../db');
const { invalidateMaster } = require('../cache');

async function runArchiveJob() {
  const start = Date.now();
  const result = await withTx(async (client) => {
    const r = await client.query(`
      with moved as (
        delete from master_checklist
         where status = 'Done'
           and actual_date < ((now() at time zone $1)::date - interval '30 days')
        returning occurrence_key, task_id, doer_email, planned_date,
                  actual_date, freq, status, created_at, updated_at
      )
      insert into archive (occurrence_key, task_id, doer_email, planned_date,
                           actual_date, freq, status, created_at, updated_at)
      select * from moved
      returning id
    `, [APP_TZ]);
    return r.rowCount;
  });
  invalidateMaster();
  console.log(`[archive] moved ${result} row(s) in ${Date.now() - start}ms`);
  return { archived: result };
}

module.exports = { runArchiveJob };
