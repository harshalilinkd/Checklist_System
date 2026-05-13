require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const today = "((now() at time zone 'Asia/Kolkata')::date)";
  const sql = `
    explain (analyze, buffers)
    select m.id, m.occurrence_key, m.task_id, m.doer_email, m.planned_date,
           m.actual_date, m.freq, t.task_name
      from master_checklist m
      join tasks t on t.task_id = m.task_id
     where ((m.status <> 'Done' and m.planned_date < ${today})
         or (m.planned_date between ${today} - 2 and ${today} + 30))
     order by m.planned_date asc
     limit 501
  `;
  const r = await c.query(sql);
  for (const row of r.rows) console.log(row['QUERY PLAN']);
  await c.end();
})();
