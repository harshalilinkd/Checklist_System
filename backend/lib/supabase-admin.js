// Thin wrapper around supabase.auth.admin so the doers route can provision
// and update auth accounts when an admin adds/edits a doer.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.

const { createClient } = require('@supabase/supabase-js');

let _client = null;
function client() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return _client;
}

async function findUserByEmail(email) {
  const c = client();
  if (!c) return null;
  const lc = email.toLowerCase();
  // Admin API has no direct lookup by email — paginate listUsers.
  let page = 1;
  while (true) {
    const { data, error } = await c.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    const hit = data.users.find(u => (u.email || '').toLowerCase() === lc);
    if (hit) return hit;
    if (data.users.length < 1000) return null;
    page++;
  }
}

async function upsertAuthUser({ email, password, name, role }) {
  const c = client();
  if (!c) return { skipped: true, reason: 'SUPABASE_SERVICE_KEY not configured' };
  const existing = await findUserByEmail(email);
  const meta = { name, role: (role || 'user').toLowerCase() };
  if (!existing) {
    if (!password) throw new Error('Password required when creating a new auth user');
    const { data, error } = await c.auth.admin.createUser({
      email: email.toLowerCase(),
      password,
      user_metadata: meta,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    return { created: true, id: data.user.id };
  }
  const patch = { user_metadata: { ...(existing.user_metadata || {}), ...meta }, email_confirm: true };
  if (password) patch.password = password;
  const { error } = await c.auth.admin.updateUserById(existing.id, patch);
  if (error) throw new Error(error.message);
  return { updated: true, id: existing.id };
}

async function changeAuthEmail(oldEmail, newEmail) {
  const c = client();
  if (!c) return { skipped: true };
  const existing = await findUserByEmail(oldEmail);
  if (!existing) return { notFound: true };
  const { error } = await c.auth.admin.updateUserById(existing.id, {
    email: newEmail.toLowerCase(),
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  return { updated: true, id: existing.id };
}

async function deleteAuthUser(email) {
  const c = client();
  if (!c) return { skipped: true };
  const existing = await findUserByEmail(email);
  if (!existing) return { notFound: true };
  const { error } = await c.auth.admin.deleteUser(existing.id);
  if (error) throw new Error(error.message);
  return { deleted: true, id: existing.id };
}

module.exports = { upsertAuthUser, changeAuthEmail, deleteAuthUser, findUserByEmail };
