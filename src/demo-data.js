const month = (index) => {
  const date = new Date(Date.UTC(2023, index, 1));
  return date.toISOString().slice(0, 10);
};

const vendors = [
  { id: 1, name: "Tony's Pizza Co.", key: 'tony pizza', category: 'food and beverage' },
  { id: 2, name: 'Party Time Balloons LLC', key: 'party time balloon', category: 'supplies' },
  { id: 3, name: 'Roast House Coffee Co.', key: 'roast house coffee', category: 'food and beverage' },
  { id: 4, name: 'Theme Party Decor Co.', key: 'theme party decor', category: 'supplies' },
  { id: 5, name: 'CleanCo Supply Inc.', key: 'cleanco supply', category: 'supplies' },
  { id: 6, name: 'Playworks Toys LLC', key: 'playwork toy', category: 'supplies' },
];

const itemDefs = [
  { vendor: 1, key: 'party pizza', item: 'party pizza', price: (m) => (m < 6 ? 31 : m < 14 ? 34 : 37), obs: 10 },
  { vendor: 2, key: 'balloon arch', item: 'balloon arch', price: (m) => (m < 9 ? 38 : m === 9 ? 44 : 47), obs: 9 },
  { vendor: 3, key: 'whole bean 5lb', item: 'whole bean 5lb', price: (m) => (m < 31 ? 46 + ((m % 4) - 1.5) * 0.35 : 58 + ((m % 3) - 1) * 0.7), obs: 2 },
  { vendor: 3, key: 'snack pack', item: 'snack pack', price: () => 12, obs: 2 },
  { vendor: 4, key: 'themed decor kit', item: 'themed decor kit', price: () => 32, obs: 10 },
  { vendor: 5, key: 'cleaning supplie', item: 'cleaning supplies', price: (m) => 50 + ((m % 5) - 2) * 0.45, obs: 2 },
];

export const demoItems = itemDefs.flatMap((def) => Array.from({ length: 36 }, (_, m) => ({
  vendor_id: def.vendor,
  vendor_name: vendors.find((vendor) => vendor.id === def.vendor).name,
  item_key: def.key,
  item: def.item,
  month: month(m),
  avg_unit_price: Number(def.price(m).toFixed(4)),
  observations: def.obs,
  basis: 'unit_price',
})));

export const demoMonthly = vendors.flatMap((vendor) => Array.from({ length: 36 }, (_, m) => {
  const base = [0, 2100, 1250, 1500, 720, 310, 180][vendor.id];
  const growth = vendor.id === 4 ? m * 38 : m * 5;
  const wobble = ((m * (vendor.id + 3)) % 7 - 3) * 18;
  return {
    vendor_id: vendor.id,
    vendor_name: vendor.name,
    month: month(m),
    spend: Math.max(50, base + growth + wobble),
    invoice_count: vendor.id <= 4 ? 10 : 2,
    avg_invoice: Math.max(25, (base + growth + wobble) / (vendor.id <= 4 ? 10 : 2)),
  };
}));

export const demoAlerts = [
  {
    vendor_id: 1, vendor_name: "Tony's Pizza Co.", item_key: 'party pizza', item: 'party pizza',
    basis: 'unit_price', kind: 'jump', period_start: '2023-12-01', period_end: '2024-03-01',
    baseline_price: 34, current_price: 37, pct_change: 8.8, pct_change_yoy: 19.4,
    annualized_impact: 1263, vendor_total_impact: 1263, active_item_count: 1,
    observations: 13, months_held: 22, trailing_12mo_qty: 421, confidence: 'high', impact_rank: 1,
  },
  {
    vendor_id: 2, vendor_name: 'Party Time Balloons LLC', item_key: 'balloon arch', item: 'balloon arch',
    basis: 'unit_price', kind: 'jump', period_start: '2023-09-01', period_end: '2023-12-01',
    baseline_price: 43, current_price: 47, pct_change: 9.3, pct_change_yoy: null,
    annualized_impact: 508, vendor_total_impact: 508, active_item_count: 1,
    observations: 10, months_held: 25, trailing_12mo_qty: 127, confidence: 'high', impact_rank: 2,
  },
  {
    vendor_id: 3, vendor_name: 'Roast House Coffee Co.', item_key: 'whole bean 5lb', item: 'whole bean 5lb',
    basis: 'unit_price', kind: 'jump', period_start: '2025-06-01', period_end: '2025-09-01',
    baseline_price: 50.06, current_price: 58.43, pct_change: 16.7, pct_change_yoy: 27,
    annualized_impact: 419, vendor_total_impact: 419, active_item_count: 1,
    observations: 2, months_held: 4, trailing_12mo_qty: 50, confidence: 'medium', impact_rank: 3,
  },
];

const historicalFlags = {
  1: [
    { period_end: '2024-03-01', pct_change: 8.8, baseline_price: 34, current_price: 37, annualized_impact: 1263 },
    { period_end: '2023-07-01', pct_change: 9.7, baseline_price: 31, current_price: 34, annualized_impact: 1188 },
  ],
  2: [{ period_end: '2023-12-01', pct_change: 9.3, baseline_price: 43, current_price: 47, annualized_impact: 508 }],
  3: [{ period_end: '2025-09-01', pct_change: 16.7, baseline_price: 50.06, current_price: 58.43, annualized_impact: 419 }],
};

const sampleInvoices = (vendor) => Array.from({ length: 6 }, (_, i) => {
  const alert = demoAlerts.find((candidate) => candidate.vendor_id === vendor.id);
  const date = new Date(Date.UTC(2025, 11, 20 - i * 3)).toISOString().slice(0, 10);
  const unitPrice = alert?.current_price ?? 32;
  const item = alert?.item ?? 'supplies';
  const qty = vendor.id === 1 ? 3 + (i % 2) : vendor.id === 2 ? 1 : 2;
  return {
    id: vendor.id * 100 + i,
    invoice_date: date,
    amount: qty * unitPrice,
    category: vendor.category,
    confidence: i === 4 ? 'medium' : 'high',
    corrected_at: null,
    raw_input: `${date},${vendor.name},${item},${qty},${Number(unitPrice).toFixed(2)}`,
    invoice_lines: [{
      id: vendor.id * 1000 + i,
      item,
      qty,
      unit_price: unitPrice,
      line_total: qty * unitPrice,
    }],
  };
});

export const demoVendors = Object.fromEntries(vendors.map((vendor) => {
  const invoices = sampleInvoices(vendor);
  return [vendor.id, {
    vendor: { id: vendor.id, name: vendor.name, normalized_name: vendor.key, category: vendor.category },
    monthly: demoMonthly.filter((row) => row.vendor_id === vendor.id),
    flags: historicalFlags[vendor.id] ?? [],
    invoices,
    invoiceCount: [0, 365, 365, 72, 365, 36, 12][vendor.id],
    shown: invoices.length,
  }];
}));

export const demoDashboard = {
  alerts: demoAlerts,
  monthly: demoMonthly,
  items: demoItems,
  mergeCandidates: [],
};

export const demoSummary = {
  summary: "Tony's Pizza is the largest current increase at about $1,263 a year, followed by Party Time Balloons at roughly $508. Roast House Coffee adds about $419 a year, but its estimate rests on only two observations a month, so confirm the source invoices before renegotiating.",
};
