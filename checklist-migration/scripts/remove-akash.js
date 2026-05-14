// One-off: remove akashdeolinkd@gmail.com from DB + Auth in a transaction.
// User explicitly requested removal of this user and all related data.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');

const EMAIL = 'akashdeolinkd@gmail.com';

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  console.log(`Removing ${EMAIL} from database...\n`);

  try {
    await pg.query('begin');
    const m = await pg.query('delete from master_checklist where doer_email = $1 returning 1', [EMAIL]);
    const a = await pg.query('delete from archive          where doer_email = $1 returning 1', [EMAIL]);
    const t = await pg.query('delete from tasks            where doer_email = $1 returning 1', [EMAIL]);
    const d = await pg.query('delete from doers            where email      = $1 returning 1', [EMAIL]);
    await pg.query('commit');
    console.log(`  master_checklist : ${m.rowCount}`);
    console.log(`  archive          : ${a.rowCount}`);
    console.log(`  tasks            : ${t.rowCount}`);
    console.log(`  doers            : ${d.rowCount}`);
  } catch (e) {
    await pg.query('rollback');
    console.error('DB delete failed, rolled back:', e.message);
    process.exit(1);
  } finally {
    await pg.end();
  }

  // Remove from Supabase Auth
  console.log(`\nRemoving ${EMAIL} from Supabase Auth...`);
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data } = await s.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const u = data.users.find(x => (x.email || '').toLowerCase() === EMAIL);
  if (!u) {
    console.log('  (no Auth user found)');
  } else {
    const { error } = await s.auth.admin.deleteUser(u.id);
    if (error) console.error('  delete failed:', error.message);
    else       console.log(`  deleted Auth user ${u.id}`);
  }

  console.log('\nDone. Restart backend to clear refCache so frontend sees fresh list.');
})();
