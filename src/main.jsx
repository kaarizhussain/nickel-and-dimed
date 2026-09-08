import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const usd = (n) =>
  Number(n).toLocaleString('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  });

// Unit prices live in cents -- $6.50 vs $7.00 is a 7.7% rise that usd() would
// render as "$7 was $7".
const money4 = (n) =>
  Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const monthLabel = (d) =>
  new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

// Hue carries identity, not severity -- grey vs coloured already says whether a
// vendor is rising, so painting all the risers the same red left three identical
// lines and three identical tooltip swatches. Spread in hue rather than by
// lightness so red/green colour blindness does not collapse any pair.
const FLAG_COLORS = ['#b91c1c', '#7c3aed', '#0369a1', '#b45309', '#0f766e', '#be185d'];
const HELD = '#d4d4d8';

// Keyed off rank so the worst offender is always the first colour, and so a
// vendor keeps its colour between the chart and its row in the table.
const colorMap = (alerts) =>
  Object.fromEntries(
    alerts
      .slice()
      .sort((a, b) => a.impact_rank - b.impact_rank)
      .map((a, i) => [a.vendor_id, FLAG_COLORS[i % FLAG_COLORS.length]]),
  );

// Native SVG beats a chart library for twelve points on one line.
function Spark({ points, color }) {
  if (points.length < 2) return <span className="muted">&mdash;</span>;
  const hi = Math.max(...points);
  const lo = Math.min(...points);
  const span = hi - lo || 1;
  const coords = points
    .map((p, i) => `${(i / (points.length - 1)) * 100},${26 - ((p - lo) / span) * 22}`)
    .join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={coords} style={{ stroke: color }} />
    </svg>
  );
}

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

