// Builds src/demo-snapshot.json, the data behind the public read-only demo.
//
//   npm run snapshot:demo
//
// It runs the real schema.sql against the real seed CSV in an in-process
// Postgres (PGlite), then asks the same questions server.js asks. So every number
// on the public site is produced by the actual detection SQL -- the demo cannot
// show a finding, a spend figure, or an invoice the analysis would not.
//
// No credentials, no network, no Supabase project to keep awake. Rerun it after
// any change to schema.sql or the seed data; test/demo-data.test.js fails if the
// snapshot and the headline numbers drift apart.
import fs from 'node:fs';
import { PGlite, types } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { seedInvoices } from '../seed/invoices.mjs';

const OUT = new URL('../src/demo-snapshot.json', import.meta.url);
const INVOICE_PAGE = 100; // matches server.js

// Shape rows the way PostgREST (and so the live API) returns them.
const asString = (v) => v;
const db = new PGlite({
  extensions: { pg_trgm },
  parsers: {
    [types.NUMERIC]: Number,
    [types.INT8]: Number,
    [types.DATE]: asString,
    [types.TIMESTAMP]: asString,
    [types.TIMESTAMPTZ]: asString,
  },
});

const rows = async (sql, params) => (await db.query(sql, params)).rows;

// Supabase installs extensions into their own schema; schema.sql expects it.
await db.exec('create schema if not exists extensions');
await db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));

const { rows: csvRows, invoices } = seedInvoices();
let inserted = 0;
for (let i = 0; i < invoices.length; i += 200) {
  const [r] = await rows('select ingest_invoices($1::jsonb) as n',
    [JSON.stringify(invoices.slice(i, i + 200))]);
  inserted += r.n;
}

const dashboard = {
  alerts: await rows('select * from vendor_alerts'),
  monthly: await rows('select * from vendor_monthly order by month'),
  items: await rows(`select vendor_id, vendor_name, item_key, item, month,
                            avg_unit_price, observations, basis
                     from item_monthly order by month`),
  mergeCandidates: await rows('select * from vendor_merge_candidates'),
};

const vendors = {};
for (const vendor of await rows('select * from vendors order by id')) {
  const id = vendor.id;
  const invoiceRows = await rows(
    `select id, invoice_date, amount, category, confidence, corrected_at, raw_input
     from invoices where vendor_id = $1
     order by invoice_date desc, id desc limit $2`, [id, INVOICE_PAGE]);
  const lines = await rows(
    `select id, invoice_id, item, qty, unit_price, line_total from invoice_lines
     where invoice_id = any($1::bigint[]) order by id`, [invoiceRows.map((r) => r.id)]);
  const [{ n }] = await rows('select count(*) as n from invoices where vendor_id = $1', [id]);

  vendors[id] = {
    vendor,
    monthly: await rows('select * from vendor_monthly where vendor_id = $1 order by month', [id]),
    flags: await rows('select * from price_flags where vendor_id = $1 order by period_end desc', [id]),
    invoices: invoiceRows.map((inv) => ({
      ...inv,
      invoice_lines: lines.filter((l) => l.invoice_id === inv.id)
        .map(({ invoice_id, ...line }) => line),
    })),
    invoiceCount: n,
    shown: invoiceRows.length,
  };
}

fs.writeFileSync(OUT, JSON.stringify({
  generatedFrom: 'schema.sql + seed/popin-2023-2025.csv via scripts/snapshot-demo.mjs',
  dashboard,
  vendors,
}));

const total = dashboard.alerts.reduce((s, a) => s + Number(a.vendor_total_impact), 0);
console.log(`${csvRows} csv rows -> ${inserted} invoices, ${Object.keys(vendors).length} vendors`);
console.log(`${dashboard.alerts.length} alerts, $${total.toFixed(2)}/yr`);
console.log(`wrote ${OUT.pathname} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
