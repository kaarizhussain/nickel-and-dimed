import assert from 'node:assert/strict';
import test from 'node:test';

import {
  demoAlerts, demoDashboard, demoItems, demoMonthly, demoSummary, demoVendors,
} from '../src/demo-data.js';

// The demo's claim is that every number opens back to its evidence. These tests
// check the numbers agree with each other, not just that the data has the right
// shape -- a shape-only test passed while the drawer showed $78,696 of spend for
// a vendor the analysis puts at $46,763.

test('the headline is the sum of the findings, and matches the README', () => {
  const total = demoAlerts.reduce((sum, a) => sum + a.vendor_total_impact, 0);
  assert.equal(Math.round(total), 2190);
  assert.equal(demoAlerts.length, 3);
});

test('the data is the full seeded dataset the README describes', () => {
  // Internally consistent invented data would pass every agreement check below;
  // these counts only hold if the snapshot came from the real seed CSV.
  const vendors = Object.values(demoVendors);
  assert.equal(vendors.length, 6);
  assert.equal(vendors.reduce((n, v) => n + v.invoiceCount, 0), 1193);
});

test('each finding opens evidence that includes the flag it came from', () => {
  for (const alert of demoAlerts) {
    const detail = demoVendors[alert.vendor_id];
    assert.ok(detail, `no evidence for ${alert.vendor_name}`);
    assert.ok(
      detail.flags.some((f) => f.item_key === alert.item_key && f.period_end === alert.period_end),
      `${alert.vendor_name}'s drawer does not contain the flag on its card`,
    );
    assert.ok(detail.invoices.length > 0);
    assert.ok(detail.invoices.every((inv) => inv.invoice_lines.length > 0 && inv.raw_input));
  }
});

test('the drawer and the dashboard report the same spend for every vendor', () => {
  for (const [id, detail] of Object.entries(demoVendors)) {
    const fromDashboard = demoMonthly.filter((m) => m.vendor_id === Number(id));
    assert.deepEqual(detail.monthly, fromDashboard, `${detail.vendor.name} spend disagrees`);
  }
});

test("each finding's observation count matches the price series behind it", () => {
  for (const alert of demoAlerts) {
    const month = demoItems.find((r) =>
      r.vendor_id === alert.vendor_id && r.item_key === alert.item_key && r.month === alert.period_end);
    assert.ok(month, `no price series row for ${alert.vendor_name} ${alert.period_end}`);
    assert.equal(month.observations, alert.observations, `${alert.vendor_name} observations disagree`);
  }
});

test('the decor vendor whose bill grew 281% raises no alert', () => {
  assert.ok(!demoAlerts.some((a) => /decor/i.test(a.vendor_name)));
  assert.ok(demoMonthly.some((m) => /decor/i.test(m.vendor_name)), 'decor vendor missing from the data');
});

test('every dollar figure in the written summary appears in the findings', () => {
  const figures = [...demoSummary.summary.matchAll(/\$([\d,]+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  assert.ok(figures.length > 0);
  const impacts = demoAlerts.map((a) => Math.round(a.annualized_impact));
  for (const f of figures) assert.ok(impacts.includes(f), `summary cites $${f}, no finding says so`);
});

test('the dashboard object is the snapshot, not a separate copy', () => {
  assert.equal(demoDashboard.alerts, demoAlerts);
  assert.equal(demoDashboard.items, demoItems);
});
