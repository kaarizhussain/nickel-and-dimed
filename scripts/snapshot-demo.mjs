// Builds src/demo-snapshot.json, the data behind the public read-only demo.
//
//   npm run snapshot:demo
//
// It runs the real schema.sql against the real seed CSV in an in-process
// Postgres (PGlite) via src/analysis.js -- the same code a visitor's upload runs
// in the browser. So every number on the public site is produced by the actual
// detection SQL, and is what uploading the seed file would show.
//
// No credentials, no network, no Supabase project to keep awake. Rerun it after
// any change to schema.sql or the seed data; test/demo-data.test.js fails if the
// snapshot and the headline numbers drift apart.
import fs from 'node:fs';
import { analyzeInvoices } from '../src/analysis.js';
import { seedInvoices } from '../seed/invoices.mjs';

const OUT = new URL('../src/demo-snapshot.json', import.meta.url);
const schemaSql = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

const { rows, invoices } = seedInvoices();
const { inserted, dashboard, vendors } = await analyzeInvoices(invoices, schemaSql);

fs.writeFileSync(OUT, JSON.stringify({
  generatedFrom: 'schema.sql + seed/popin-2023-2025.csv via scripts/snapshot-demo.mjs',
  dashboard,
  vendors,
}));

const total = dashboard.alerts.reduce((s, a) => s + Number(a.vendor_total_impact), 0);
console.log(`${rows} csv rows -> ${inserted} invoices, ${Object.keys(vendors).length} vendors`);
console.log(`${dashboard.alerts.length} alerts, $${total.toFixed(2)}/yr`);
console.log(`wrote ${OUT.pathname} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
