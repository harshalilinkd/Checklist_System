// Provision Supabase Auth users from data/users.csv.
// Usage: node scripts/provision-users.js
//
// CSV columns: Email, Name, Role, Password   (Role = 'admin' | 'user')
//
// For each row:
//   - calls supabase.auth.admin.createUser({ email, password, email_confirm: true,
//                                            user_metadata: { name, role } })
//   - skips users that already exist
//   - dedupes within the CSV (keeps last occurrence per email)
//   - logs success / skip / failure for each row

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');

function nz(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
    process.exit(1);
  }

  const csvPath = path.join(__dirname, '..', 'data', 'users.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`ERROR: ${csvPath} not found`);
    process.exit(1);
  }
  const rows = parse(fs.readFileSync(csvPath, 'utf8'), {
    columns: true, skip_empty_lines: true, trim: true, bom: true,
  });

  const byEmail = new Map();
  for (const r of rows) {
    const email = nz(r.Email)?.toLowerCase();
    const name = nz(r.Name);
    const role = (nz(r.Role) || 'user').toLowerCase();
    const password = nz(r.Password);
    if (!email || !name || !password) {
      console.warn('  [skip] missing email/name/password:', r);
      continue;
    }
    if (byEmail.has(email)) {
      console.warn(`  [warn] duplicate email "${email}" in CSV — keeping last (${name})`);
    }
    byEmail.set(email, { email, name, role, password });
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let created = 0, skipped = 0, failed = 0;
  for (const u of byEmail.values()) {
    try {
      const { error } = await supabase.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
        user_metadata: { name: u.name, role: u.role },
      });
      if (error) {
        // Match Supabase's specific "user already registered" signal, not any
        // error that happens to contain those substrings.
        const isDupe = error.code === 'email_exists'
          || error.code === 'user_already_exists'
          || (error.status === 422 && /already (been )?registered/i.test(error.message || ''));
        if (isDupe) {
          console.log(`  [skip] already exists: ${u.email}`);
          skipped++;
        } else {
          console.error(`  [fail] ${u.email}: ${error.message} (status=${error.status}, code=${error.code})`);
          failed++;
        }
      } else {
        console.log(`  [ok]   ${u.role.padEnd(5)} ${u.email}`);
        created++;
      }
    } catch (e) {
      console.error(`  [fail] ${u.email}: ${e.message}`);
      failed++;
    }
  }

  console.log('\n=== Provisioning complete ===');
  console.log(`  created: ${created}`);
  console.log(`  skipped: ${skipped} (already existed)`);
  console.log(`  failed:  ${failed}`);
  console.log(`  total:   ${byEmail.size}`);
  if (failed > 0) process.exitCode = 1;
}

main();
