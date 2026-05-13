const express = require('express');
const { query } = require('../db');
const { invalidateDoers } = require('../cache');
const { requireAdmin } = require('../auth');

const router = express.Router();

router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { name, department, email } = req.body || {};
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email are required', code: 400 });
    }
    const r = await query(
      `insert into doers (name, department, email)
       values ($1, $2, $3)
       on conflict (email) do update
         set name = excluded.name, department = excluded.department
       returning *`,
      [name, department || null, email.toLowerCase()]
    );
    invalidateDoers();
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, department, email } = req.body || {};
    const r = await query(
      `update doers set
         name = coalesce($2, name),
         department = $3,
         email = coalesce($4, email)
       where id = $1
       returning *`,
      [req.params.id, name, department, email?.toLowerCase()]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Doer not found', code: 404 });
    invalidateDoers();
    res.json(r.rows[0]);
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
    const r = await query('delete from doers where id = $1 returning id', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Doer not found', code: 404 });
    invalidateDoers();
    res.json({ deleted: r.rows[0].id });
  } catch (e) { next(e); }
});

module.exports = router;
