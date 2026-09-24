import { demoDashboard, demoSummary, demoVendors } from './demo-data.js';

export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

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
  if (url === '/api/dashboard') return response(demoDashboard);
  if (url === '/api/summary') return response(demoSummary);
  if (url.startsWith('/api/vendor')) {
    const id = Number(new URL(url, window.location.origin).searchParams.get('id'));
    return demoVendors[id]
      ? response(demoVendors[id])
      : response({ error: 'No such vendor.' }, 404);
  }
  return response({ error: 'Not found.' }, 404);
}
