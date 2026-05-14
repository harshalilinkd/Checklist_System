// Master-only import: upserts master_checklist rows from data/master_checklist.csv
// Skips rows whose parent task/doer is not already in the DB (preserves the
// intentional doer/task cleanup that happened after the original CSV import).
//
// Run with:  node scripts/import-master-only.js [--dry]
//
// Idempotent (uses ON CONFLICT (occurrence_key) DO UPDATE).
// Never deletes — does not touch master rows absent from the CSV.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const { Client } = require('pg');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BATCH_SIZE = 500;
const DRY = process.argv.includes('--dry');

function nz(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function toIsoDate(v) {
  const x = nz(v);
  if (x === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  const m = x.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    let [, a, b, y] = m;
    a = parseInt(a, 10); b = parseInt(b, 10);
    let day, month;
    if (a > 12)      { day = a; month = b; }
    else if (b > 12) { month = a; day = b; }
    else             { day = a; month = b; }
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`Out-of-range date: "${v}"`);
    }
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const parsed = new Date(x);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  throw new Error(`Unparseable date: "${v}"`);
}

function makeTaskId(taskName, email) {
  const h = crypto.createHash('sha1').update(`${taskName}|${email}`).digest('hex');
  return 't_' + h.slice(0, 16);
}

async function batchInsert(client, rows) {
  if (rows.length === 0) return 0;
  const cols = ['occurrence_key', 'task_id', 'doer_email', 'planned_date', 'actual_date', 'freq', 'status'];
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const tuples = slice.map((row, rIdx) => {
      const placeholders = cols.map((_, cIdx) => `$${rIdx * cols.length + cIdx + 1}`);
      params.push(...cols.map(c => row[c]));
      return `(${placeholders.join(', ')})`;
    });
    const sql = `
      insert into master_checklist (${cols.join(', ')}) values ${tuples.join(', ')}
      on conflict (occurrence_key) do update set
        task_id      = excluded.task_id,
        doer_email   = excluded.doer_email,
        planned_date = excluded.planned_date,
        actual_date  = excluded.actual_date,
        freq         = excluded.freq,
        status       = excluded.status`;
    await client.query(sql, params);
    inserted += slice.length;
    process.stdout.write(`\r  upserted ${inserted}/${rows.length}`);
  }
  process.stdout.write('\n');
  return inserted;
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  const csvPath = path.join(DATA_DIR, 'master_checklist.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('ERROR: data/master_checklist.csv not found');
    process.exit(1);
  }
  const csvRows = parse(fs.readFileSync(csvPath, 'utf8'), {
    columns: true, skip_empty_lines: true, trim: true, bom: true,
  });
  console.log(`CSV: ${csvRows.length} rows`);

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('Connected.\n');

  // Snapshot existing master rows by occurrence_key (for diff stats)
  const existingKeysR = await c.query('select occurrence_key, actual_date, status from master_checklist');
  const existing = new Map();
  for (const r of existingKeysR.rows) existing.set(r.occurrence_key, r);
  console.log(`DB master_checklist: ${existing.size} rows currently`);

  // Index of existing tasks + doers — used to skip orphan CSV rows
  const knownTasks = new Set((await c.query('select task_id from tasks')).rows.map(r => r.task_id));
  const knownDoers = new Set((await c.query('select lower(email) as email from doers')).rows.map(r => r.email));
  console.log(`DB tasks: ${knownTasks.size}, DB doers: ${knownDoers.size}\n`);

  const prepared = [];
  const skipped = { missingTask: 0, missingDoer: 0, missingFields: 0, dupKey: 0 };
  const skippedTasks = new Map(); // task_id -> {name, email, count}
  const skippedDoers = new Map();
  const dedupe = new Set();

  for (const r of csvRows) {
    const taskName = nz(r.Task);
    const email = nz(r.Email)?.toLowerCase();
    const plannedDate = toIsoDate(r.Planned);
    const actualDate = toIsoDate(r.Actual);
    const status = nz(r.Status) || 'Scheduled';
    const freq = nz(r.Freq);

    if (!taskName || !email || !plannedDate) { skipped.missingFields++; continue; }

    if (!knownDoers.has(email)) {
      skipped.missingDoer++;
      skippedDoers.set(email, (skippedDoers.get(email) || 0) + 1);
      continue;
    }

    const taskId = nz(r['Task ID']) || makeTaskId(taskName, email);
    if (!knownTasks.has(taskId)) {
      skipped.missingTask++;
      const key = `${taskId}|${email}|${taskName}`;
      skippedTasks.set(key, (skippedTasks.get(key) || 0) + 1);
      continue;
    }

    const occurrenceKey = nz(r['Occurrence Key']) || `${taskId}_${plannedDate}`;
    if (dedupe.has(occurrenceKey)) { skipped.dupKey++; continue; }
    dedupe.add(occurrenceKey);

    prepared.push({
      occurrence_key: occurrenceKey,
      task_id: taskId,
      doer_email: email,
      planned_date: plannedDate,
      actual_date: actualDate,
      freq,
      status,
    });
  }

  // Diff stats (over rows that would be applied)
  let newRows = 0, updatedRows = 0, unchangedRows = 0;
  for (const row of prepared) {
    const cur = existing.get(row.occurrence_key);
    if (!cur) newRows++;
    else if (cur.actual_date !== row.actual_date || cur.status !== row.status) updatedRows++;
    else unchangedRows++;
  }

  console.log('Plan:');
  console.log(`  CSV rows total:        ${csvRows.length}`);
  console.log(`  Will upsert:           ${prepared.length}`);
  console.log(`    - new rows:          ${newRows}`);
  console.log(`    - updated rows:      ${updatedRows}`);
  console.log(`    - unchanged rows:    ${unchangedRows}`);
  console.log(`  Skipped:`);
  console.log(`    - missing doer:      ${skipped.missingDoer}  (${skippedDoers.size} unique doers)`);
  console.log(`    - missing task:      ${skipped.missingTask}  (${skippedTasks.size} unique tasks)`);
  console.log(`    - missing fields:    ${skipped.missingFields}`);
  console.log(`    - dup occ_key in CSV:${skipped.dupKey}`);

  if (skippedDoers.size) {
    console.log('\n  Skipped doers (not in DB):');
    for (const [e, n] of skippedDoers) console.log(`    - ${e.padEnd(45)} ${n} row(s)`);
  }

  if (DRY) {
    console.log('\n[DRY RUN] No DB writes performed. Re-run without --dry to apply.');
    await c.end();
    return;
  }

  console.log('\nApplying upsert in single transaction…');
  await c.query('begin');
  try {
    await batchInsert(c, prepared);
    await c.query('commit');
    console.log('Commit OK.');
  } catch (e) {
    await c.query('rollback');
    console.error('Failed, rolled back:', e);
    process.exitCode = 1;
  }

  // Post-import verification
  const after = await c.query('select count(*)::int as n, min(planned_date) as min, max(planned_date) as max from master_checklist');
  const byStatus = await c.query("select status, count(*)::int as n from master_checklist group by status order by status");
  console.log('\nPost-import master_checklist:');
  console.log(`  rows:    ${after.rows[0].n}`);
  console.log(`  range:   ${after.rows[0].min} .. ${after.rows[0].max}`);
  console.log('  status:');
  for (const r of byStatus.rows) console.log(`    ${r.status.padEnd(16)} ${r.n}`);

  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
