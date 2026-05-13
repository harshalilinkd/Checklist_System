// Update an existing Supabase Auth user's password and metadata.
// Usage: node scripts/update-user.js <email> <password> <name> <role>
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const [, , email, password, name, role] = process.argv;
if (!email || !password) {
  console.error('Usage: node scripts/update-user.js <email> <password> [name] [role]');
  process.exit(1);
}

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Find the user by listing pages (admin API has no direct getByEmail).
  let target = null;
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) { console.error('listUsers:', error.message); process.exit(1); }
    target = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (target) break;
    if (data.users.length < 1000) break;
    page++;
  }
  if (!target) { console.error('No user found:', email); process.exit(1); }

  const meta = { ...(target.user_metadata || {}) };
  if (name) meta.name = name;
  if (role) meta.role = role.toLowerCase();

  const { error: updateErr } = await supabase.auth.admin.updateUserById(target.id, {
    password,
    user_metadata: meta,
    email_confirm: true,
  });
  if (updateErr) { console.error('update:', updateErr.message); process.exit(1); }

  console.log('Updated:', { email: target.email, id: target.id, user_metadata: meta });
})();
