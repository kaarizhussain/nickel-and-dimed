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

// Total spend per month answers the wrong question -- a busy month looks the same
// as a price rise. This indexes every vendor to its own first month, so the y-axis
// is "share of what you used to pay" and the shape of each line is the whole point:
// flat means holding, climbing means costing you.
// Total spend per month answers the wrong question -- a busy month looks the same
// as a price rise. This indexes every vendor to its own early average, so the
// y-axis reads "share of what you used to pay" and the shape of each line is the
// whole point: flat means holding, climbing means costing you.
const CH = { W: 760, H: 232, L: 38, R: 148, T: 18, B: 30 };

function buildSeries(monthly, alerts) {
  const months = [...new Set(monthly.map((m) => m.month))].sort();
  if (months.length < 2) return null;
  const xi = Object.fromEntries(months.map((m, i) => [m, i]));
  const flaggedAt = Object.fromEntries(alerts.map((a) => [a.vendor_id, a.period_end]));

  const byVendor = {};
  for (const m of monthly) {
    // Same bar the detector uses: one invoice in a month is not a monthly price,
    // it is a single invoice. Plotting it draws a vendor swinging 25% when nothing
    // about its pricing moved, which contradicts the only claim this chart makes.
    if (Number(m.invoice_count) < 2) continue;
    (byVendor[m.vendor_id] ??= { name: m.vendor_name, pts: [] })
      .pts.push({ x: xi[m.month], month: m.month, avg: Number(m.avg_invoice) });
  }

  const series = Object.entries(byVendor)
    .filter(([, v]) => v.pts.length >= 6)
    .map(([id, v]) => {
      const pts = v.pts.slice().sort((a, b) => a.x - b.x);
      // Index against the first few months, not the first single one. A vendor that
      // bills quarterly can open on an unusually high invoice, and dividing by that
      // one point turns ordinary variation into a fictitious 35% price drop -- which
      // also drags the shared y-axis and squashes the real increases.
      const head = pts.slice(0, Math.min(3, pts.length));
      const base = head.reduce((s, p) => s + p.avg, 0) / head.length;
      return {
        id: Number(id),
        name: v.name,
        short: v.name.replace(/[,]?\s+(Co\.|LLC|Inc\.?|Corp\.?)$/i, ''),
        flagged: flaggedAt[id] != null,
        flaggedAt: flaggedAt[id] ? xi[flaggedAt[id]] : null,
        base,
        pts: pts.map((p) => ({ ...p, idx: (p.avg / base) * 100 })),
      };
    })
    // flagged drawn last so their lines sit above the ones that held
    .sort((a, b) => Number(a.flagged) - Number(b.flagged));

  if (!series.length) return null;
  const vals = series.flatMap((s) => s.pts.map((p) => p.idx));
  const lo = Math.min(95, Math.floor(Math.min(...vals) / 5) * 5);
  const hi = Math.max(115, Math.ceil(Math.max(...vals) / 5) * 5);
  return { months, series, lo, hi };
}

