// Data for the public read-only demo. Every value comes from demo-snapshot.json,
// which scripts/snapshot-demo.mjs builds by running the real schema.sql against
// the real seed CSV -- nothing here is hand-written or modelled separately, so the
// demo cannot disagree with the analysis it presents.
import snapshot from './demo-snapshot.json' with { type: 'json' };

export const demoDashboard = snapshot.dashboard;
export const demoAlerts = snapshot.dashboard.alerts;
export const demoMonthly = snapshot.dashboard.monthly;
export const demoItems = snapshot.dashboard.items;
export const demoVendors = snapshot.vendors;

// The one hand-written piece: the live app asks Opus for this paragraph, and the
// public demo holds no API key. test/demo-data.test.js checks that every dollar
// figure in it appears in the snapshot's alerts.
export const demoSummary = {
  summary: "Tony's Pizza is the largest current increase at about $1,263 a year, followed by Party Time Balloons at roughly $508. Roast House Coffee adds about $419 a year, but its estimate rests on only two observations a month, so confirm the source invoices before renegotiating.",
};
