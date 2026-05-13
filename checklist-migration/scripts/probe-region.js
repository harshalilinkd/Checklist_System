const { Client } = require('pg');

const HOSTS = [
  'aws-1-ap-south-1.pooler.supabase.com',
  'aws-1-us-east-1.pooler.supabase.com',
  'aws-1-us-east-2.pooler.supabase.com',
  'aws-1-us-west-1.pooler.supabase.com',
  'aws-1-eu-west-1.pooler.supabase.com',
  'aws-1-eu-central-1.pooler.supabase.com',
  'aws-1-ap-southeast-1.pooler.supabase.com',
  'aws-1-ap-northeast-1.pooler.supabase.com',
  'aws-1-sa-east-1.pooler.supabase.com',
  'aws-1-ca-central-1.pooler.supabase.com',
];

const REF = 'hwawiudaevydbglzdync';
const PASS = 'LinkdPrints%4012345';

async function probe(host) {
  const url = `postgresql://postgres.${REF}:${PASS}@${host}:6543/postgres`;
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
    statement_timeout: 5000,
  });
  try {
    await client.connect();
    await client.query('select 1');
    return { host, ok: true };
  } catch (e) {
    return { host, ok: false, msg: (e.message || '').slice(0, 80) };
  } finally {
    await client.end().catch(() => {});
  }
}

(async () => {
  const results = await Promise.all(HOSTS.map(probe));
  for (const r of results) {
    console.log(r.ok ? `[OK] ${r.host}` : `[--] ${r.host}: ${r.msg}`);
  }
  const hit = results.find(r => r.ok);
  if (hit) console.log(`\n>>> Project host: ${hit.host}`);
})();
