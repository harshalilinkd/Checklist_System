// End-to-end test: create a task, mark an occurrence done, delete the task,
// confirm the archived row still carries the task_name.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');

(async () => {
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data } = await anon.auth.signInWithPassword({
    email: 'harshali.linkd@gmail.com',
    password: 'Harshali123',
  });
  const auth = { headers: { Authorization: 'Bearer ' + data.session.access_token, 'Content-Type': 'application/json' } };

  // 1. Create a temporary task
  const name = `__TEST__ Auto-delete sanity ${Date.now()}`;
  const today = new Date().toISOString().slice(0, 10);
  console.log('1) creating task:', name);
  const createRes = await (await fetch('http://localhost:3000/api/tasks', {
    ...auth, method: 'POST',
    body: JSON.stringify({
      task_name: name,
      doer_email: 'harshali.linkd@gmail.com',
      frequency: 'D',
      start_date: today,
      end_date: today,
    }),
  })).json();
  console.log('   created task_id =', createRes.task?.task_id);
  const taskId = createRes.task?.task_id;
  const occurrenceKey = createRes.task ? `${taskId}_${today}` : null;
  if (!occurrenceKey) { console.error('Failed to create task'); process.exit(1); }

  // 2. Mark today's occurrence done
  console.log('2) marking today done…');
  const doneRes = await (await fetch(`http://localhost:3000/api/master/${encodeURIComponent(occurrenceKey)}/done`, {
    ...auth, method: 'POST', body: '{}',
  })).json();
  console.log('   ', doneRes);

  // 3. Delete the task
  console.log('3) deleting task…');
  const delRes = await (await fetch('http://localhost:3000/api/tasks/' + taskId, {
    ...auth, method: 'DELETE',
  })).json();
  console.log('   ', delRes);

  // 4. Check archive row
  console.log('4) checking archive…');
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query('select occurrence_key, task_name, status, doer_email from archive where task_id = $1', [taskId]);
  console.log('   archived rows:', r.rows);
  await c.end();

  if (r.rows.length === 1 && r.rows[0].task_name === name) {
    console.log('\n✓ PASS — archived row has the original task_name preserved');
  } else {
    console.log('\n✗ FAIL — task_name missing or wrong');
    process.exit(1);
  }
})();
