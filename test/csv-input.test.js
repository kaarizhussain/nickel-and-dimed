import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { analyzeInvoices } from '../src/analysis.js';
import {
  detectColumns, mappingProblems, parseCsv, parseDate, parseMoney, toInvoices,
} from '../src/csv-input.js';
import snapshot from '../src/demo-snapshot.json' with { type: 'json' };

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const schemaSql = read('../schema.sql');
const load = (text) => {
  const parsed = parseCsv(text);
  return toInvoices(parsed, detectColumns(parsed.headers));
};

test('parses quoted fields, embedded delimiters, CRLF, and a BOM', () => {
  const p = parseCsv('﻿Date,Vendor,Note\r\n1/2/25,"Acme, Inc.","said ""hi"""\r\n');
  assert.deepEqual(p.headers, ['Date', 'Vendor', 'Note']);
  assert.deepEqual(p.rows[0].cells, ['1/2/25', 'Acme, Inc.', 'said "hi"']);
  assert.equal(p.rows[0].raw, '1/2/25,"Acme, Inc.","said ""hi"""');
});

test('detects semicolon and tab delimited exports', () => {
  assert.equal(parseCsv('Date;Vendor\n2025-01-01;Acme').rows[0].cells[1], 'Acme');
  assert.equal(parseCsv('Date\tVendor\n2025-01-01\tAcme').rows[0].cells[1], 'Acme');
});

test('maps headers by meaning, and exact names beat loose ones', () => {
  const m = detectColumns(['Txn Date', 'Supplier', 'Description', 'Quantity', 'Unit Cost', 'Amount']);
  assert.deepEqual(m, { date: 0, vendor: 1, item: 2, qty: 3, unit_price: 4, total: 5 });
  const n = detectColumns(['Date', 'Vendor', 'Item', 'Qty', 'Unit Price', 'Line Total']);
  assert.equal(n.unit_price, 4);
  assert.equal(n.total, 5);
  assert.deepEqual(mappingProblems(n), []);
  assert.equal(mappingProblems(detectColumns(['Vendor', 'Amount'])).length, 1);
});

