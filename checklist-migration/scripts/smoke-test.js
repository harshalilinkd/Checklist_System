// End-to-end smoke test against running backend at http://localhost:3000.
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
  const fail = m => { console.error('FAIL:', m); process.exit(1); };

  console.log('1) /api/health');
  let r = await fetchJson('/api/health');
  if (r.status !== 200 || !r.body.ok) fail(`health: ${r.status} ${JSON.stringify(r.body)}`);
  console.log('   ok', r.body);

  console.log('\n2) login as admin (Mahesh)');
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: signIn, error } = await anon.auth.signInWithPassword({
    email: 'maheshgavhane150@gmail.com', password: 'Mahesh123',
  });
  if (error) fail('signin: ' + error.message);
  const token = signIn.session.access_token;
  console.log('   got token');

  const auth = { headers: { Authorization: 'Bearer ' + token } };

  console.log('\n3) /api/me');
  r = await fetchJson('/api/me', auth);
  if (r.status !== 200) fail(`me: ${r.status} ${JSON.stringify(r.body)}`);
  console.log('  ', r.body);

  console.log('\n4) /api/bootstrap (admin)');
  r = await fetchJson('/api/bootstrap', auth);
  if (r.status !== 200) fail(`bootstrap: ${r.status} ${JSON.stringify(r.body)}`);
  console.log(`   user: ${r.body.user.email} (admin=${r.body.user.isAdmin})`);
  console.log(`   doers: ${r.body.doers.length}`);
  console.log(`   tasks: ${r.body.tasks.length}`);
  console.log(`   master window rows: ${r.body.masterWindow.rows.length}, nextCursor: ${r.body.masterWindow.nextCursor}`);
  if (r.body.masterWindow.rows[0]) {
    console.log(`   sample row:`, {
      task: r.body.masterWindow.rows[0].task_name,
      doer: r.body.masterWindow.rows[0].doer_email,
      planned: r.body.masterWindow.rows[0].planned_date,
      status: r.body.masterWindow.rows[0].status,
    });
  }

  console.log('\n5) /api/bootstrap (regular user — Jagruti)');
  const { data: si2 } = await anon.auth.signInWithPassword({
    email: 'jagruti.linkd@gmail.com', password: 'Jagruti123',
  });
  const auth2 = { headers: { Authorization: 'Bearer ' + si2.session.access_token } };
  r = await fetchJson('/api/bootstrap', auth2);
  if (r.status !== 200) fail(`bootstrap user: ${r.status} ${JSON.stringify(r.body)}`);
  console.log(`   user: ${r.body.user.email} (admin=${r.body.user.isAdmin})`);
  console.log(`   doers visible: ${r.body.doers.length}`);
  console.log(`   tasks visible: ${r.body.tasks.length}`);
  console.log(`   master window rows: ${r.body.masterWindow.rows.length}`);
  const myEmail = r.body.user.email;
  const otherDoer = r.body.masterWindow.rows.find(x => x.doer_email !== myEmail);
  if (otherDoer) fail(`leak: non-admin saw row for ${otherDoer.doer_email}`);
  console.log('   filter ok: only own rows');

  console.log('\n6) /api/master no-auth → 401');
  r = await fetchJson('/api/master');
  if (r.status !== 401) fail(`expected 401, got ${r.status}`);
  console.log('   ok');

  console.log('\nALL CHECKS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
