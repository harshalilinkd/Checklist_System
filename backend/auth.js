const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
}

const adminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function verifyToken(token) {
  if (!token) throw new Error('Missing token');

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new Error(error?.message || 'Invalid token');
  }

  const email = (data.user.email || '').toLowerCase();
  const metaRole = (data.user.user_metadata?.role || '').toLowerCase();
  const isAdmin = metaRole === 'admin' || adminEmails.includes(email);

  return { email, role: isAdmin ? 'admin' : 'user', isAdmin };
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  verifyToken(token)
    .then(user => { req.user = user; next(); })
    .catch(err => res.status(401).json({ error: err.message, code: 401 }));
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'Admin only', code: 403 });
  }
  next();
}

function isAdminEmail(email) {
  return adminEmails.includes((email || '').toLowerCase());
}

module.exports = { verifyToken, requireAuth, requireAdmin, isAdminEmail };
