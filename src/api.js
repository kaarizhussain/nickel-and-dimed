import { demoDashboard, demoSummary, demoVendors } from './demo-data.js';

export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

// A visitor's own data, analyzed in this tab by src/analysis.js. While set, the
// demo answers from it instead of the published snapshot. It lives only in memory:
// nothing is stored, and closing the tab discards it.
let local = null;
export const setLocalAnalysis = (analysis) => { local = analysis; };

const response = (body, status = 200) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(JSON.stringify(body)),
});

export function apiFetch(url, options = {}) {
  if (!DEMO_MODE) return fetch(url, options);

  const method = options.method ?? 'GET';
  if (method !== 'GET') {
    return response({ error: 'This public demo is read-only.' }, 403);
  }
  const dashboard = local?.dashboard ?? demoDashboard;
  const vendors = local?.vendors ?? demoVendors;
  if (url === '/api/dashboard') return response(dashboard);
  if (url === '/api/summary') return response(local ? { summary: local.summary } : demoSummary);
  if (url.startsWith('/api/vendor')) {
    const id = Number(new URL(url, window.location.origin).searchParams.get('id'));
    return vendors[id]
      ? response(vendors[id])
      : response({ error: 'No such vendor.' }, 404);
  }
  return response({ error: 'Not found.' }, 404);
}
