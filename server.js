// Nickel and Dimed API. Node 20+ (built-in fetch, --env-file).
//   npm run api
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const anthropic = new Anthropic();
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Mirrors the check constraint on invoices.category. One list, so the schema, the
// correction endpoint and the database cannot drift apart.
const CATEGORIES = [
  'food and beverage', 'supplies', 'apparel', 'services', 'utilities', 'other',
];

// Extraction is a trust boundary: this output goes straight into money columns,
// so the shape is validated before it reaches the database.
//
// Line items are what make price detection possible at all. Without qty and
// unit_price there is no way to tell a vendor raising prices from a customer
// buying more, so the schema asks for them wherever the source has them.
const Extraction = z.object({
  invoices: z.array(
    z.object({
      vendor_name: z.string(),
      invoice_date: z.string().describe('YYYY-MM-DD'),
      category: z.enum(CATEGORIES),
      lines: z
        .array(
          z.object({
            item: z.string().describe('the product or service, without quantity or price'),
            qty: z.number().describe('number of units on this line; 1 if not stated'),
            unit_price: z.number().describe('price of ONE unit, never the line total'),
          }),
        )
        .describe('one entry per line item; empty array if the record is not itemized'),
      amount: z.number().describe('invoice total; used only when lines is empty'),
      confidence: z.enum(['low', 'medium', 'high']),
      source_line: z.string().describe('the exact input line(s) this came from'),
    }),
  ),
});

// ponytail: fixed 40-line batches. Go token-aware (messages.count_tokens) if rows
// ever get long enough to blow the context window.
const CHUNK = 40;

// A vendor with three years of history has hundreds of invoices; the drill-down
// shows the most recent slice and says so rather than shipping all of them.
const INVOICE_PAGE = 100;

async function extract(text, vendorNames) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0];
  const out = [];
  // Vendors named by earlier chunks have to be visible to later ones. Without
  // this, a first ingest into an empty database starts every chunk with an empty
  // vendor list, so each one picks its own spelling of the same business and
  // nothing ever reconciles them.
  const known = new Set(vendorNames);

  for (let i = 0; i < lines.length; i += CHUNK) {
    const body = lines.slice(i, i + CHUNK);
    // chunks after the first lose the CSV header, so carry it along
    const chunk = i === 0 ? body.join('\n') : [header, ...body].join('\n');

    const res = await anthropic.messages.parse({
      // Extraction is a mechanical parse against a fixed schema, run once per 40
      // rows -- the cheapest capable model, not the best one. Opus cost ~5x more
      // per call for the same validated output. The summary route below stays on
      // Opus, where the prose actually matters.
      model: 'claude-haiku-4-5',
      max_tokens: 16000,
      output_config: { format: zodOutputFormat(Extraction) },
      system: [
        'You normalize messy vendor spend records into structured invoices.',
        '',
        'Rules:',
        '- The first line may be a CSV header. If it is, do not emit an invoice for it.',
        '- Skip anything that is not an invoice: subtotals, notes, page numbers, blank rows.',
        '- invoice_date is YYYY-MM-DD. Resolve two-digit years to the 2000s.',
        '- confidence reflects how sure you are of the amounts and dates specifically.',
        '- source_line must be copied verbatim from the input.',
        '',
        'GROUPING: several input rows can belong to ONE invoice. Rows sharing the',
        'same vendor and the same date are one invoice with multiple lines. Emit one',
        'invoice object for them, not one per row.',
        '',
        'LINE ITEMS matter more than the total. unit_price is the price of a SINGLE',
        'unit -- if the source gives a line total and a quantity, divide. Never put a',
        'line total in unit_price. Strip quantity out of the item name, so "3 Cheese',
        'Pizza" is item "Cheese Pizza" with qty 3. Use the same wording for the same',
        'product across invoices so its price history stays comparable.',
        '',
        'If a record genuinely has no itemization, leave lines empty and set amount',
        'to the invoice total. Otherwise leave amount at 0 -- it is derived from the',
        'lines so the two can never disagree.',
        '',
        'vendor_name: match against the existing vendors below and reuse the exact',
        'spelling when it is the same business (abbreviations, legal suffixes, and',
        'typos all count as the same business). If it is genuinely new, use the',
        'cleanest form of the name as written.',
        '',
        'Existing vendors:',
        known.size ? [...known].map((n) => '- ' + n).join('\n') : '(none yet)',
      ].join('\n'),
      messages: [{ role: 'user', content: chunk }],
    });

    const got = res.parsed_output?.invoices ?? [];
    for (const inv of got) known.add(inv.vendor_name);
    out.push(...got);
  }
  return out;
}

