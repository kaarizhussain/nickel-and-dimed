// Reads a spend CSV into ingest_invoices() payloads, with no model in the loop.
// Used by the in-browser "try your own data" path and by seed/invoices.mjs, so
// the demo dataset and a visitor's upload go through the same rules.
//
// It handles the structural mess -- quoted fields, $ and commas in numbers, three
// date formats, subtotal rows, headers named "Supplier" or "Unit Cost" -- but not
// semantic mess like free-text invoices. That is what the Claude extraction step
// in the full app is for, and it cannot run in a public browser without a key.

export const FIELDS = [
  { key: 'date', label: 'Date', required: true,
    synonyms: ['date', 'invoice date', 'bill date', 'transaction date', 'txn date', 'posted', 'posting date', 'document date'] },
  { key: 'vendor', label: 'Vendor', required: true,
    synonyms: ['vendor', 'vendor name', 'supplier', 'supplier name', 'payee', 'merchant', 'company', 'name'] },
  { key: 'item', label: 'Item',
    synonyms: ['item', 'item name', 'description', 'item description', 'product', 'product name', 'line item', 'product service', 'sku', 'memo'] },
  { key: 'qty', label: 'Quantity',
    synonyms: ['qty', 'quantity', 'units', 'unit count', 'count'] },
  { key: 'unit_price', label: 'Unit price',
    synonyms: ['unit price', 'price', 'unit cost', 'cost each', 'price each', 'rate', 'each'] },
  { key: 'total', label: 'Line total',
    synonyms: ['line total', 'total', 'amount', 'line amount', 'extended', 'extended price', 'ext price', 'debit', 'cost'] },
];

export const MAX_ROWS = 50000;

// RFC 4180-ish: quoted fields, "" escapes, delimiters and newlines inside quotes.
// Keeps each record's original text, which becomes raw_input -- the evidence a
// reader can check a parsed line against.
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = [',', ';', '\t']
    .map((d) => [d, firstLine.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];

  const records = [];
  let cells = [], cell = '', quoted = false, start = 0;
  const endRecord = (end) => {
    cells.push(cell);
    const raw = text.slice(start, end);
    if (cells.some((c) => c.trim() !== '')) records.push({ cells, raw });
    cells = []; cell = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { cells.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      endRecord(i);
      if (ch === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
    } else cell += ch;
  }
  if (cell !== '' || cells.length) endRecord(text.length);

  const [header, ...rows] = records;
  return { headers: header ? header.cells.map((h) => h.trim()) : [], rows };
}

const canon = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Header -> field, exact synonyms first so "Unit Price" is never taken by "price"'s
// looser match before it can be claimed exactly. Each column is used at most once.
export function detectColumns(headers) {
  const names = headers.map(canon);
  const mapping = Object.fromEntries(FIELDS.map((f) => [f.key, -1]));
  const taken = new Set();
  const claim = (test) => {
    for (const f of FIELDS) {
      if (mapping[f.key] !== -1) continue;
      for (const syn of f.synonyms) {
        const i = names.findIndex((n, idx) => !taken.has(idx) && test(n, syn));
        if (i !== -1) { mapping[f.key] = i; taken.add(i); break; }
      }
    }
  };
  claim((n, syn) => n === syn);
  claim((n, syn) => ` ${n} `.includes(` ${syn} `));
  return mapping;
}

// "$1,234.50" -> 1234.5, "(12.00)" -> -12, "" -> null, garbage -> NaN.
export function parseMoney(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (t === '') return null;
  const negative = /^\(.*\)$/.test(t) || /^-/.test(t);
  t = t.replace(/[()$€£\s,-]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? (negative ? -n : n) : NaN;
}

const pad = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

// ISO, US month/day/year (2- or 4-digit year), or "Jan 8, 2025". Day/month order is
// assumed US; a date that cannot exist either way comes back null, never guessed.
export function parseDate(s) {
  const t = String(s ?? '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const [mo, d] = [+m[1], +m[2]];
    return validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  if (/[a-z]/i.test(t)) {
    const dt = new Date(t);
    if (!Number.isNaN(dt.getTime())) return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  return null;
}

// Rows -> invoices. Rows sharing a vendor and a date are one invoice, the same rule
// the extraction prompt uses. A row with quantity and a price becomes a line item;
// a row with only a total becomes an un-itemized invoice, which the analysis still
// uses but labels as the weaker evidence it is. Anything else is skipped with a
// reason the page shows -- never silently dropped, never guessed at.
export function toInvoices(parsed, mapping) {
  const col = (row, key) => (mapping[key] >= 0 ? (row.cells[mapping[key]] ?? '').trim() : '');
  const skipped = [];
  const byInvoice = new Map();
  if (parsed.rows.length > MAX_ROWS) {
    throw new Error(`That file has ${parsed.rows.length.toLocaleString()} rows; the in-browser analysis handles up to ${MAX_ROWS.toLocaleString()}.`);
  }

  parsed.rows.forEach((row, i) => {
    const line = i + 2; // 1-based, after the header
    const skip = (reason) => skipped.push({ line, reason, raw: row.raw });
    const vendor = col(row, 'vendor');
    if (!vendor) return skip('no vendor (subtotal or blank row)');
    const date = parseDate(col(row, 'date'));
    if (!date) return skip(`unreadable date "${col(row, 'date')}"`);

    const item = col(row, 'item');
    const qty = parseMoney(col(row, 'qty'));
    let unit = parseMoney(col(row, 'unit_price'));
    const total = parseMoney(col(row, 'total'));
    if ([qty, unit, total].some(Number.isNaN)) return skip('a number column is not a number');
    if (unit == null && qty != null && total != null && qty > 0) unit = Math.round((total / qty) * 10000) / 10000;

    let lineItem = null, amount = null;
    if (qty != null && unit != null) {
      if (qty <= 0 || unit < 0) return skip('credit, return, or zero quantity');
      if (!item) return skip('priced line with no item name');
      lineItem = { item, qty, unit_price: unit };
    } else if (total != null) {
      if (total < 0) return skip('credit or return');
      amount = total;
    } else {
      return skip('no quantity, price, or total');
    }

    const key = vendor + '|' + date;
    if (!byInvoice.has(key)) {
      byInvoice.set(key, {
        vendor_name: vendor, invoice_date: date, category: 'other',
        confidence: 'high', raw_input: row.raw, amount: 0, lines: [],
      });
    }
    const inv = byInvoice.get(key);
    if (lineItem) inv.lines.push(lineItem);
    else inv.amount += amount;
    if (!inv.raw_input.split('\n').includes(row.raw)) inv.raw_input += `\n${row.raw}`;
  });

  const invoices = [...byInvoice.values()];
  for (const inv of invoices) {
    inv.amount = Math.round(inv.amount * 100) / 100;
    if (inv.lines.length === 0) delete inv.lines; // un-itemized: the amount is the evidence
  }
  return { invoices, skipped, rows: parsed.rows.length };
}

// Which required pieces are missing from a mapping, in words a person can act on.
export function mappingProblems(mapping) {
  const problems = [];
  if (mapping.date < 0) problems.push('Choose the column holding each invoice date.');
  if (mapping.vendor < 0) problems.push('Choose the column holding the vendor name.');
  const priced = mapping.qty >= 0 && (mapping.unit_price >= 0 || mapping.total >= 0);
  if (!priced && mapping.total < 0) {
    problems.push('Choose a quantity and a unit price (or line total) — or at least an amount column.');
  }
  return problems;
}
