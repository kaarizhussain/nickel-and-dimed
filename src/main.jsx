import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const usd = (n) =>
  Number(n).toLocaleString('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  });

const monthLabel = (d) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

// Native SVG beats a chart library for twelve points on one line.
function Spark({ points }) {
  if (points.length < 2) return <span className="muted">&mdash;</span>;
  const hi = Math.max(...points);
  const lo = Math.min(...points);
  const span = hi - lo || 1;
  const coords = points
    .map((p, i) => `${(i / (points.length - 1)) * 100},${26 - ((p - lo) / span) * 22}`)
    .join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={coords} />
    </svg>
  );
}

function exportCsv(rows) {
  const cols = [
    'vendor_name', 'period_start', 'period_end', 'baseline_avg', 'current_avg',
    'pct_change', 'pct_change_yoy', 'annualized_impact',
  ];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  Object.assign(document.createElement('a'), { href: url, download: 'flagged-vendors.csv' }).click();
  URL.revokeObjectURL(url);
}

function App() {
  const [alerts, setAlerts] = useState([]);
  const [monthly, setMonthly] = useState([]);
  const [summary, setSummary] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    const d = await fetch('/api/dashboard').then((r) => r.json());
    setAlerts(d.alerts ?? []);
    setMonthly(d.monthly ?? []);
    fetch('/api/summary').then((r) => r.json()).then((r) => setSummary(r.summary ?? ''));
  };

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  // Extraction runs ~40 rows per Claude call, so a big export takes minutes. Sent
  // as one request it outruns the browser's timeout and shows nothing until it
  // either finishes or dies. Batching keeps every request short, reports progress,
  // and lets partial work survive a failure part-way through.
  const ingest = async (body) => {
    setBusy(true);
    setError('');
    setSummary('');

    const lines = body.trim().split(/\r?\n/).filter((l) => l.trim());
    const [header, ...rest] = lines;
    const batches = [];
    for (let i = 0; i < rest.length; i += 200) {
      batches.push([header, ...rest.slice(i, i + 200)].join('\n'));
    }
    if (!batches.length) batches.push(header ?? '');

    try {
      for (let i = 0; i < batches.length; i++) {
        if (batches.length > 1) setProgress(`Reading ${i + 1} of ${batches.length}...`);
        const r = await fetch('/api/ingest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: batches[i] }),
        }).then((res) => res.json());
        if (r.error) throw new Error(r.error);
        await load(); // results fill in as each batch lands
      }
      setText('');
    } catch (e) {
      setError(e.message);
    }
    setProgress('');
    setBusy(false);
  };

  // Total spend per month, across every vendor.
  const totals = Object.entries(
    monthly.reduce((acc, m) => {
      acc[m.month] = (acc[m.month] ?? 0) + Number(m.spend);
      return acc;
    }, {}),
  ).sort(([a], [b]) => a.localeCompare(b));
  const peak = Math.max(...totals.map(([, v]) => v), 1);

  const annualTotal = alerts.reduce((s, a) => s + Number(a.annualized_impact), 0);

  return (
    <main>
      <header>
        <h1>Nickel and Dimed</h1>
        <p className="muted">Vendor spend, and which vendors are quietly creeping up.</p>
      </header>

      <section className="panel">
        <textarea
          rows={5}
          value={text}
          placeholder="Paste a spend CSV or raw invoice text..."
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row">
          <button disabled={busy || !text.trim()} onClick={() => ingest(text)}>
            {busy ? progress || 'Reading...' : 'Ingest'}
          </button>
          <label className="file">
            Upload CSV
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              disabled={busy}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) await ingest(await f.text());
              }}
            />
          </label>
          {error && <span className="error">{error}</span>}
        </div>
      </section>

      {summary && <section className="summary">{summary}</section>}

      {totals.length > 0 && (
        <section className="panel">
          <h2>Total spend by month</h2>
          <div className="bars">
            {totals.map(([m, v]) => (
              <div key={m} className="bar" title={`${monthLabel(m)}: ${usd(v)}`}>
                <div className="track">
                  <div className="fill" style={{ height: `${(v / peak) * 100}%` }} />
                </div>
                <span>{monthLabel(m)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="row spread">
          <h2>
            Flagged vendors
            {alerts.length > 0 && (
              <span className="muted"> &middot; {usd(annualTotal)}/yr if nothing changes</span>
            )}
          </h2>
          <button className="ghost" disabled={!alerts.length} onClick={() => exportCsv(alerts)}>
            Export CSV
          </button>
        </div>

        {alerts.length === 0 ? (
          <p className="muted">Nothing over the 8% threshold. Ingest some records to start.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Vendor</th>
                <th className="num">Avg invoice</th>
                <th className="num">vs 3-mo</th>
                <th className="num">YoY</th>
                <th>Trend</th>
                <th className="num">Annual impact</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.vendor_id}>
                  <td className="muted">{a.impact_rank}</td>
                  <td>
                    <strong>{a.vendor_name}</strong>
                    <div className="muted small">since {monthLabel(a.period_start)}</div>
                  </td>
                  <td className="num">
                    {usd(a.current_avg)}
                    <div className="muted small">3-mo avg {usd(a.baseline_avg)}</div>
                  </td>
                  <td className="num up">+{Number(a.pct_change).toFixed(1)}%</td>
                  <td className="num">
                    {a.pct_change_yoy == null
                      ? <span className="muted">&mdash;</span>
                      : `${Number(a.pct_change_yoy) > 0 ? '+' : ''}${Number(a.pct_change_yoy).toFixed(1)}%`}
                  </td>
                  <td>
                    <Spark
                      points={monthly
                        .filter((m) => m.vendor_id === a.vendor_id)
                        .map((m) => Number(m.spend))}
                    />
                  </td>
                  <td className="num strong">{usd(a.annualized_impact)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
