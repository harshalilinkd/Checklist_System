require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');

const email = (process.argv[2] || '').toLowerCase();
if (!email) {
  console.error('Usage: node scripts/check-user.js <email>');
  process.exit(1);
}

(async () => {
  // DB checks
  const pg = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  console.log(`\nChecking: ${email}\n`);

  const doerR = await pg.query('select id, name, department, email, created_at from doers where lower(email) = $1', [email]);
  console.log('--- doers table ---');
  if (doerR.rowCount === 0) console.log('  NOT present');
  else console.log('  PRESENT:', doerR.rows[0]);

  const taskR = await pg.query('select count(*)::int as n from tasks where lower(doer_email) = $1', [email]);
  const masterR = await pg.query('select count(*)::int as n from master_checklist where lower(doer_email) = $1', [email]);
  const archiveR = await pg.query('select count(*)::int as n from archive where lower(doer_email) = $1', [email]);
  console.log(`  tasks:            ${taskR.rows[0].n}`);
  console.log(`  master_checklist: ${masterR.rows[0].n}`);
  console.log(`  archive:          ${archiveR.rows[0].n}`);

  await pg.end();

  // Auth check
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data } = await s.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const u = data.users.find(x => (x.email || '').toLowerCase() === email);
  console.log('\n--- Supabase Auth ---');
  if (!u) console.log('  NOT present');
  else console.log('  PRESENT:', { id: u.id, email: u.email, name: u.user_metadata?.name, role: u.user_metadata?.role, created_at: u.created_at });

  // ADMIN_EMAILS check
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  console.log('\n--- ADMIN_EMAILS env override ---');
  console.log(`  ${admins.includes(email) ? 'INCLUDED' : 'not included'}`);
})();
