// Smoke-test admin endpoints: stats, run archive, stats again, run extend.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BASE = 'http://localhost:3000';

async function fetchJson(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

(async () => {
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: si, error } = await anon.auth.signInWithPassword({
    email: 'maheshgavhane150@gmail.com', password: 'Mahesh123',
  });
  if (error) { console.error('signin failed:', error.message); process.exit(1); }
  const auth = { headers: { Authorization: 'Bearer ' + si.session.access_token, 'Content-Type': 'application/json' } };

  console.log('1) stats (before)');
  let r = await fetchJson('/api/admin/stats', auth);
  console.log('  ', r.body);

  console.log('\n2) run archive');
  r = await fetchJson('/api/admin/run-job', { ...auth, method: 'POST', body: JSON.stringify({ job: 'archive' }) });
  console.log('  ', r.body);

  console.log('\n3) stats (after archive)');
  r = await fetchJson('/api/admin/stats', auth);
  console.log('  ', r.body);

  console.log('\n4) run extend');
  r = await fetchJson('/api/admin/run-job', { ...auth, method: 'POST', body: JSON.stringify({ job: 'extend' }) });
  console.log('  ', r.body);

  console.log('\n5) non-admin tries /api/admin/stats → expect 403');
  const { data: si2 } = await anon.auth.signInWithPassword({
    email: 'jagruti.linkd@gmail.com', password: 'Jagruti123',
  });
  r = await fetchJson('/api/admin/stats', {
    headers: { Authorization: 'Bearer ' + si2.session.access_token },
  });
  console.log('   status:', r.status, '(should be 403)');
  if (r.status !== 403) { console.error('FAIL: non-admin not blocked'); process.exit(1); }

  console.log('\nALL OK');
})().catch(e => { console.error(e); process.exit(1); });
