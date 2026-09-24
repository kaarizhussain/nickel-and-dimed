import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeCsvHeader, mergeExtractedInvoices, splitInput } from '../src/ingest.js';

test('detects a CSV header without treating raw invoice text as one', () => {
  assert.equal(looksLikeCsvHeader('Date,Vendor,Item,Qty,Unit Price'), true);
  assert.equal(looksLikeCsvHeader('2025-01-02 Acme charged $25 for paper'), false);
});

test('headerless input never repeats its first invoice across batches', () => {
  const batches = splitInput(['invoice one', 'invoice two', 'invoice three'].join('\n'), 1);
  assert.deepEqual(batches, ['invoice one', 'invoice two', 'invoice three']);
});

test('CSV headers are carried into each batch', () => {
  const batches = splitInput('Date,Vendor,Amount\n1/1/25,Acme,10\n1/2/25,Acme,12', 1);
  assert.deepEqual(batches, [
    'Date,Vendor,Amount\n1/1/25,Acme,10',
    'Date,Vendor,Amount\n1/2/25,Acme,12',
  ]);
});

test('invoice fragments split across model chunks are merged back together', () => {
  const merged = mergeExtractedInvoices([
    {
      vendor_name: 'Acme Supply Co.', invoice_date: '2025-01-02', category: 'supplies',
      lines: [{ item: 'cups', qty: 2, unit_price: 5 }], amount: 0,
      confidence: 'high', source_line: 'row one',
    },
    {
      vendor_name: 'ACME Supply', invoice_date: '2025-01-02', category: 'supplies',
      lines: [{ item: 'napkins', qty: 1, unit_price: 4 }], amount: 0,
      confidence: 'medium', source_line: 'row two',
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].lines.length, 2);
  assert.equal(merged[0].confidence, 'medium');
  assert.equal(merged[0].source_line, 'row one\nrow two');
});
