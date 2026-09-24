// Loads seed/popin-2023-2025.csv straight into ingest_invoices(), skipping the
// Claude extraction step. The extraction path is exercised separately (and is
// what a real user hits); this exists so the demo database can be rebuilt in
// seconds for free instead of in 40 minutes for a dollar.
//
//   node --env-file=.env seed/load.mjs
import { createClient } from '@supabase/supabase-js';
import { seedInvoices } from './invoices.mjs';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const { rows, invoices: all } = seedInvoices();
console.log(`${rows} csv rows -> ${all.length} invoices`);

let total = 0;
for (let i = 0; i < all.length; i += 200) {
  const { data, error } = await db.rpc('ingest_invoices', { payload: all.slice(i, i + 200) });
  if (error) { console.error('batch failed:', error.message); process.exit(1); }
  total += data;
  process.stdout.write(`  ${total}/${all.length}\r`);
}
console.log(`\ninserted ${total} invoices`);
