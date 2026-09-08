// Ledger API. Node 20+ (built-in fetch, --env-file).
//   npm run api
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const anthropic = new Anthropic();
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Extraction is a trust boundary: this output goes straight into money columns,
// so the shape is validated before it reaches the database.
const Extraction = z.object({
  invoices: z.array(
    z.object({
      vendor_name: z.string(),
      amount: z.number(),
      invoice_date: z.string().describe('YYYY-MM-DD'),
      category: z.enum([
        'food and beverage', 'supplies', 'apparel', 'services', 'utilities', 'other',
      ]),
      line_items: z.array(z.string()).describe('empty array if the record has none'),
      confidence: z.enum(['low', 'medium', 'high']),
      source_line: z.string().describe('the exact input line this came from'),
    }),
  ),
});

// ponytail: fixed 40-line batches. Go token-aware (messages.count_tokens) if rows
// ever get long enough to blow the context window.
const CHUNK = 40;

async function extract(text, vendorNames) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0];
  const out = [];

  for (let i = 0; i < lines.length; i += CHUNK) {
    const body = lines.slice(i, i + CHUNK);
    // chunks after the first lose the CSV header, so carry it along
    const chunk = i === 0 ? body.join('\n') : [header, ...body].join('\n');

    const res = await anthropic.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 16000,
      // Mechanical, high-volume route -- low effort is plenty and keeps the bill down.
      output_config: { format: zodOutputFormat(Extraction), effort: 'low' },
      system: [
        'You normalize messy vendor spend records into structured invoices.',
        '',
        'Rules:',
        '- The first line may be a CSV header. If it is, do not emit an invoice for it.',
        '- Skip anything that is not an invoice: subtotals, notes, page numbers, blank rows.',
        '- amount is the invoice total in dollars as a number. No currency symbols, no commas.',
        '- invoice_date is YYYY-MM-DD. Resolve two-digit years to the 2000s.',
        '- confidence reflects how sure you are of amount and date specifically.',
        '- source_line must be copied verbatim from the input.',
        '',
        'vendor_name: match against the existing vendors below and reuse the exact',
        'spelling when it is the same business (abbreviations, legal suffixes, and',
        'typos all count as the same business). If it is genuinely new, use the',
        'cleanest form of the name as written.',
        '',
        'Existing vendors:',
        vendorNames.length ? vendorNames.map((n) => '- ' + n).join('\n') : '(none yet)',
      ].join('\n'),
      messages: [{ role: 'user', content: chunk }],
    });

    out.push(...(res.parsed_output?.invoices ?? []));
  }
  return out;
}

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
    });
    if (error) throw error;
    return { inserted: data };
  },

  'GET /api/dashboard': async () => {
    const [alerts, monthly] = await Promise.all([
      db.from('vendor_alerts').select('*'),
      db.from('vendor_monthly').select('*').order('month'),
    ]);
    if (alerts.error) throw alerts.error;
    if (monthly.error) throw monthly.error;
    return { alerts: alerts.data, monthly: monthly.data };
  },

  // Separate from /dashboard so the table paints immediately and the prose lands after.
  'GET /api/summary': async () => {
    const { data, error } = await db.from('vendor_alerts').select('*').limit(10);
    if (error) throw error;
    if (!data.length) return { summary: 'Nothing is over the 5% threshold yet.' };

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
  .listen(3001, () => console.log('ledger api on http://localhost:3001'));
