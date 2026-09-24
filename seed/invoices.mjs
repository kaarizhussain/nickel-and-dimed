// Turns seed/popin-2023-2025.csv into ingest_invoices() payloads. Shared by
// seed/load.mjs (writes to Supabase) and scripts/snapshot-demo.mjs (builds the
// public demo), so both ingest exactly the same records by exactly the same rules.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const CSV = new URL('./popin-2023-2025.csv', import.meta.url);
const num = (s) => Number(String(s).replace(/["$,]/g, ''));

// minimal CSV split that respects "quoted, fields"
const cells = (line) => line.match(/("[^"]*"|[^,]*)/g).filter((_, i) => i % 2 === 0);

const iso = (d) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const [mo, da, y] = d.split('/');
  const yyyy = y.length === 2 ? '20' + y : y;
  return `${yyyy}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
};

export function seedInvoices() {
  const rows = fs.readFileSync(CSV, 'utf8').trim().split('\n').slice(1);

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
    if (!byInvoice.get(key).raw_input.split('\n').includes(raw)) {
      byInvoice.get(key).raw_input += `\n${raw}`;
    }
  }

  const invoices = [...byInvoice.values()];
  for (const invoice of invoices) {
    invoice.source_hash = createHash('sha256')
      .update(JSON.stringify([
        invoice.invoice_date,
        invoice.raw_input.replace(/\r\n/g, '\n').trim(),
      ]))
      .digest('hex');
  }
  return { rows: rows.length, invoices };
}