function IndexChart({ monthly, alerts, colors }) {
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
                        className={'line ' + (s.flagged ? 'up' : 'flat')}
                        style={{ stroke: colors[s.id] ?? HELD }} />
              {/* fat transparent line so thin strokes are still easy to hit */}
              <polyline points={path(s.pts)} className="hit" />
              {/* the month the detector fired, marked on the line that caused it */}
              {s.flaggedAt != null && s.pts.some((p) => p.x === s.flaggedAt) && (
                <circle className="mark"
                        cx={px(s.flaggedAt)}
                        cy={py(s.pts.find((p) => p.x === s.flaggedAt).idx)} r="3.5"
                        style={{ stroke: colors[s.id] ?? HELD }} />
              )}
              {hover != null && s.pts.some((p) => p.x === hover) && (
                <circle className="dot"
                        cx={px(hover)}
                        cy={py(s.pts.find((p) => p.x === hover).idx)} r="3"
                        style={{ fill: colors[s.id] ?? HELD }} />
              )}
            </g>
          );
        })}

        {ends.map(({ s, y }) => (
          <text key={s.id} x={px(s.pts[s.pts.length - 1].x) + 9} y={y + 3.5}
                className={'lbl' + (active != null && active !== s.id ? ' dim' : '')}
                style={{ fill: colors[s.id] ?? 'var(--muted)' }}>
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
              <span className="swatch" style={{ background: colors[s.id] ?? HELD }} />
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

// The dashboard asserts a number. This is where someone checks it: every flag the
// vendor produced, and the invoices underneath with the exact text each was parsed
// from. In a tool where a model read the source documents, provenance is not a
// nice-to-have -- it is the difference between a claim and evidence.
// One invoice, correctable in place. A reading you can see but not fix is not much
// use in a money tool -- and because price_flags is a view rather than a stored
// table, fixing one row recomputes the vendor's flags with no extra machinery.
function InvoiceRow({ inv, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(inv.amount));
  const [date, setDate] = useState(inv.invoice_date);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const send = async (method, body) => {
    setBusy(true);
    setErr('');
    try {
      const r = await fetch(`/api/invoice?id=${inv.id}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const unchanged = amount === String(inv.amount) && date === inv.invoice_date;

  return (
    <div className={'inv' + (editing ? ' editing' : '')}>
      <div className="inv-top">
        {editing ? (
          <input className="edit date" type="date" value={date}
                 onChange={(e) => setDate(e.target.value)} />
        ) : (
          <span className="inv-date">{inv.invoice_date}</span>
        )}

        {inv.corrected_at ? (
          <span className="conf corrected" title={`Corrected ${new Date(inv.corrected_at).toLocaleString()}`}>
            corrected
          </span>
        ) : (
          <span className={'conf ' + inv.confidence}>{inv.confidence}</span>
        )}

        {editing ? (
          <input className="edit amt" type="number" step="0.01" min="0" value={amount}
                 onChange={(e) => setAmount(e.target.value)} />
        ) : (
          <span className="inv-amt">{usd(inv.amount)}</span>
        )}
      </div>

      {/* The line items are the actual price observations -- the invoice total is
          just their sum. This is what detection reads. */}
      {inv.invoice_lines?.length > 0 && (
        <div className="inv-lines">
          {inv.invoice_lines.map((l, i) => (
            <div key={i} className="inv-line">
              <span>{l.item}</span>
              <span className="faint">{Number(l.qty)} &times; {money4(l.unit_price)}</span>
              <span className="num faint">{money4(l.line_total)}</span>
            </div>
          ))}
        </div>
      )}

      {/* what the model was actually handed. Never editable -- correcting a reading
          must not rewrite the evidence it is being corrected against. */}
      {inv.raw_input && <div className="inv-raw">{inv.raw_input}</div>}

      {editing ? (
        <div className="inv-actions">
          <button disabled={busy || unchanged}
                  onClick={() => send('PATCH', { amount: Number(amount), invoice_date: date })}>
            {busy ? 'Saving...' : 'Save'}
          </button>
          <button className="ghost" disabled={busy} onClick={() => { setEditing(false); setErr(''); }}>
            Cancel
          </button>
          <button className="ghost danger" disabled={busy}
                  onClick={() => send('DELETE')}>
            Not an invoice
          </button>
          {err && <span className="error small">{err}</span>}
        </div>
      ) : (
        <button className="ghost tiny" onClick={() => setEditing(true)}>Correct</button>
      )}
    </div>
  );
}

function VendorDrawer({ id, color, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const reload = () =>
    fetch(`/api/vendor?id=${id}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : setData(d)))
      .catch((e) => setErr(e.message));

  useEffect(() => {
    let live = true;
    setData(null);
    setErr('');
    fetch(`/api/vendor?id=${id}`)
      .then((r) => r.json())
      .then((d) => live && (d.error ? setErr(d.error) : setData(d)))
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [id]);

  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const totalSpend = data?.monthly?.reduce((s, m) => s + Number(m.spend), 0) ?? 0;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Vendor detail">
        <div className="drawer-head">
          <div>
            <div className="drawer-title">
              <span className="swatch" style={{ background: color ?? HELD }} />
              {data ? data.vendor.name : 'Loading...'}
            </div>
            {data && (
              <div className="faint small">
                matched as “{data.vendor.normalized_name}”
                {data.vendor.category ? ` · ${data.vendor.category}` : ''}
              </div>
            )}
          </div>
          <button className="ghost close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {err && <p className="error">{err}</p>}

        {data && (
          <div className="drawer-body">
            <div className="statrow">
              <div><div className="stat">{data.invoiceCount}</div><div className="faint small">invoices</div></div>
              <div><div className="stat">{usd(totalSpend)}</div><div className="faint small">total spend</div></div>
              <div>
                <div className="stat">{data.monthly.length}</div>
                <div className="faint small">months active</div>
              </div>
            </div>

            <div className="eyebrow">
              Price flags{data.flags.length ? ` (${data.flags.length})` : ''}
            </div>
            {data.flags.length === 0 ? (
              <p className="empty small">Never crossed the threshold. This vendor held its prices.</p>
            ) : (
              <table className="mini">
                <tbody>
                  {data.flags.map((f) => (
                    <tr key={f.period_end}>
                      <td>{monthLabel(f.period_end)}</td>
                      <td className="num">
                        <span className={'delta' + (Number(f.pct_change) >= 10 ? ' high' : '')}>
                          +{Number(f.pct_change).toFixed(1)}%
                        </span>
                      </td>
                      <td className="num faint">
                        {usd(f.baseline_price)} → {usd(f.current_price)}
                      </td>
                      <td className="num strong">{usd(f.annualized_impact)}/yr</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="eyebrow" style={{ marginTop: 26 }}>
              Invoices
              {data.invoiceCount > data.shown && (
                <span className="faint"> — most recent {data.shown} of {data.invoiceCount}</span>
              )}
            </div>
            <div className="invoices">
              {data.invoices.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  inv={inv}
                  onSaved={() => { reload(); onChanged?.(); }}
                />
              ))}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

function exportCsv(rows) {
  const cols = [
    'vendor_name', 'period_start', 'period_end', 'baseline_price', 'current_price',
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
  const [openVendor, setOpenVendor] = useState(null);

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
  const colors = colorMap(alerts);

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
          <IndexChart monthly={monthly} alerts={alerts} colors={colors} />
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
                <th className="num">Unit price</th>
                <th className="num">vs 3-mo</th>
                <th className="num">YoY</th>
                <th>Trend</th>
                <th className="num">Annual impact</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.vendor_id} className="clickable"
                    onClick={() => setOpenVendor(a.vendor_id)}
                    title="See the invoices behind this number">
                  <td className="rank">{a.impact_rank}</td>
                  <td>
                    <div className="vendor">{a.vendor_name}</div>
                    <div className="item-line">
                      {a.item}
                      {a.basis === 'invoice_average' && (
                        <span className="basis" title="This vendor does not itemize, so the comparison is invoice averages -- it cannot separate a price rise from a bigger order.">
                          invoice avg
                        </span>
                      )}
                    </div>
                    {/* period_end is the month the increase showed up. period_start is
                        the start of the baseline it is measured against, which is three
                        months earlier -- labelling that "since" reads as a much older
                        increase than actually happened. */}
                    <div className="faint small">since {monthLabel(a.period_end)}</div>
                  </td>
                  <td className="num">
                    {money4(a.current_price)}
                    <div className="faint small">was {money4(a.baseline_price)}</div>
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
                      color={colors[a.vendor_id]}
                    />
                  </td>
                  <td className="num">
                    <div className="impact">{usd(a.annualized_impact)}</div>
                    <div className="faint small">
                      {Math.round(Number(a.trailing_12mo_qty)).toLocaleString()} units/yr
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {openVendor != null && (
        <VendorDrawer
          id={openVendor}
          color={colors[openVendor]}
          onClose={() => setOpenVendor(null)}
          onChanged={load}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
