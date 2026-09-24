// Runs the real detection -- schema.sql, unchanged -- in an in-process Postgres
// (PGlite), and answers the questions server.js answers, in the same shapes.
//
// Two callers:
//   - scripts/snapshot-demo.mjs, in Node, to build the public demo's data
//   - the "try your own data" upload, in the browser, so a visitor's invoices
//     are analyzed on their own machine and never sent anywhere
//
// The schema's text is passed in because the two load it differently (fs in Node,
// a ?raw import in Vite).
import { PGlite, types } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

export const INVOICE_PAGE = 100; // matches server.js
const BATCH = 200;

// Shape rows the way PostgREST (and so the live API) returns them.
const asString = (v) => v;
const parsers = {
  [types.NUMERIC]: Number,
  [types.INT8]: Number,
  [types.DATE]: asString,
  [types.TIMESTAMP]: asString,
  [types.TIMESTAMPTZ]: asString,
};

export async function analyzeInvoices(invoices, schemaSql, { onProgress = () => {} } = {}) {
  const db = await PGlite.create({ extensions: { pg_trgm }, parsers });
  const rows = async (sql, params) => (await db.query(sql, params)).rows;

  try {
    onProgress('Setting up the analysis');
    // Supabase installs extensions into their own schema; schema.sql expects it.
    await db.exec('create schema if not exists extensions');
    await db.exec(schemaSql);

    let inserted = 0;
    for (let i = 0; i < invoices.length; i += BATCH) {
      onProgress(`Reading invoices ${Math.min(i + BATCH, invoices.length).toLocaleString()} of ${invoices.length.toLocaleString()}`);
      const [r] = await rows('select ingest_invoices($1::jsonb) as n',
        [JSON.stringify(invoices.slice(i, i + BATCH))]);
      inserted += r.n;
    }

    onProgress('Looking for price increases');
    const dashboard = {
      alerts: await rows('select * from vendor_alerts'),
      monthly: await rows('select * from vendor_monthly order by month'),
      items: await rows(`select vendor_id, vendor_name, item_key, item, month,
                                avg_unit_price, observations, basis
                         from item_monthly order by month`),
      mergeCandidates: await rows('select * from vendor_merge_candidates'),
    };

    const vendors = {};
    for (const vendor of await rows('select id, name, normalized_name, category from vendors order by id')) {
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

    return { inserted, dashboard, vendors, summary: summarize(dashboard.alerts) };
  } finally {
    await db.close();
  }
}

// Same formatters as the cards (main.jsx usd/money4). A baseline of 50.055 is
// "$50.05" by toFixed and "$50.06" by Intl, and the summary must not disagree
// with the card beneath it.
const usd = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const price = (n) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// The live app asks Opus for this paragraph; a public browser has no key, so an
// upload gets a plain sentence per finding, built only from the finding's own row.
export function summarize(alerts) {
  if (!alerts.length) {
    return 'No unit price in this data rose more than 8% above its own recent level. '
      + 'That is good news if the history is long enough — detection needs a few months '
      + 'per item, with at least two invoices in a month.';
  }
  return alerts.slice(0, 3).map((a, i) => {
    // the caveat belongs inside its own finding's sentence, or it reads as if it
    // covered every finding before it
    const caution = a.basis === 'invoice_average'
      ? ', though that vendor does not itemize, so check whether you simply ordered more'
      : a.confidence !== 'high' ? ', though that rests on thin evidence, so check the invoices first' : '';
    return `${a.vendor_name} ${a.kind === 'drift' ? 'has crept' : 'raised'} ${a.item} from `
      + `${price(a.baseline_price)} to ${price(a.current_price)}, about ${usd(a.annualized_impact)} a year`
      + `${i === 0 ? ' at your current volume' : ''}${caution}.`;
  }).join(' ');
}
