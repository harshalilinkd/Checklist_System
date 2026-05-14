// Tasks-only import: upserts tasks from data/tasks.csv.
// - Resolves doer email from data/doers.csv name→email lookup.
// - Skips rows whose doer is not in the doers table (preserves intentional deletes).
// - Does NOT delete tasks that are in DB but missing from CSV.
//
// Usage:  node scripts/import-tasks-only.js [--dry]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const { Client } = require('pg');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BATCH_SIZE = 200;
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
  if (rows.length === 0) return;
  const cols = ['task_id', 'task_name', 'doer_email', 'frequency', 'start_date', 'end_date', 'assigned_by', 'status'];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const tuples = slice.map((row, rIdx) => {
      const placeholders = cols.map((_, cIdx) => `$${rIdx * cols.length + cIdx + 1}`);
      params.push(...cols.map(c => row[c]));
      return `(${placeholders.join(', ')})`;
    });
    const sql = `
      insert into tasks (${cols.join(', ')}) values ${tuples.join(', ')}
      on conflict (task_id) do update set
        task_name   = excluded.task_name,
        doer_email  = excluded.doer_email,
        frequency   = excluded.frequency,
        start_date  = excluded.start_date,
        end_date    = excluded.end_date,
        assigned_by = excluded.assigned_by,
        status      = excluded.status`;
    await client.query(sql, params);
  }
}

(async () => {
  const taskRows = parse(fs.readFileSync(path.join(DATA_DIR, 'tasks.csv'), 'utf8'), {
    columns: true, skip_empty_lines: true, trim: true, bom: true,
  });
  const doerRows = parse(fs.readFileSync(path.join(DATA_DIR, 'doers.csv'), 'utf8'), {
    columns: true, skip_empty_lines: true, trim: true, bom: true,
  });

  const nameToEmail = new Map();
  for (const d of doerRows) {
    const name = nz(d.Name);
    const email = nz(d['Email Address']);
    if (name && email) nameToEmail.set(name, email.toLowerCase());
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('Connected.\n');

  const knownDoers = new Set((await c.query('select lower(email) as email from doers')).rows.map(r => r.email));
  const dbTasks = new Map(
    (await c.query('select task_id, task_name, doer_email, frequency, start_date, end_date, assigned_by, status from tasks')).rows
      .map(t => [t.task_id, t])
  );
  console.log(`DB: ${knownDoers.size} doers, ${dbTasks.size} tasks`);

  const prepared = [];
  let skipNoDoer = 0, skipMissingFields = 0, newCt = 0, updCt = 0, sameCt = 0;
  const skipDoersMap = new Map();
  const dedupe = new Set();

  for (const r of taskRows) {
    const taskName = nz(r.Task);
    const doerName = nz(r['Doer Name']);
    const frequency = nz(r.Frequency);
    const startDate = toIsoDate(r['From Date']);
    const endDate = toIsoDate(r['To Date']);
    const assignedBy = nz(r['Assign By']);
    const status = nz(r.Status) || 'Active';

    if (!taskName || !doerName || !frequency || !startDate) { skipMissingFields++; continue; }

    const email = nameToEmail.get(doerName);
    if (!email) { skipNoDoer++; skipDoersMap.set('(unknown name) ' + doerName, (skipDoersMap.get('(unknown name) ' + doerName)||0)+1); continue; }
    if (!knownDoers.has(email)) {
      skipNoDoer++;
      skipDoersMap.set(email, (skipDoersMap.get(email)||0)+1);
      continue;
    }

    const taskId = nz(r['Task ID']) || makeTaskId(taskName, email);
    if (dedupe.has(taskId)) continue;
    dedupe.add(taskId);

    const existing = dbTasks.get(taskId);
    const row = { task_id: taskId, task_name: taskName, doer_email: email, frequency, start_date: startDate, end_date: endDate, assigned_by: assignedBy, status };
    if (!existing) {
      newCt++;
    } else {
      const changed = existing.frequency !== frequency
                   || String(existing.start_date) !== startDate
                   || String(existing.end_date || '') !== (endDate || '')
                   || existing.task_name !== taskName
                   || (existing.assigned_by || '') !== (assignedBy || '')
                   || existing.status !== status;
      if (changed) updCt++; else sameCt++;
    }
    prepared.push(row);
  }

  console.log('\nPlan:');
  console.log(`  CSV rows:        ${taskRows.length}`);
  console.log(`  → upsert:        ${prepared.length}`);
  console.log(`    - new:         ${newCt}`);
  console.log(`    - changed:     ${updCt}`);
  console.log(`    - unchanged:   ${sameCt}`);
  console.log(`  → skipped no doer: ${skipNoDoer}`);
  console.log(`  → skipped missing fields: ${skipMissingFields}`);
  if (skipDoersMap.size) {
    console.log('  Skipped doer breakdown:');
    for (const [e,n] of skipDoersMap) console.log(`    - ${String(e).padEnd(45)} ${n}`);
  }

  if (DRY) {
    console.log('\n[DRY RUN] No DB writes performed.');
    await c.end();
    return;
  }

  console.log('\nApplying upsert in transaction…');
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

  const after = await c.query('select count(*)::int as n from tasks');
  console.log(`\nPost-import tasks: ${after.rows[0].n} rows`);

  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
