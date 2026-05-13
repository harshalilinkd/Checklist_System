const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone gymnastics)
types.setTypeParser(1082, v => v);

// Pool sizing:
//   - Local / Render (long-lived): default 5, shares Supabase's 60-conn cap.
//   - Vercel serverless: each cold start creates a new pool, so cap at 1
//     to avoid spawning hundreds of connections under load.
const defaultPoolMax = process.env.VERCEL ? 1 : 5;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: parseInt(process.env.PG_POOL_MAX || String(defaultPoolMax), 10),
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