// used for both invoice and line ids
const rowId = (req) => {
  const id = Number(new URL(req.url, 'http://localhost').searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) throw new Error('bad id');
  return id;
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 5_000_000) {
        req.destroy();
        reject(new Error('input too large; split the file'));
      }
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });

const routes = {
  'POST /api/ingest': async (req) => {
    const { text } = JSON.parse(await readBody(req));
    if (typeof text !== 'string' || !text.trim()) throw new Error('nothing to ingest');

    const { data: vendors, error: vErr } = await db.from('vendors').select('name');
    if (vErr) throw vErr;

    const invoices = await extract(text, (vendors ?? []).map((v) => v.name));
    if (!invoices.length) return { inserted: 0, note: 'no invoices found in that input' };

    const { data, error } = await db.rpc('ingest_invoices', {
      payload: invoices.map(({ source_line, ...i }) => ({ ...i, raw_input: source_line })),
      // lines ride along untouched; ingest_invoices derives each header total from
      // them, so a header can never disagree with its own detail
    });
    if (error) throw error;
    return { inserted: data };
  },

  'GET /api/dashboard': async () => {
    const [alerts, monthly, items] = await Promise.all([
      db.from('vendor_alerts').select('*'),
      db.from('vendor_monthly').select('*').order('month'),
      // per-item unit prices: what the chart plots, and the only series that can
      // answer the question the product asks
      db.from('item_monthly')
        .select('vendor_id, vendor_name, item_key, item, month, avg_unit_price, observations, basis')
        .order('month'),
    ]);
    for (const r of [alerts, monthly, items]) if (r.error) throw r.error;
    return { alerts: alerts.data, monthly: monthly.data, items: items.data };
  },

  // The evidence behind one vendor's number. The dashboard asserts that a vendor
  // cost you $947; this is how someone checks that claim -- every flag it ever
  // produced, and the invoices underneath with the exact source line each was
  // parsed from and how sure the model was.
  'GET /api/vendor': async (req) => {
    const id = Number(new URL(req.url, 'http://localhost').searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0) throw new Error('bad vendor id');

    const [vendor, monthly, flags, invoices, count] = await Promise.all([
      db.from('vendors').select('*').eq('id', id).maybeSingle(),
      db.from('vendor_monthly').select('*').eq('vendor_id', id).order('month'),
      db.from('price_flags').select('*').eq('vendor_id', id).order('period_end', { ascending: false }),
      db.from('invoices')
        .select('id, invoice_date, amount, category, confidence, corrected_at, raw_input, invoice_lines(id, item, qty, unit_price, line_total)')
        .eq('vendor_id', id).order('invoice_date', { ascending: false }).limit(INVOICE_PAGE),
      db.from('invoices').select('*', { count: 'exact', head: true }).eq('vendor_id', id),
    ]);
    for (const r of [vendor, monthly, flags, invoices, count]) if (r.error) throw r.error;
    if (!vendor.data) throw new Error('no such vendor');

    return {
      vendor: vendor.data,
      monthly: monthly.data,
      flags: flags.data,
      invoices: invoices.data,
      invoiceCount: count.count,
      shown: invoices.data.length,
    };
  },

  // Being able to SEE a bad extraction without being able to fix it is not much
  // use in a money tool. Detection recomputes for free afterwards, because
  // price_flags is a view over invoices rather than a stored table.
  'PATCH /api/invoice': async (req) => {
    const id = rowId(req);
    const body = JSON.parse(await readBody(req));

    // Deliberately not editable: raw_input, which is the record of what the model
    // was actually handed. Correcting a reading should never rewrite the evidence
    // it is being corrected against.
    const patch = {};
    if (body.amount != null) {
      // An invoice with lines derives its total from them -- that is the data
      // contract, and a database trigger enforces it. Accepting an amount edit here
      // would either be silently overwritten or leave the header disagreeing with
      // the detail that justifies it. Correct the lines instead.
      const { count, error: cErr } = await db
        .from('invoice_lines').select('*', { count: 'exact', head: true }).eq('invoice_id', id);
      if (cErr) throw cErr;
      if (count > 0) {
        throw new Error('this invoice is itemized -- correct its line items, not the total');
      }
      const n = Number(body.amount);
      if (!Number.isFinite(n) || n < 0) throw new Error('amount must be a number, and not negative');
      patch.amount = n;
    }
    if (body.invoice_date != null) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.invoice_date)) throw new Error('date must be YYYY-MM-DD');
      if (Number.isNaN(Date.parse(body.invoice_date))) throw new Error('not a real date');
      patch.invoice_date = body.invoice_date;
    }
    if (body.category != null) {
      if (!CATEGORIES.includes(body.category)) throw new Error('unknown category');
      patch.category = body.category;
    }
    if (!Object.keys(patch).length) throw new Error('nothing to change');
    patch.corrected_at = new Date().toISOString();

    const { data, error } = await db.from('invoices').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('no such invoice');
    return { invoice: data };
  },

  // Quantity and unit price ARE the analysis. Being able to correct an invoice's
  // date but not the two numbers every finding is computed from left the correction
  // workflow unable to fix the thing most worth fixing. The invoice total follows
  // automatically -- a trigger keeps it equal to the sum of its lines.
  'PATCH /api/line': async (req) => {
    const id = rowId(req);
    const body = JSON.parse(await readBody(req));

    const patch = {};
    if (body.item != null) {
      if (typeof body.item !== 'string' || !body.item.trim()) throw new Error('item cannot be empty');
      patch.item = body.item.trim();
    }
    if (body.qty != null) {
      const n = Number(body.qty);
      if (!Number.isFinite(n) || n <= 0) throw new Error('qty must be a positive number');
      patch.qty = n;
    }
    if (body.unit_price != null) {
      const n = Number(body.unit_price);
      if (!Number.isFinite(n) || n < 0) throw new Error('unit price must be a number, and not negative');
      patch.unit_price = n;
    }
    if (!Object.keys(patch).length) throw new Error('nothing to change');

    const { data: line, error } = await db
      .from('invoice_lines').update(patch).eq('id', id).select('invoice_id').maybeSingle();
    if (error) throw error;
    if (!line) throw new Error('no such line');

    // the correction belongs to the invoice, so the audit mark goes there
    const { error: mErr } = await db.from('invoices')
      .update({ corrected_at: new Date().toISOString() }).eq('id', line.invoice_id);
    if (mErr) throw mErr;
    return { corrected: id, invoice_id: line.invoice_id };
  },

  // For rows that are not a misreading but simply not an invoice.
  'DELETE /api/invoice': async (req) => {
    const id = rowId(req);
    const { data, error } = await db.from('invoices').delete().eq('id', id).select().maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('no such invoice');
    return { deleted: id };
  },

  // Separate from /dashboard so the table paints immediately and the prose lands after.
  'GET /api/summary': async () => {
    const { data, error } = await db.from('vendor_alerts').select('*').limit(10);
    if (error) throw error;
    if (!data.length) return { summary: 'Nothing is over the 8% threshold yet.' };

    const res = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1000,
      system:
        'You brief a small-business operator on vendor costs. Exactly three short ' +
        'sentences, plain English, dollars rounded to the nearest dollar. Name the ' +
        'vendors. No preamble, no bullet points, no markdown.',
      messages: [{
        role: 'user',
        content: 'Flagged vendors:\n' + JSON.stringify(data)
          + '\n\nWhat are the top three things worth acting on?',
      }],
    });
    return {
      summary: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    };
  },
};

http
  .createServer(async (req, res) => {
    const handler = routes[req.method + ' ' + req.url.split('?')[0]];
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!handler) return send(404, { error: 'not found' });
    try {
      send(200, await handler(req));
    } catch (e) {
      console.error(e);
      send(500, { error: e.message ?? String(e) });
    }
  })
  .listen(3001, () => console.log('nickel-and-dimed api on http://localhost:3001'));
