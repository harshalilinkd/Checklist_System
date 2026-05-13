// Remove specified Supabase Auth users.
// Standalone (no DB dependency) — pairs with remove-doers.js when you want
// to wipe both database rows AND the login accounts.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const EMAILS = [
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

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // List all users (paged)
  let users = []; let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) { console.error('listUsers:', error.message); process.exit(1); }
    users = users.concat(data.users);
    if (data.users.length < 1000) break;
    page++;
  }
  console.log(`Found ${users.length} total Auth users.\n`);

  let removed = 0, skipped = 0, failed = 0;
  for (const email of EMAILS) {
    const u = users.find(x => (x.email || '').toLowerCase() === email);
    if (!u) { console.log(`  [skip]  no Auth user: ${email}`); skipped++; continue; }
    const { error } = await supabase.auth.admin.deleteUser(u.id);
    if (error) { console.error(`  [fail]  ${email}: ${error.message}`); failed++; }
    else       { console.log(`  [ok]    deleted ${email}`); removed++; }
  }
  console.log(`\n=== Done === removed=${removed}  skipped=${skipped}  failed=${failed}`);
})();
