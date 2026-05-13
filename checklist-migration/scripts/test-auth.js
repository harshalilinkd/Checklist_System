// Sanity-check: sign in a user with email/password and inspect the JWT
// claims that backend/auth.js verifyToken() would return.
// Usage: node scripts/test-auth.js <email> <password>

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error('Usage: node scripts/test-auth.js <email> <password>');
  process.exit(1);
}

const adminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

(async () => {
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) {
    console.error('Sign-in failed:', signInErr.message);
    process.exit(1);
  }
  console.log('Signed in. Token (first 40):', signIn.session.access_token.slice(0, 40) + '...');

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: u, error: getErr } = await admin.auth.getUser(signIn.session.access_token);
  if (getErr) {
    console.error('getUser failed:', getErr.message);
    process.exit(1);
  }
  const e = (u.user.email || '').toLowerCase();
  const metaRole = (u.user.user_metadata?.role || '').toLowerCase();
  const isAdmin = metaRole === 'admin' || adminEmails.includes(e);

  console.log('verifyToken result:', { email: e, role: isAdmin ? 'admin' : 'user', isAdmin });
  process.exit(0);
})();
