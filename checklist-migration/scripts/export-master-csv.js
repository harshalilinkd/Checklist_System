// Export master_checklist to data/master_checklist.csv in the original
// Google-Sheets format. JOINs against doers (name + department) and tasks
// (task_name). Dates rendered as DD-MM-YYYY to match Sheet locale.
//
// Usage:  node scripts/export-master-csv.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const OUT_PATH = path.join(__dirname, '..', 'data', 'master_checklist.csv');

function toDmy(d) {
  if (!d) return '';
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = dt.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const r = await c.query(`
    select
      d.name as name,
      m.doer_email as email,
      d.department as department,
      m.task_id as task_id,
      m.freq as freq,
      t.task_name as task,
      m.planned_date as planned,
      m.actual_date as actual,
      m.status as status,
      m.occurrence_key as occurrence_key
    from master_checklist m
    left join doers d on lower(d.email) = lower(m.doer_email)
    left join tasks t on t.task_id = m.task_id
    order by m.planned_date, m.doer_email, m.task_id
  `);

  console.log(`Exporting ${r.rowCount} rows…`);

  const header = ['Name', 'Email', 'Department', 'Task ID', 'Freq', 'Task', 'Planned', 'Actual', 'Status', 'Occurrence Key'];
  const lines = [header.join(',')];
  for (const row of r.rows) {
    lines.push([
      csvEscape(row.name),
      csvEscape(row.email),
      csvEscape(row.department),
      csvEscape(row.task_id),
      csvEscape(row.freq),
      csvEscape(row.task),
      csvEscape(toDmy(row.planned)),
      csvEscape(toDmy(row.actual)),
      csvEscape(row.status),
      csvEscape(row.occurrence_key),
    ].join(','));
  }

  fs.writeFileSync(OUT_PATH, lines.join('\n'), 'utf8');
  console.log(`Wrote ${OUT_PATH} (${lines.length} lines incl. header)`);

  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
