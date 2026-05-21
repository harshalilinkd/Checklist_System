const express = require('express');
const { query, withTx } = require('../db');
const { invalidateDoers, invalidateMaster, invalidateTasks } = require('../cache');
const { requireAdmin } = require('../auth');
const { upsertAuthUser, changeAuthEmail, deleteAuthUser } = require('../lib/supabase-admin');

const router = express.Router();

// Creating a doer also provisions their Supabase Auth account so they can
// log in immediately (email + password or Google with the same email). Role
// is stored in user_metadata.role; admin === 'admin'.
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name, department, email, password, role } = req.body || {};
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required', code: 400 });
    }
    if (!password) {
      return res.status(400).json({ error: 'password is required when creating a doer (used for the auth account)', code: 400 });
    }
    const r = await query(
      `insert into doers (name, department, email)
       values ($1, $2, $3)
       on conflict (email) do update
         set name = excluded.name, department = excluded.department
       returning *`,
      [name, department || null, email.toLowerCase()]
    );
    // Provision/refresh Supabase Auth account (idempotent — updates if exists).
    let authResult = null;
    try {
      authResult = await upsertAuthUser({ email, password, name, role });
    } catch (authErr) {
      // Don't fail the whole request — the doer row exists and is functional;
      // log the auth issue so admin can retry the password set later.
      console.error('Auth provisioning failed for', email, '-', authErr.message);
      authResult = { error: authErr.message };
    }
    invalidateDoers();
    res.json({ ...r.rows[0], auth: authResult });
  } catch (e) { next(e); }
});

// Updating `email` is special: it's the natural FK target from tasks,
// master_checklist, and archive, and the schema has no ON UPDATE CASCADE.
// So an email change must repoint every referencing row in a transaction:
// insert new doer row → update children → delete old doer row.
router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, department, email, password, role } = req.body || {};
    const id = req.params.id;
    const newEmail = email ? email.toLowerCase() : null;

    const result = await withTx(async (client) => {
      const existing = await client.query('select * from doers where id = $1', [id]);
      if (existing.rowCount === 0) return { error: 'Doer not found', code: 404 };
      const cur = existing.rows[0];
      const emailChanging = newEmail && newEmail !== cur.email;

      if (!emailChanging) {
        const r = await client.query(
          `update doers set name = coalesce($2, name), department = $3
             where id = $1 returning *`,
          [id, name, department]
        );
        return { row: r.rows[0], prevEmail: cur.email };
      }

      // Verify the new email isn't already taken by another doer
      const clash = await client.query('select id from doers where email = $1 and id != $2', [newEmail, id]);
      if (clash.rowCount > 0) {
        return { error: 'A doer with that email already exists', code: 409 };
      }

      // 1. Insert new row with the new email (keeps FK valid for the next step)
      const ins = await client.query(
        `insert into doers (name, department, email) values ($1, $2, $3) returning *`,
        [name || cur.name, department !== undefined ? department : cur.department, newEmail]
      );

      // 2. Repoint every referencing row to the new email
      await client.query('update tasks set doer_email = $1 where doer_email = $2', [newEmail, cur.email]);
      await client.query('update master_checklist set doer_email = $1 where doer_email = $2', [newEmail, cur.email]);
      await client.query('update archive set doer_email = $1 where doer_email = $2', [newEmail, cur.email]);

      // 3. Delete the old doer row (FK refs are now all pointing to the new row)
      await client.query('delete from doers where id = $1', [id]);

      return { row: ins.rows[0], prevEmail: cur.email, emailChanged: true };
    });

    if (result.error) return res.status(result.code).json({ error: result.error, code: result.code });

    // Mirror to Supabase Auth. Failures here don't reverse the doer change
    // (the table is still consistent) but are logged + surfaced in response.
    let auth = null;
    try {
      if (result.emailChanged) {
        // Swap the auth account's email, then update metadata/password.
        await changeAuthEmail(result.prevEmail, result.row.email).catch(() => null);
      }
      auth = await upsertAuthUser({
        email: result.row.email,
        password: password || undefined,
        name: result.row.name,
        role,
      });
    } catch (authErr) {
      console.error('Auth update failed for', result.row.email, '-', authErr.message);
      auth = { error: authErr.message };
    }

    invalidateDoers();
    invalidateTasks();
    invalidateMaster();
    res.json({ ...result.row, auth });
  } catch (e) { next(e); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const refs = await query(
      'select count(*)::int as n from tasks t join doers d on d.email = t.doer_email where d.id = $1',
      [req.params.id]
    );
    if (refs.rows[0].n > 0) {
      return res.status(409).json({ error: `Doer has ${refs.rows[0].n} tasks; reassign or delete them first`, code: 409 });
    }
    const r = await query('delete from doers where id = $1 returning id, email', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Doer not found', code: 404 });
    // Also tear down the matching Supabase Auth account so they can't sign in.
    let auth = null;
    try { auth = await deleteAuthUser(r.rows[0].email); }
    catch (e) { console.error('Auth delete failed for', r.rows[0].email, '-', e.message); auth = { error: e.message }; }
    invalidateDoers();
    res.json({ deleted: r.rows[0].id, auth });
  } catch (e) { next(e); }
});

module.exports = router;
