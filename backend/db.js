const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone gymnastics)
types.setTypeParser(1082, v => v);

// Supabase free tier has a 60-conn cap shared across services; keep the pool
// small so a Render free instance doesn't starve other connections.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: parseInt(process.env.PG_POOL_MAX || '5', 10),
});

const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const TODAY_SQL = `((now() at time zone '${APP_TZ}')::date)`;

async function query(text, params) {
  return pool.query(text, params);
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTx, APP_TZ, TODAY_SQL };
