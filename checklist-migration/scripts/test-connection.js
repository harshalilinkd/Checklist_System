require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    const r = await client.query('select current_database() as db, current_user as usr, version() as ver');
    console.log('OK', r.rows[0]);
  } catch (e) {
    console.error('FAIL', e.code || '', e.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
