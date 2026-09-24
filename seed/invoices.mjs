// Turns seed/popin-2023-2025.csv into ingest_invoices() payloads. Shared by
// seed/load.mjs (writes to Supabase) and scripts/snapshot-demo.mjs (builds the
// public demo). It parses with src/csv-input.js -- the same code a visitor's
// upload runs through -- so the demo's numbers are what an upload of this file
// would produce.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { detectColumns, parseCsv, toInvoices } from '../src/csv-input.js';

const CSV = new URL('./popin-2023-2025.csv', import.meta.url);

export function seedInvoices() {
  const parsed = parseCsv(fs.readFileSync(CSV, 'utf8').trim());
  const { invoices, rows } = toInvoices(parsed, detectColumns(parsed.headers));

  // Makes reloading the seed idempotent against a database that already has it.
  for (const invoice of invoices) {
    invoice.source_hash = createHash('sha256')
      .update(JSON.stringify([
        invoice.invoice_date,
        invoice.raw_input.replace(/\r\n/g, '\n').trim(),
      ]))
      .digest('hex');
  }
  return { rows, invoices };
}
