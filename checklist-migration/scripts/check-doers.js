require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const total = await c.query('select count(*)::int as n from doers');
  console.log('Total doers in DB:', total.rows[0].n);
  const removed = [
    'chiranjeev.rajput@gmail.com','deepikamahale3@gmail.com','salescoordinator.linkd@gmail.com',
    'crm.linkd@gmail.com','sumantadeoatlinkdprints@gmail.com','pooja.deolinkd@gmail.com',
    'sharanniacrmlinkd@gmail.com','roshan.deolinkd@gmail.com','samidhadesigndeo.linkdprints@gmail.com','test@gmail.com'
  ];
  const r = await c.query('select email, name from doers where email = ANY($1)', [removed]);
  console.log(r.rowCount === 0 ? 'None of the 10 are present (DB is clean).' : 'Still present in DB:');
  for (const row of r.rows) console.log(' -', row.email, '·', row.name);
  await c.end();
})();
