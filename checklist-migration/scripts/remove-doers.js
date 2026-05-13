// Hard-delete specified doers and their cascaded data from Postgres.
//
// Deletes in this order (all in one transaction so partial failure rolls back):
//   1. master_checklist rows for these doers
//   2. archive rows for these doers
//   3. tasks owned by these doers (cascades any remaining master rows)
//   4. doers rows themselves
//
// Auth users (Supabase) are left intact — pass --delete-auth to remove them too.
//
// Usage: node scripts/remove-doers.js
//        node scripts/remove-doers.js --delete-auth

require('dotenv').config();
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const EMAILS_TO_REMOVE = [
  'chiranjeev.rajput@gmail.com',
  'deepikamahale3@gmail.com',
  'salescoordinator.linkd@gmail.com',
  'crm.linkd@gmail.com',
  'sumantadeoatlinkdprints@gmail.com',
  'pooja.deolinkd@gmail.com',
  'sharanniacrmlinkd@gmail.com',
  'roshan.deolinkd@gmail.com',
  'samidhadesigndeo.linkdprints@gmail.com',
  'test@gmail.com',
].map(e => e.toLowerCase());

const deleteAuth = process.argv.includes('--delete-auth');

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  try {
    // Snapshot counts BEFORE
    console.log('Emails targeted:');
    for (const e of EMAILS_TO_REMOVE) console.log('  -', e);

    const present = await pg.query('select email, name from doers where email = ANY($1)', [EMAILS_TO_REMOVE]);
    console.log(`\nFound ${present.rowCount} of ${EMAILS_TO_REMOVE.length} in the doers table.`);
    if (present.rowCount === 0) { console.log('Nothing to do.'); await pg.end(); return; }
    for (const r of present.rows) console.log(`  ${r.email.padEnd(40)} ${r.name}`);

    const counts = await pg.query(`
      select
        (select count(*)::int from tasks            where doer_email = ANY($1)) as tasks,
        (select count(*)::int from master_checklist where doer_email = ANY($1)) as master,
        (select count(*)::int from archive          where doer_email = ANY($1)) as archive
    `, [EMAILS_TO_REMOVE]);
    console.log('\nRelated rows to be deleted:');
    console.log('  tasks            :', counts.rows[0].tasks);
    console.log('  master_checklist :', counts.rows[0].master);
    console.log('  archive          :', counts.rows[0].archive);

    // Delete in a single transaction
    console.log('\nDeleting in a transaction...');
    await pg.query('begin');
    const dM = await pg.query('delete from master_checklist where doer_email = ANY($1) returning id', [EMAILS_TO_REMOVE]);
    const dA = await pg.query('delete from archive          where doer_email = ANY($1) returning id', [EMAILS_TO_REMOVE]);
    const dT = await pg.query('delete from tasks            where doer_email = ANY($1) returning task_id', [EMAILS_TO_REMOVE]);
    const dD = await pg.query('delete from doers            where email      = ANY($1) returning id', [EMAILS_TO_REMOVE]);
    await pg.query('commit');

    console.log(`  deleted ${dM.rowCount} master_checklist row(s)`);
    console.log(`  deleted ${dA.rowCount} archive row(s)`);
    console.log(`  deleted ${dT.rowCount} task row(s)`);
    console.log(`  deleted ${dD.rowCount} doer row(s)`);

    // Optionally also remove Supabase Auth users
    if (deleteAuth) {
      console.log('\nRemoving Supabase Auth users (--delete-auth)...');
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      let listed = []; let page = 1;
      while (true) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) { console.error('listUsers:', error.message); break; }
        listed = listed.concat(data.users);
        if (data.users.length < 1000) break;
        page++;
      }
      for (const email of EMAILS_TO_REMOVE) {
        const u = listed.find(x => (x.email || '').toLowerCase() === email);
        if (!u) { console.log(`  [skip] no Auth user: ${email}`); continue; }
        const { error } = await supabase.auth.admin.deleteUser(u.id);
        if (error) console.error(`  [fail] ${email}: ${error.message}`);
        else      console.log(`  [ok]   ${email}`);
      }
    } else {
      console.log('\nAuth users left intact. Re-run with --delete-auth to remove them too.');
    }

    console.log('\nDone.');
  } catch (err) {
    await pg.query('rollback').catch(() => {});
    console.error('FAILED, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
})();