test('reads money and dates the way exports write them', () => {
  assert.equal(parseMoney('"$1,234.50"'.replace(/"/g, '')), 1234.5);
  assert.equal(parseMoney('(12.00)'), -12);
  assert.equal(parseMoney(''), null);
  assert.ok(Number.isNaN(parseMoney('n/a')));
  assert.equal(parseDate('2025-02-06'), '2025-02-06');
  assert.equal(parseDate('1/22/25'), '2025-01-22');
  assert.equal(parseDate('02/20/2025'), '2025-02-20');
  assert.equal(parseDate('Jan 8, 2025'), '2025-01-08');
  assert.equal(parseDate('2/30/2025'), null, 'an impossible date is refused, not rolled over');
  assert.equal(parseDate('total'), null);
});

test('sample-input.csv: groups lines, keeps un-itemized vendors, and explains skips', () => {
  const { invoices, skipped } = load(read('../sample-input.csv'));
  // the subtotal row is refused with a reason, not dropped silently. Its own comma
  // splits it across columns, so what trips it is the date column.
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].raw, /subtotal/);
  assert.match(skipped[0].reason, /unreadable date/);
  // same vendor + same date = one invoice with two lines
  const jan8 = invoices.find((i) => i.invoice_date === '2025-01-08' && /acme/i.test(i.vendor_name));
  assert.equal(jan8.lines.length, 2);
  assert.equal(jan8.raw_input.split('\n').length, 2);
  // a vendor that only reports totals becomes an amount-only invoice
  const linen = invoices.filter((i) => /northside/i.test(i.vendor_name));
  assert.equal(linen.length, 3);
  assert.ok(linen.every((i) => i.lines === undefined && i.amount > 0));
});

test('derives unit price from a line total, and skips credits and junk with reasons', () => {
  const { invoices, skipped } = load([
    'Date,Supplier,Description,Quantity,Amount',
    '2025-03-01,Acme,paper,4,50.00',
    '2025-03-02,Acme,paper,-1,-12.50',
    'not a date,Acme,paper,1,12.50',
    '2025-03-03,Acme,paper,one,12.50',
  ].join('\n'));
  assert.equal(invoices[0].lines[0].unit_price, 12.5);
  assert.deepEqual(skipped.map((s) => s.line), [3, 4, 5]);
  assert.match(skipped[0].reason, /credit/);
  assert.match(skipped[1].reason, /date/);
  assert.match(skipped[2].reason, /not a number/);
});

test('uploading the seed file reproduces the public demo exactly', async () => {
  // The demo claims to be what the analysis produces. This is that claim, tested:
  // the seed CSV, read by the upload parser and analyzed by the in-browser engine,
  // must give the same findings the published snapshot shows.
  const { invoices } = load(read('../seed/popin-2023-2025.csv'));
  const result = await analyzeInvoices(invoices, schemaSql);
  assert.equal(result.inserted, 1193);
  assert.deepEqual(result.dashboard.alerts, snapshot.dashboard.alerts);
  assert.match(result.summary, /Tony's Pizza Co\. raised party pizza from \$34\.00 to \$37\.00, about \$1,263 a year/);
  // formatted like the card (50.055 -> $50.06), caveat attached to its own finding
  assert.match(result.summary, /whole bean 5lb from \$50\.06 to \$58\.43, about \$419 a year, though that rests on thin evidence/);
  assert.ok(!/Tony's[^.]*thin evidence/.test(result.summary), 'the caveat leaked onto a high-confidence finding');
});

test('a messy real-world export: finds the hidden increase and ignores the volume trap', async () => {
  // Semicolons, different header names, no unit-price column, one vendor spelled
  // two ways (with & and with "and"), a credit, and a subtotal. Found in the
  // browser: before norm() read & as "and", the two spellings split one price
  // series under the observation floor and this 12% rise was never flagged.
  const rows = ['Txn Date;Supplier;Description;Quantity;Amount'];
  for (let m = 1; m <= 10; m++) {
    const price = m <= 6 ? 40 : 44.8;
    for (const [day, name] of [[5, 'Bean & Leaf Coffee LLC'], [19, 'BEAN AND LEAF COFFEE']]) {
      const q = 2 + (m % 3);
      rows.push(`${m}/${day}/2025;${name};house blend 5lb;${q};"$${(price * q).toFixed(2)}"`);
    }
    for (const day of [8, 22]) { // order size climbs, unit price never moves
      const q = m + 2;
      rows.push(`2025-${String(m).padStart(2, '0')}-${day};Paper Plus;party plates;${q};${(12 * q).toFixed(2)}`);
    }
  }
  rows.push('3/9/2025;Paper Plus;party plates;-2;(24.00)', 'SUBTOTAL;;;;1234.00');

  const { invoices, skipped } = load(rows.join('\n'));
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /credit/);
  assert.match(skipped[1].reason, /no vendor/);

  const { dashboard } = await analyzeInvoices(invoices, schemaSql);
  assert.equal(new Set(dashboard.monthly.map((m) => m.vendor_id)).size, 2, '& and "and" must be one vendor');
  assert.equal(dashboard.alerts.length, 1);
  const [alert] = dashboard.alerts;
  assert.match(alert.vendor_name, /bean/i);
  assert.equal(alert.current_price, 44.8);
  assert.ok(!dashboard.alerts.some((a) => /paper/i.test(a.vendor_name)), 'bigger orders are not a price rise');
});

test('an upload with no increases says so instead of showing nothing', async () => {
  const { invoices } = load(read('../sample-input.csv'));
  const result = await analyzeInvoices(invoices, schemaSql);
  assert.ok(result.inserted > 0);
  assert.equal(typeof result.summary, 'string');
  assert.ok(result.summary.length > 0);
});
