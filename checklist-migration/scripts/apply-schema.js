require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', '001_schema.sql'),
    'utf8'
  );
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(sql);
    console.log('Schema applied.');
    const tables = await client.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`
    );
    console.log('Tables in public:');
    for (const r of tables.rows) console.log('  -', r.table_name);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
