import assert from 'node:assert/strict';
import test from 'node:test';

import { demoAlerts, demoDashboard, demoItems, demoMonthly, demoVendors } from '../src/demo-data.js';

test('demo dashboard contains a complete synthetic history', () => {
  assert.equal(demoDashboard.alerts, demoAlerts);
  assert.equal(demoItems.length, 6 * 36);
  assert.equal(demoMonthly.length, 6 * 36);
  assert.equal(new Set(demoMonthly.map((row) => row.vendor_id)).size, 6);
  assert.equal(new Set(demoMonthly.map((row) => row.month)).size, 36);
});

test('each finding opens evidence with matching invoices', () => {
  for (const alert of demoAlerts) {
    const detail = demoVendors[alert.vendor_id];
    assert.ok(detail, `missing vendor detail for ${alert.vendor_name}`);
    assert.ok(detail.flags.length > 0, `missing flags for ${alert.vendor_name}`);
    assert.ok(detail.invoices.length > 0, `missing invoices for ${alert.vendor_name}`);
    assert.ok(detail.invoices.every((invoice) => invoice.invoice_lines.length > 0));
  }
});

test('demo impact headline equals the vendor findings', () => {
  const total = demoAlerts.reduce((sum, alert) => sum + alert.vendor_total_impact, 0);
  assert.equal(total, 2190);
});
