import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { splitInput } from './ingest.js';
import { apiFetch, DEMO_MODE } from './api.js';

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

// One line per ITEM, plotting its UNIT PRICE indexed to its own early average.
//
// This chart used to plot avg(invoice total) -- the exact metric the detector was
// changed to stop trusting, because an invoice total moves with order size as
// readily as with price. Showing one thing and detecting on another would have let
// a reader draw a conclusion the engine explicitly refuses to draw.
//
// The y-axis reads "share of what you used to pay" and the shape is the whole
// point: flat means the price held, climbing means it did not.
const CH = { W: 760, H: 232, L: 38, R: 148, T: 18, B: 30 };

function buildSeries(items, alerts) {
  const months = [...new Set(items.map((m) => m.month))].sort();
  if (months.length < 2) return null;
  const xi = Object.fromEntries(months.map((m, i) => [m, i]));
  // flags are per vendor AND item, so the key has to be too
  const flaggedAt = Object.fromEntries(
    alerts.map((a) => [a.vendor_id + '|' + a.item_key, a.period_end]),
  );

  const byItem = {};
  for (const m of items) {
    // Same bar the detector uses: one observation in a month is not a monthly
    // price, it is a single observation. Plotting it draws a 25% swing where
    // nothing about pricing moved, contradicting the only claim this chart makes.
    if (Number(m.observations) < 2) continue;
    const key = m.vendor_id + '|' + m.item_key;
    (byItem[key] ??= { vendorId: m.vendor_id, vendor: m.vendor_name, item: m.item, pts: [] })
      .pts.push({ x: xi[m.month], month: m.month, avg: Number(m.avg_unit_price) });
  }

  const series = Object.entries(byItem)
    .filter(([, v]) => v.pts.length >= 6)
    .map(([key, v]) => {
      const pts = v.pts.slice().sort((a, b) => a.x - b.x);
      // Index against the first few months, not the first single one. A sparse item
      // can open on an unusually high observation, and dividing by that one point
      // turns ordinary variation into a fictitious 35% price drop -- which also
      // drags the shared y-axis and squashes the real increases.
      const head = pts.slice(0, Math.min(3, pts.length));
      const base = head.reduce((s, p) => s + p.avg, 0) / head.length;
      return {
        id: key,
        vendorId: v.vendorId,
        name: v.item,
        short: v.item.length > 18 ? v.item.slice(0, 17) + '…' : v.item,
        flagged: flaggedAt[key] != null,
        flaggedAt: flaggedAt[key] ? xi[flaggedAt[key]] : null,
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

function IndexChart({ items, alerts, colors }) {
  const [hover, setHover] = useState(null);   // month index under the cursor
  const [active, setActive] = useState(null); // vendor id being isolated

  const model = buildSeries(items, alerts);
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
        aria-label="Each item's unit price, indexed to its own early average"
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
                        style={{ stroke: colors[s.vendorId] ?? HELD }} />
              {/* fat transparent line so thin strokes are still easy to hit */}
              <polyline points={path(s.pts)} className="hit" />
              {/* the month the detector fired, marked on the line that caused it */}
              {s.flaggedAt != null && s.pts.some((p) => p.x === s.flaggedAt) && (
                <circle className="mark"
                        cx={px(s.flaggedAt)}
                        cy={py(s.pts.find((p) => p.x === s.flaggedAt).idx)} r="3.5"
                        style={{ stroke: colors[s.vendorId] ?? HELD }} />
              )}
              {hover != null && s.pts.some((p) => p.x === hover) && (
                <circle className="dot"
                        cx={px(hover)}
                        cy={py(s.pts.find((p) => p.x === hover).idx)} r="3"
                        style={{ fill: colors[s.vendorId] ?? HELD }} />
              )}
            </g>
          );
        })}

        {ends.map(({ s, y }) => (
          <text key={s.id} x={px(s.pts[s.pts.length - 1].x) + 9} y={y + 3.5}
                className={'lbl' + (active != null && active !== s.id ? ' dim' : '')}
                style={{ fill: colors[s.vendorId] ?? 'var(--muted)' }}>
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
              <span className="swatch" style={{ background: colors[s.vendorId] ?? HELD }} />
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
function InvoiceRow({ inv, onSaved, readOnly = false }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(inv.amount));
  const [date, setDate] = useState(inv.invoice_date);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const send = async (method, body) => {
    setBusy(true);
    setErr('');
    try {
      const r = await apiFetch(`/api/invoice?id=${inv.id}`, {
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

  const unchanged = inv.invoice_lines?.length
    ? date === inv.invoice_date
    : amount === String(inv.amount) && date === inv.invoice_date;

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

        {editing && !inv.invoice_lines?.length ? (
          <input className="edit amt" type="number" step="0.01" min="0" value={amount}
                 onChange={(e) => setAmount(e.target.value)} />
        ) : (
          // an itemized invoice derives its total from its lines -- correcting the
          // total directly would contradict the detail justifying it
          <span className="inv-amt">{usd(inv.amount)}</span>
        )}
      </div>

      {/* The line items are the actual price observations -- the invoice total is
          just their sum. This is what detection reads. */}
      {inv.invoice_lines?.length > 0 && (
        <div className="inv-lines">
          {inv.invoice_lines.map((l) => (
            <LineRow key={l.id} line={l} editing={editing} onSaved={onSaved} />
          ))}
        </div>
      )}

      {/* what the model was actually handed. Never editable -- correcting a reading
          must not rewrite the evidence it is being corrected against. */}
      {inv.raw_input && <div className="inv-raw">{inv.raw_input}</div>}

      {editing ? (
        <div className="inv-actions">
          <button disabled={busy || unchanged}
                  onClick={() => send('PATCH', inv.invoice_lines?.length
                    ? { invoice_date: date }
                    : { amount: Number(amount), invoice_date: date })}>
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
      ) : !readOnly ? (
        <button className="ghost tiny" onClick={() => setEditing(true)}>Correct</button>
      ) : null}
    </div>
  );
}

// Quantity and unit price ARE the analysis -- every finding is computed from them.
// Correcting an invoice's date but not these two numbers left the workflow unable to
// fix the thing most worth fixing. The invoice total follows automatically; a
// database trigger keeps it equal to the sum of its lines.
function LineRow({ line, editing, onSaved }) {
  const [qty, setQty] = useState(String(line.qty));
  const [price, setPrice] = useState(String(line.unit_price));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const unchanged = qty === String(line.qty) && price === String(line.unit_price);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await apiFetch('/api/line?id=' + line.id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ qty: Number(qty), unit_price: Number(price) }),
      }).then((res) => res.json());
      if (r.error) throw new Error(r.error);
      onSaved();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  if (!editing) {
    return (
      <div className="inv-line">
        <span>{line.item}</span>
        <span className="faint">{Number(line.qty)} &times; {money4(line.unit_price)}</span>
        <span className="num faint">{money4(line.line_total)}</span>
      </div>
    );
  }
  return (
    <div className="inv-line editing">
      <span>{line.item}</span>
      <span className="lineedit">
        <input className="edit qty" type="number" step="0.001" min="0.001" value={qty}
               onChange={(e) => setQty(e.target.value)} aria-label="quantity" />
        <span className="faint">&times;</span>
        <input className="edit price" type="number" step="0.0001" min="0" value={price}
               onChange={(e) => setPrice(e.target.value)} aria-label="unit price" />
      </span>
      <span className="num">
        <button className="tiny-save" disabled={busy || unchanged} onClick={save}>
          {busy ? '...' : 'Save'}
        </button>
      </span>
      {err && <span className="error small">{err}</span>}
    </div>
  );
}

function VendorDrawer({ id, color, onClose, onChanged, readOnly = false }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const reload = () =>
    apiFetch(`/api/vendor?id=${id}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : setData(d)))
      .catch((e) => setErr(e.message));

  useEffect(() => {
    let live = true;
    setData(null);
    setErr('');
    apiFetch(`/api/vendor?id=${id}`)
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
                  readOnly={readOnly}
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

function StoryIntro({ annualTotal }) {
  return (
    <section className="story-hero" aria-labelledby="story-title">
      <div className="story-copy">
        <div className="story-kicker">A purchasing problem hiding in plain sight</div>
        <h2 id="story-title">Your vendors rarely announce a price increase. They just invoice you.</h2>
        <p>
          Nickel &amp; Dimed turns years of messy invoice history into a ranked,
          evidence-backed answer: who raised prices, when it happened, and what it
          will cost if nothing changes.
        </p>
        <div className="story-actions">
          <a className="story-primary" href="#findings">Explore the {usd(annualTotal)} finding</a>
          <a className="story-secondary" href="#method">See how it avoids false alarms</a>
        </div>
        <div className="story-origin">
          Built from four years of negotiating vendor costs by hand at a play space and café.
        </div>
      </div>

      <div className="trap-preview" aria-label="An invoice total can rise even when its unit price does not">
        <div className="trap-label">The analytical trap</div>
        <div className="trap-row alarm-row">
          <div>
            <span>Monthly invoice total</span>
            <strong>$512 → $1,952</strong>
          </div>
          <span className="trap-change">+281%</span>
        </div>
        <div className="trap-divider"><span>but</span></div>
        <div className="trap-row safe-row">
          <div>
            <span>Price per decor kit</span>
            <strong>$32 → $32</strong>
          </div>
          <span className="trap-change">0%</span>
        </div>
        <p>More parties, not a price increase. The detector correctly raises no alert.</p>
      </div>
    </section>
  );
}

function StoryMethod() {
  return (
    <section className="story-section" id="method" aria-labelledby="method-title">
      <div className="story-section-head">
        <div className="story-kicker">The key product decision</div>
        <h2 id="method-title">Measure the price, not the bill.</h2>
        <p>
          Invoice totals move when a business buys more. This analysis follows the
          unit price of the same item from the same vendor, then prices a sustained
          increase against the quantity actually purchased over the last year.
        </p>
      </div>
      <div className="method-steps">
        <div className="method-step">
          <span>01</span>
          <strong>Normalize the mess</strong>
          <p>Claude structures inconsistent exports while preserving every source line.</p>
        </div>
        <div className="method-step">
          <span>02</span>
          <strong>Compare like with like</strong>
          <p>SQL tracks each item’s unit price against its own trailing baseline.</p>
        </div>
        <div className="method-step">
          <span>03</span>
          <strong>Separate jumps from drift</strong>
          <p>Two detectors catch both sudden repricing and a slow monthly ratchet.</p>
        </div>
        <div className="method-step">
          <span>04</span>
          <strong>Show the receipts</strong>
          <p>Every dollar estimate opens back to the observations and raw invoice text.</p>
        </div>
      </div>
    </section>
  );
}

function StoryProof() {
  return (
    <section className="proof" aria-labelledby="proof-title">
      <div className="proof-copy">
        <div className="story-kicker">Designed to be challenged</div>
        <h2 id="proof-title">A finding is only useful if someone can verify it.</h2>
        <p>
          The demo is a synthetic reconstruction, but the evidence chain is real:
          a claim, its confidence, the observations behind it, and the exact source
          text are kept together. Open any vendor above to follow that chain.
        </p>
        <a href="https://github.com/kaarizhussain/nickel-and-dimed" target="_blank" rel="noreferrer">
          Read the methodology, validation, and source code →
        </a>
      </div>
      <div className="proof-grid">
        <div><strong>1,193</strong><span>synthetic invoices</span></div>
        <div><strong>1,692</strong><span>line items</span></div>
        <div><strong>36</strong><span>months of history</span></div>
        <div><strong>3</strong><span>confidence signals shown</span></div>
      </div>
      <div className="proof-cases">
        <span>✓ Quantity growth does not trigger</span>
        <span>✓ Slow 2% monthly drift is caught</span>
        <span>✓ Corrections retract stale findings</span>
        <span>✓ Duplicate imports remain idempotent</span>
      </div>
    </section>
  );
}

function App() {
  const [alerts, setAlerts] = useState([]);
  const [monthly, setMonthly] = useState([]);
  const [items, setItems] = useState([]);
  const [mergeCandidates, setMergeCandidates] = useState([]);
  const [summary, setSummary] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [openVendor, setOpenVendor] = useState(null);
  const [showIngest, setShowIngest] = useState(false);

  const load = async (includeSummary = true) => {
    const d = await apiFetch('/api/dashboard').then((r) => r.json());
    if (d.error) throw new Error(d.error);
    setAlerts(d.alerts ?? []);
    setMonthly(d.monthly ?? []);
    setItems(d.items ?? []);
    setMergeCandidates(d.mergeCandidates ?? []);
    if (includeSummary) {
      apiFetch('/api/summary')
        .then((r) => r.json())
        .then((r) => (r.error ? setError(r.error) : setSummary(r.summary ?? '')))
        .catch((e) => setError(e.message));
    }
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

    const batches = splitInput(body, 200);

    try {
      for (let i = 0; i < batches.length; i++) {
        if (batches.length > 1) setProgress(`Reading ${i + 1} of ${batches.length}...`);
        const r = await apiFetch('/api/ingest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: batches[i] }),
        }).then((res) => res.json());
        if (r.error) throw new Error(r.error);
        await load(false); // results fill in without paying for prose on every batch
      }
      await load(true);
      setText('');
      setShowIngest(false);
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

  const annualTotal = alerts.reduce(
    (s, a) => s + Number(a.vendor_total_impact ?? a.annualized_impact),
    0,
  );
  const trackedVendors = new Set(monthly.map((m) => m.vendor_id)).size;
  const colors = colorMap(alerts);
  const lastMonth = totals.length ? totals[totals.length - 1][0] : null;

  const ingestPanel = (
    <>
      <textarea
        rows={6}
        value={text}
        placeholder="Paste a spend CSV or raw invoice text..."
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button disabled={busy || !text.trim()} onClick={() => ingest(text)}>
          {busy ? progress || 'Reading...' : 'Analyze invoices'}
        </button>
        <label className="file">
          or upload a CSV
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
    </>
  );

  return (
    <main>
      {/* Ingestion used to sit between the headline and the findings, interrupting
          the thing the page exists to show. It is an occasional action, so it lives
          behind a button. */}
      <header className="topbar">
        <div>
          <h1>Nickel &amp; Dimed</h1>
          <p>Vendor price intelligence</p>
        </div>
        <div className="topbar-right">
          {DEMO_MODE && <span className="demo-badge">Read-only demo · synthetic data</span>}
          {lastMonth && (
            <span className="faint small">
              through {monthLabel(lastMonth)} &middot; {totals.length} months
            </span>
          )}
          {!DEMO_MODE && <button onClick={() => setShowIngest(true)}>+ Add invoices</button>}
        </div>
      </header>

      {DEMO_MODE && alerts.length > 0 && <StoryIntro annualTotal={annualTotal} />}

      {alerts.length > 0 && (
        <section className="kpis">
          {/* the figure the whole product exists to produce */}
          <div className="kpi lead">
            <div className="kpi-num">{usd(annualTotal)}</div>
            <div className="kpi-label">a year, if these increases hold</div>
          </div>
          <div className="kpi">
            <div className="kpi-num">{alerts.length}</div>
            <div className="kpi-label">vendors raising prices</div>
          </div>
          <div className="kpi">
            <div className="kpi-num">{trackedVendors}</div>
            <div className="kpi-label">vendors monitored</div>
          </div>
          <div className="kpi">
            <div className="kpi-num">{totals.length}</div>
            <div className="kpi-label">months of history</div>
          </div>
        </section>
      )}

      {summary && (
        <section className="panel insight">
          <div className="eyebrow">What changed</div>
          <p className="insight-text">{summary}</p>
        </section>
      )}

      {DEMO_MODE && <StoryMethod />}

      {mergeCandidates.length > 0 && (
        <section className="panel insight">
          <div className="eyebrow">Vendor names to review</div>
          <div className="insight-text">
            {mergeCandidates.map((candidate) => (
              <p key={`${candidate.a_id}-${candidate.b_id}`}>
                <strong>{candidate.a_name}</strong> and <strong>{candidate.b_name}</strong>
                {' '}may be the same vendor — {candidate.why}, {candidate.shared_items} shared items.
              </p>
            ))}
          </div>
        </section>
      )}

      {items.length > 0 && (
        <section className="panel">
          <div className="chart-head">
            <div className="eyebrow">Unit price by item, indexed to its own first months</div>
            <div className="chart-max">100 = what you used to pay per unit</div>
          </div>
          <IndexChart items={items} alerts={alerts} colors={colors} />
        </section>
      )}

      <section id="findings">
        <div className="row spread section-head">
          <div className="eyebrow" style={{ marginBottom: 0 }}>Flagged vendors</div>
          <button className="ghost" disabled={!alerts.length} onClick={() => exportCsv(alerts)}>
            Export CSV
          </button>
        </div>

        {alerts.length === 0 ? (
          <div className="panel">
            <p className="empty">Nothing over the 8% threshold. Add some invoices to start.</p>
          </div>
        ) : (
          /* One card per finding rather than a spreadsheet row. Each answers, in
             order: who, what moved, by how much, what it costs, how much to trust
             it, and where the evidence is. */
          <div className="cards">
            {alerts.map((a) => (
              // A div with onClick is invisible to a keyboard: the page's whole
              // focus order was two buttons, so the primary action -- opening the
              // evidence behind a finding -- could not be reached without a mouse.
              <article
                key={a.vendor_id}
                className="card"
                role="button"
                tabIndex={0}
                aria-label={`${a.vendor_name}, ${a.item}, ${money4(a.baseline_price)} to ${money4(a.current_price)}, ${usd(a.annualized_impact)} per year. View evidence.`}
                onClick={() => setOpenVendor(a.vendor_id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenVendor(a.vendor_id); }
                }}
              >
                <span className="card-rail" style={{ background: colors[a.vendor_id] ?? HELD }} />

                <div className="card-main">
                  <div className="card-vendor">{a.vendor_name}</div>
                  <div className="card-item">
                    {a.item}
                    {Number(a.active_item_count) > 1 && (
                      <span className="basis" title={`${a.active_item_count} items from this vendor currently have active increases.`}>
                        worst of {a.active_item_count}
                      </span>
                    )}
                    {a.basis === 'invoice_average' && (
                      <span className="basis" title="This vendor does not itemize, so the comparison is invoice averages -- it cannot separate a price rise from a bigger order.">
                        invoice avg
                      </span>
                    )}
                  </div>
                  <div className="card-move">
                    <span className="was">{money4(a.baseline_price)}</span>
                    <span className="arrow">&rarr;</span>
                    <span className="now">{money4(a.current_price)}</span>
                    <span className={'delta' + (Number(a.pct_change) >= 10 ? ' high' : '')}>
                      +{Number(a.pct_change).toFixed(1)}%
                    </span>
                    <span className={'kind ' + a.kind}>
                      {a.kind === 'drift' ? 'drift · year over year' : 'jump'}
                    </span>
                  </div>
                  <div className="card-evidence">
                    <span className={'conf ' + a.confidence}>{a.confidence}</span>
                    <span className="faint small">
                      {a.observations} observations &middot; held {a.months_held} mo
                      {a.pct_change_yoy != null && <> &middot; {Number(a.pct_change_yoy) > 0 ? '+' : ''}{Number(a.pct_change_yoy).toFixed(1)}% YoY</>}
                    </span>
                  </div>
                </div>

                <div className="card-spark">
                  <span className="sr-only">
                    {a.observations} price observations, most recent {monthLabel(a.period_end)}
                  </span>
                  <Spark
                    points={items
                      .filter((m) => m.vendor_id === a.vendor_id && m.item_key === a.item_key)
                      .map((m) => Number(m.avg_unit_price))}
                    color={colors[a.vendor_id]}
                  />
                  <div className="faint small">since {monthLabel(a.period_end)}</div>
                </div>

                <div className="card-impact">
                  <div className="impact">{usd(a.annualized_impact)}</div>
                  <div className="faint small">
                    per year &middot; {Math.round(Number(a.trailing_12mo_qty)).toLocaleString()} units
                  </div>
                  <div className="card-link">View evidence &rarr;</div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {DEMO_MODE && <StoryProof />}

      {!DEMO_MODE && showIngest && (
        <>
          <div className="scrim" onClick={() => !busy && setShowIngest(false)} />
          <div className="modal" role="dialog" aria-label="Add invoices">
            <div className="drawer-head">
              <div>
                <div className="drawer-title">Add spending data</div>
                <div className="faint small">
                  A CSV export or pasted invoice text. Messy is fine.
                </div>
              </div>
              <button className="ghost close" disabled={busy}
                      onClick={() => setShowIngest(false)} aria-label="Close">✕</button>
            </div>
            <div className="modal-body">{ingestPanel}</div>
          </div>
        </>
      )}

      {openVendor != null && (
        <VendorDrawer
          id={openVendor}
          color={colors[openVendor]}
          readOnly={DEMO_MODE}
          onClose={() => setOpenVendor(null)}
          onChanged={load}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