function IndexChart({ monthly, alerts }) {
  const [hover, setHover] = useState(null);   // month index under the cursor
  const [active, setActive] = useState(null); // vendor id being isolated

  const model = buildSeries(monthly, alerts);
  if (!model) return null;
  const { months, series, lo, hi } = model;
  const { W, H, L, R, T, B } = CH;

  const px = (x) => L + (x / (months.length - 1)) * (W - L - R);
  const py = (y) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B);
  const path = (pts) => pts.map((p) => `${px(p.x).toFixed(1)},${py(p.idx).toFixed(1)}`).join(' ');

  const step = hi - lo <= 30 ? 5 : 10;
  const yTicks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yTicks.push(v);
  const janIdx = months.map((m, i) => (m.slice(5, 7) === '01' ? i : -1)).filter((i) => i >= 0);

  // End labels overlap when lines converge, so nudge them apart vertically. Cheap
  // pass, but the alternative is two vendor names printed on top of each other.
  const ends = series
    .filter((s) => s.flagged)
    .map((s) => ({ s, y: py(s.pts[s.pts.length - 1].idx) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
  }

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    const frac = (vx - L) / (W - L - R);
    const i = Math.round(frac * (months.length - 1));
    setHover(i >= 0 && i < months.length ? i : null);
  };

  const readout = hover == null ? null : series
    .map((s) => ({ s, p: s.pts.find((p) => p.x === hover) }))
    .filter((r) => r.p)
    .sort((a, b) => b.p.idx - a.p.idx);

  return (
    <div className="chartwrap">
      <svg
        className={'idxchart' + (active != null ? ' isolating' : '')}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Each vendor's average invoice, indexed to its own early average"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={py(v)} y2={py(v)}
                  className={v === 100 ? 'grid base' : 'grid'} />
            <text x={L - 8} y={py(v) + 3.5} className="tick" textAnchor="end">{v}</text>
          </g>
        ))}
        {janIdx.map((i) => (
          <g key={i}>
            <line x1={px(i)} x2={px(i)} y1={T} y2={H - B} className="grid vert" />
            <text x={px(i)} y={H - 10} className="tick" textAnchor="middle">
              {months[i].slice(0, 4)}
            </text>
          </g>
        ))}

        {hover != null && (
          <line className="crosshair" x1={px(hover)} x2={px(hover)} y1={T} y2={H - B} />
        )}

        {series.map((s) => {
          const dim = active != null && active !== s.id;
          return (
            <g key={s.id} className={dim ? 'dim' : ''}
               onMouseEnter={() => setActive(s.id)}
               onMouseLeave={() => setActive(null)}>
              <polyline points={path(s.pts)} pathLength="1"
                        className={'line ' + (s.flagged ? 'up' : 'flat')} />
              {/* fat transparent line so thin strokes are still easy to hit */}
              <polyline points={path(s.pts)} className="hit" />
              {/* the month the detector fired, marked on the line that caused it */}
              {s.flaggedAt != null && s.pts.some((p) => p.x === s.flaggedAt) && (
                <circle className="mark"
                        cx={px(s.flaggedAt)}
                        cy={py(s.pts.find((p) => p.x === s.flaggedAt).idx)} r="3.5" />
              )}
              {hover != null && s.pts.some((p) => p.x === hover) && (
                <circle className={'dot ' + (s.flagged ? 'up' : 'flat')}
                        cx={px(hover)}
                        cy={py(s.pts.find((p) => p.x === hover).idx)} r="3" />
              )}
            </g>
          );
        })}

        {ends.map(({ s, y }) => (
          <text key={s.id} x={px(s.pts[s.pts.length - 1].x) + 9} y={y + 3.5}
                className={'lbl' + (active != null && active !== s.id ? ' dim' : '')}>
            {s.short}
          </text>
        ))}
      </svg>

      {readout && readout.length > 0 && (
        <div
          className="tip"
          style={
            px(hover) / W > 0.55
              ? { right: `${(1 - px(hover) / W) * 100 + 1.5}%` }
              : { left: `${(px(hover) / W) * 100 + 1.5}%` }
          }
        >
          <div className="tip-month">{monthLabel(months[hover])}</div>
          {readout.map(({ s, p }) => (
            <div key={s.id} className="tip-row">
              <span className={'swatch ' + (s.flagged ? 'up' : 'flat')} />
              <span className="tip-name">{s.short}</span>
              <span className="tip-idx">{p.idx.toFixed(0)}</span>
              <span className="tip-amt">{usd(p.avg)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
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

  const trackedVendors = new Set(monthly.map((m) => m.vendor_id)).size;

  return (
    <main>
      <div className="masthead">
        <h1>Nickel and Dimed</h1>
        <p>vendor spend, and who is quietly creeping up</p>
      </div>

      {alerts.length > 0 && (
        <section className="hero">
          <div className="hero-num">{usd(annualTotal)}</div>
          <div className="hero-label">
            a year, if these increases hold
          </div>
          <div className="hero-meta">
            <span>{alerts.length} of {trackedVendors} vendors raising prices</span>
            <span>{totals.length} months of history</span>
          </div>
        </section>
      )}

      {summary && <section className="summary">{summary}</section>}

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

      {monthly.length > 0 && (
        <section className="panel">
          <div className="chart-head">
            <div className="eyebrow">Average invoice, indexed to each vendor's first month</div>
            <div className="chart-max">100 = what you used to pay</div>
          </div>
          <IndexChart monthly={monthly} alerts={alerts} />
        </section>
      )}

      <section className="panel">
        <div className="row spread">
          <div className="eyebrow" style={{ marginBottom: 0 }}>Flagged vendors</div>
          <button className="ghost" disabled={!alerts.length} onClick={() => exportCsv(alerts)}>
            Export CSV
          </button>
        </div>

        {alerts.length === 0 ? (
          <p className="empty">Nothing over the 8% threshold. Ingest some records to start.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 24 }}></th>
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
                  <td className="rank">{a.impact_rank}</td>
                  <td>
                    <div className="vendor">{a.vendor_name}</div>
                    {/* period_end is the month the increase showed up. period_start is
                        the start of the baseline it is measured against, which is three
                        months earlier -- labelling that "since" reads as a much older
                        increase than actually happened. */}
                    <div className="faint small">since {monthLabel(a.period_end)}</div>
                  </td>
                  <td className="num">
                    {usd(a.current_avg)}
                    <div className="faint small">was {usd(a.baseline_avg)}</div>
                  </td>
                  <td className="num">
                    {/* severity readable before the digits are */}
                    <span className={'delta' + (Number(a.pct_change) >= 10 ? ' high' : '')}>
                      +{Number(a.pct_change).toFixed(1)}%
                    </span>
                  </td>
                  <td className="num">
                    {a.pct_change_yoy == null
                      ? <span className="faint">&mdash;</span>
                      : `${Number(a.pct_change_yoy) > 0 ? '+' : ''}${Number(a.pct_change_yoy).toFixed(1)}%`}
                  </td>
                  <td>
                    <Spark
                      points={monthly
                        .filter((m) => m.vendor_id === a.vendor_id)
                        .map((m) => Number(m.spend))}
                    />
                  </td>
                  <td className="num impact">{usd(a.annualized_impact)}</td>
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
