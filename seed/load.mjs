// Loads seed/popin-2023-2025.csv straight into ingest_invoices(), skipping the
// Claude extraction step. The extraction path is exercised separately (and is
// what a real user hits); this exists so the demo database can be rebuilt in
// seconds for free instead of in 40 minutes for a dollar.
//
//   node --env-file=.env seed/load.mjs
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const num = (s) => Number(String(s).replace(/["$,]/g, ''));

// minimal CSV split that respects "quoted, fields"
const cells = (line) => line.match(/("[^"]*"|[^,]*)/g).filter((_, i) => i % 2 === 0);

const iso = (d) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const [mo, da, y] = d.split('/');
  const yyyy = y.length === 2 ? '20' + y : y;
  return `${yyyy}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
};

const rows = fs.readFileSync('seed/popin-2023-2025.csv', 'utf8').trim().split('\n').slice(1);

// rows sharing a vendor and a date are one invoice, same rule the extractor uses
const byInvoice = new Map();
for (const raw of rows) {
  const [date, vendor, item, qty, unit] = cells(raw);
  if (!vendor || !item || !qty) continue;          // the MONTH TOTAL junk rows
  const key = vendor + '|' + iso(date);
  if (!byInvoice.has(key)) {
    byInvoice.set(key, {
      vendor_name: vendor, invoice_date: iso(date), category: 'other',
      confidence: 'high', raw_input: raw, amount: 0, lines: [],
    });
  }
  byInvoice.get(key).lines.push({ item, qty: num(qty), unit_price: num(unit) });
}

const all = [...byInvoice.values()];
console.log(`${rows.length} csv rows -> ${all.length} invoices`);

let total = 0;
for (let i = 0; i < all.length; i += 200) {
  const { data, error } = await db.rpc('ingest_invoices', { payload: all.slice(i, i + 200) });
  if (error) { console.error('batch failed:', error.message); process.exit(1); }
  total += data;
  process.stdout.write(`  ${total}/${all.length}\r`);
}
console.log(`\ninserted ${total} invoices`);
