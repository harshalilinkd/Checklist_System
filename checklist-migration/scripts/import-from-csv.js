// Import doers, tasks, and master_checklist from Sheet-format CSVs.
// Usage: node scripts/import-from-csv.js
//
// Reads:
//   data/doers.csv             (cols: Name, Department, Email Address)
//   data/tasks.csv             (cols: Task, Doer Name, Department, Frequency,
//                                     From Date, To Date, Status, Task ID, Assign By)
//   data/master_checklist.csv  (cols: Name, Email, Department, Task ID, Freq,
//                                     Task, Planned, Actual, Status, Occurrence Key)
//
// task_id and occurrence_key are generated deterministically:
//   task_id        = 't_' + sha1(task_name + '|' + doer_email).slice(0, 16)
//   occurrence_key = task_id + '_' + planned_date_iso
//
// Safe to re-run: every insert uses ON CONFLICT DO UPDATE/NOTHING.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const { Client } = require('pg');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nz(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

// Convert dates to ISO YYYY-MM-DD. Auto-detects D/M/Y vs M/D/Y when
// ambiguous, defaults to D/M/Y (Indian Sheet locale). Pass-through for ISO.
function toIsoDate(v) {
  const x = nz(v);
  if (x === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  const m = x.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    let [, a, b, y] = m;
    a = parseInt(a, 10); b = parseInt(b, 10);
    let day, month;
    if (a > 12)      { day = a; month = b; }   // unambiguously D/M/Y
    else if (b > 12) { month = a; day = b; }   // unambiguously M/D/Y
    else             { day = a; month = b; }   // ambiguous → assume D/M/Y
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

function readCsv(filename) {
  const fullPath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    console.warn(`  [skip] ${filename} not found`);
    return null;
  }
  return parse(fs.readFileSync(fullPath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
}

// Build a multi-row INSERT ... ON CONFLICT statement.
async function batchInsert(client, table, columns, rows, conflictClause) {
  if (rows.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const tuples = slice.map((row, rIdx) => {
      const placeholders = columns.map((_, cIdx) => `$${rIdx * columns.length + cIdx + 1}`);
      params.push(...columns.map(c => row[c]));
      return `(${placeholders.join(', ')})`;
    });
    const sql = `insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')} ${conflictClause}`;
    await client.query(sql, params);
    inserted += slice.length;
    process.stdout.write(`\r  ${table}: ${inserted}/${rows.length}`);
  }
  process.stdout.write('\n');
  return inserted;
}

// ---------------------------------------------------------------------------
// Importers
// ---------------------------------------------------------------------------

async function importDoers(client) {
  console.log('\n[1/3] doers');
  const rows = readCsv('doers.csv');
  if (!rows) return { count: 0, nameToEmail: new Map() };

  const nameToEmail = new Map();
  const byEmail = new Map(); // dedupe: keep last occurrence per email
  for (const r of rows) {
    const name = nz(r.Name);
    const department = nz(r.Department);
    const email = nz(r['Email Address']);
    if (!name || !email) {
      console.warn(`  [skip] missing name/email:`, r);
      continue;
    }
    nameToEmail.set(name, email);
    byEmail.set(email, { name, department, email });
  }
  const prepared = Array.from(byEmail.values());

  await batchInsert(
    client,
    'doers',
    ['name', 'department', 'email'],
    prepared,
    `on conflict (email) do update set name = excluded.name, department = excluded.department`
  );
  console.log(`  imported ${prepared.length} doer(s)`);
  return { count: prepared.length, nameToEmail };
}

async function importTasks(client, nameToEmail) {
  console.log('\n[2/3] tasks');
  const rows = readCsv('tasks.csv');
  if (!rows) return { count: 0, taskIdLookup: new Map() };

  const taskIdLookup = new Map(); // key: `${task_name}|${email}` -> task_id
  const prepared = [];
  let skipped = 0;

  for (const r of rows) {
    const taskName = nz(r.Task);
    const doerName = nz(r['Doer Name']);
    const frequency = nz(r.Frequency);
    const startDate = toIsoDate(r['From Date']);
    const endDate = toIsoDate(r['To Date']);
    const assignedBy = nz(r['Assign By']);
    const status = nz(r.Status) || 'Active';

    if (!taskName || !doerName || !frequency || !startDate) {
      skipped++; continue;
    }
    const email = nameToEmail.get(doerName);
    if (!email) {
      console.warn(`  [skip] doer not found in doers.csv: "${doerName}"`);
      skipped++; continue;
    }

    const taskId = nz(r['Task ID']) || makeTaskId(taskName, email);
    taskIdLookup.set(`${taskName}|${email}`, taskId);

    prepared.push({
      task_id: taskId,
      task_name: taskName,
      doer_email: email,
      frequency,
      start_date: startDate,
      end_date: endDate,
      assigned_by: assignedBy,
      status,
    });
  }

  await batchInsert(
    client,
    'tasks',
    ['task_id', 'task_name', 'doer_email', 'frequency', 'start_date', 'end_date', 'assigned_by', 'status'],
    prepared,
    `on conflict (task_id) do update
       set task_name = excluded.task_name,
           doer_email = excluded.doer_email,
           frequency = excluded.frequency,
           start_date = excluded.start_date,
           end_date = excluded.end_date,
           assigned_by = excluded.assigned_by,
           status = excluded.status`
  );
  console.log(`  imported ${prepared.length} task(s); skipped ${skipped}`);
  return { count: prepared.length, taskIdLookup };
}

async function importMaster(client, taskIdLookup) {
  console.log('\n[3/3] master_checklist');
  const rows = readCsv('master_checklist.csv');
  if (!rows) return 0;

  // Map task_id -> frequency from the tasks we just inserted.
  const freqMap = new Map();
  const taskRows = await client.query('select task_id, frequency from tasks');
  for (const t of taskRows.rows) freqMap.set(t.task_id, t.frequency);

  const prepared = [];
  let skipped = 0;
  const dedupe = new Set(); // de-dup occurrence_key collisions within the CSV

  for (const r of rows) {
    const taskName = nz(r.Task);
    const email = nz(r.Email);
    const plannedDate = toIsoDate(r.Planned);
    const actualDate = toIsoDate(r.Actual);
    const status = nz(r.Status) || 'Scheduled';

    if (!taskName || !email || !plannedDate) { skipped++; continue; }

    const taskId = nz(r['Task ID']) || taskIdLookup.get(`${taskName}|${email}`);
    if (!taskId) { skipped++; continue; }

    const occurrenceKey = nz(r['Occurrence Key']) || `${taskId}_${plannedDate}`;
    if (dedupe.has(occurrenceKey)) { skipped++; continue; }
    dedupe.add(occurrenceKey);

    const freq = nz(r.Freq) || freqMap.get(taskId) || null;

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

  await batchInsert(
    client,
    'master_checklist',
    ['occurrence_key', 'task_id', 'doer_email', 'planned_date', 'actual_date', 'freq', 'status'],
    prepared,
    `on conflict (occurrence_key) do update
       set task_id = excluded.task_id,
           doer_email = excluded.doer_email,
           planned_date = excluded.planned_date,
           actual_date = excluded.actual_date,
           freq = excluded.freq,
           status = excluded.status`
  );
  console.log(`  imported ${prepared.length} master row(s); skipped ${skipped}`);
  return prepared.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('Connected.');

  try {
    await client.query('begin');
    const { count: d, nameToEmail } = await importDoers(client);
    const { count: t, taskIdLookup } = await importTasks(client, nameToEmail);
    const m = await importMaster(client, taskIdLookup);
    await client.query('commit');

    console.log('\n=== Import complete ===');
    console.log(`  doers:            ${d}`);
    console.log(`  tasks:            ${t}`);
    console.log(`  master_checklist: ${m}`);
  } catch (err) {
    await client.query('rollback');
    console.error('\nImport failed, rolled back:');
    console.error(err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
