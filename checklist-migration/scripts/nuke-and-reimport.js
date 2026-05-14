// Clean reset: truncate archive + master_checklist + tasks, then re-import
// from data/tasks.csv and data/master_checklist.csv.
// - Skips tasks/master rows for doers that aren't in the doers table
//   (preserves the prior cleanup of pooja/roshan/sumanta).
// - Skips master rows whose planned_date is outside the FY window
//   (default 2026-04-01 .. 2027-03-31; override via FY_START / FY_END env).
// - After importing master rows from CSV, backfills the remaining FY months
//   (Sep 2026 .. Mar 2027) via generateOccurrences so the calendar is full.
//
// Usage:  node scripts/nuke-and-reimport.js [--dry]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const { Client } = require('pg');
const { generateOccurrences } = require('../../backend/lib/occurrences');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FY_START = process.env.FY_START || '2026-04-01';
const FY_END   = process.env.FY_END   || '2027-03-31';
const BATCH = 500;
const DRY = process.argv.includes('--dry');

function nz(v) { if (v == null) return null; const t = String(v).trim(); return t === '' ? null : t; }

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

async function bulkInsert(client, table, cols, rows, conflict) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = slice.map((row, rIdx) => {
      const placeholders = cols.map((_, cIdx) => `$${rIdx * cols.length + cIdx + 1}`);
      params.push(...cols.map(c => row[c]));
      return `(${placeholders.join(', ')})`;
    });
    const sql = `insert into ${table} (${cols.join(', ')}) values ${tuples.join(', ')} ${conflict || ''}`;
    await client.query(sql, params);
    process.stdout.write(`\r  ${table}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('Connected.\n');
  console.log(`FY window: ${FY_START} .. ${FY_END}\n`);

  // -------------------- 1. Load CSVs --------------------
  const doerCsv = parse(fs.readFileSync(path.join(DATA_DIR, 'doers.csv'), 'utf8'), { columns: true, skip_empty_lines: true, trim: true, bom: true });
  const taskCsv = parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.csv'), 'utf8'), { columns: true, skip_empty_lines: true, trim: true, bom: true });
  const masterCsv = parse(fs.readFileSync(path.join(DATA_DIR, 'master_checklist.csv'), 'utf8'), { columns: true, skip_empty_lines: true, trim: true, bom: true });
  console.log(`CSV: doers=${doerCsv.length}, tasks=${taskCsv.length}, master=${masterCsv.length}`);

  // Build name → email map from doers.csv (some CSVs reference doer by name)
  const nameToEmail = new Map();
  for (const d of doerCsv) {
    if (d.Name && d['Email Address']) nameToEmail.set(d.Name, d['Email Address'].toLowerCase());
  }

  // -------------------- 2. Snapshot DB --------------------
  const dbDoers = new Set((await c.query('select lower(email) as email from doers')).rows.map(r => r.email));
  console.log(`DB doers: ${dbDoers.size}  (CSV doers not in DB will be skipped)`);

  // -------------------- 3. Build tasks payload --------------------
  const tasks = [];
  const taskByEmailName = new Map(); // (email|name) -> task object (for occurrence backfill)
  let skipTaskNoDoer = 0;
  const taskDedupe = new Set();
  const skippedDoerCounts = new Map();

  for (const r of taskCsv) {
    const taskName = nz(r.Task);
    const doerName = nz(r['Doer Name']);
    const frequency = nz(r.Frequency);
    const startDate = toIsoDate(r['From Date']);
    const endDate = toIsoDate(r['To Date']);
    if (!taskName || !doerName || !frequency || !startDate) continue;
    const email = nameToEmail.get(doerName);
    if (!email || !dbDoers.has(email)) {
      skipTaskNoDoer++;
      if (email) skippedDoerCounts.set(email, (skippedDoerCounts.get(email)||0)+1);
      continue;
    }
    const taskId = nz(r['Task ID']) || makeTaskId(taskName, email);
    if (taskDedupe.has(taskId)) continue;
    taskDedupe.add(taskId);
    const task = {
      task_id: taskId,
      task_name: taskName,
      doer_email: email,
      frequency,
      start_date: startDate,
      end_date: endDate,
      assigned_by: nz(r['Assign By']),
      status: nz(r.Status) || 'Active',
    };
    tasks.push(task);
    taskByEmailName.set(taskId, task);
  }
  console.log(`\nTasks to import: ${tasks.length}  (skipped ${skipTaskNoDoer} for missing doers)`);
  if (skippedDoerCounts.size) {
    for (const [e,n] of skippedDoerCounts) console.log(`  skip-doer ${e.padEnd(45)} ${n}`);
  }

  // -------------------- 4. Build master payload --------------------
  const taskIdSet = new Set(tasks.map(t => t.task_id));
  const masterRows = [];
  let skipMasterNoDoer = 0, skipMasterNoTask = 0, skipMasterOutFy = 0, skipMasterDup = 0;
  const masterDedupe = new Set();

  for (const r of masterCsv) {
    const taskName = nz(r.Task);
    const email = nz(r.Email)?.toLowerCase();
    const plannedDate = toIsoDate(r.Planned);
    if (!taskName || !email || !plannedDate) continue;
    if (!dbDoers.has(email)) { skipMasterNoDoer++; continue; }
    if (plannedDate < FY_START || plannedDate > FY_END) { skipMasterOutFy++; continue; }
    const taskId = nz(r['Task ID']) || makeTaskId(taskName, email);
    if (!taskIdSet.has(taskId)) { skipMasterNoTask++; continue; }
    const occurrenceKey = nz(r['Occurrence Key']) || `${taskId}_${plannedDate}`;
    if (masterDedupe.has(occurrenceKey)) { skipMasterDup++; continue; }
    masterDedupe.add(occurrenceKey);
    masterRows.push({
      occurrence_key: occurrenceKey,
      task_id: taskId,
      doer_email: email,
      planned_date: plannedDate,
      actual_date: toIsoDate(r.Actual),
      freq: nz(r.Freq) || taskByEmailName.get(taskId)?.frequency || null,
      status: nz(r.Status) || 'Scheduled',
    });
  }
  console.log(`\nMaster rows to import: ${masterRows.length}`);
  console.log(`  skipped — no doer:      ${skipMasterNoDoer}`);
  console.log(`  skipped — no task:      ${skipMasterNoTask}`);
  console.log(`  skipped — out of FY:    ${skipMasterOutFy}`);
  console.log(`  skipped — dup occ_key:  ${skipMasterDup}`);

  // -------------------- 5. Backfill plan --------------------
  // For each task in payload, generate FY-clamped occurrences and keep only
  // ones whose occurrence_key isn't already in masterRows (avoid double-insert).
  const backfill = [];
  for (const t of tasks) {
    const occs = generateOccurrences({
      task_id: t.task_id,
      doer_email: t.doer_email,
      frequency: t.frequency,
      start_date: t.start_date,
      end_date: t.end_date,
    }, { rangeTo: FY_END });
    for (const o of occs) {
      if (masterDedupe.has(o.occurrence_key)) continue;
      if (o.planned_date < FY_START || o.planned_date > FY_END) continue;
      masterDedupe.add(o.occurrence_key);
      backfill.push({
        occurrence_key: o.occurrence_key,
        task_id: o.task_id,
        doer_email: o.doer_email,
        planned_date: o.planned_date,
        actual_date: null,
        freq: o.freq,
        status: o.status,
      });
    }
  }
  console.log(`\nBackfill (generated occurrences not already in CSV): ${backfill.length}`);

  console.log(`\nGrand total master rows to be inserted: ${masterRows.length + backfill.length}`);

  if (DRY) {
    console.log('\n[DRY RUN] No DB writes performed.');
    await c.end();
    return;
  }

  // -------------------- 6. Execute --------------------
  console.log('\n── Truncating + re-importing ──');
  await c.query('begin');
  try {
    await c.query('truncate table master_checklist, archive, tasks restart identity cascade');
    console.log('Truncated: tasks, master_checklist, archive');

    await bulkInsert(c, 'tasks',
      ['task_id','task_name','doer_email','frequency','start_date','end_date','assigned_by','status'],
      tasks, 'on conflict do nothing');

    const all = [...masterRows, ...backfill];
    await bulkInsert(c, 'master_checklist',
      ['occurrence_key','task_id','doer_email','planned_date','actual_date','freq','status'],
      all, 'on conflict (occurrence_key) do nothing');

    await c.query('commit');
    console.log('\nCommit OK.');
  } catch (e) {
    await c.query('rollback');
    console.error('Failed, rolled back:', e);
    process.exitCode = 1;
    await c.end();
    return;
  }

  // -------------------- 7. Verify --------------------
  const t = (await c.query('select count(*)::int n from tasks')).rows[0].n;
  const m = (await c.query('select count(*)::int n from master_checklist')).rows[0].n;
  const a = (await c.query('select count(*)::int n from archive')).rows[0].n;
  const range = (await c.query('select min(planned_date) min, max(planned_date) max from master_checklist')).rows[0];
  const status = (await c.query("select status, count(*)::int n from master_checklist group by status order by status")).rows;
  console.log('\n── Final state ──');
  console.log(`  tasks:            ${t}`);
  console.log(`  master_checklist: ${m}`);
  console.log(`  archive:          ${a}`);
  console.log(`  master range:     ${range.min} .. ${range.max}`);
  console.log('  by status:');
  status.forEach(r => console.log(`    ${r.status.padEnd(16)} ${r.n}`));

  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
