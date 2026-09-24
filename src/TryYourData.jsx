import { useState } from 'react';
import sampleUrl from '../seed/popin-2023-2025.csv?url';
import {
  FIELDS, detectColumns, mappingProblems, parseCsv, toInvoices,
} from './csv-input.js';

const TEMPLATE = [
  'Date,Vendor,Item,Qty,Unit Price,Line Total',
  '2025-01-08,Acme Supply Co.,paper goods,10,12.40,124.00',
  '2025-02-06,Acme Supply Co.,paper goods,12,13.75,165.00',
  '2025-01-15,Northside Linen,weekly linen service,,,410.00',
].join('\n');

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
  Object.assign(document.createElement('a'), { href: url, download: 'nickel-and-dimed-template.csv' }).click();
  URL.revokeObjectURL(url);
}

// The "try your own data" flow: read a CSV in the tab, let the visitor confirm
// which column is which, then run the real detection on it locally. The analysis
// engine (PGlite, a few MB) loads only when someone actually presses Analyze.
export default function TryYourData({ onAnalyzed, onClose }) {
  const [file, setFile] = useState(null);         // { name, parsed }
  const [mapping, setMapping] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  const open = (name, text) => {
    setError('');
    const parsed = parseCsv(text);
    if (!parsed.headers.length || !parsed.rows.length) {
      setError('That file has no rows to read. It needs a header row and at least one line.');
      return;
    }
    setFile({ name, parsed });
    setMapping(detectColumns(parsed.headers));
  };

  const readFile = async (f) => {
    if (!f) return;
    if (!/\.(csv|txt|tsv)$/i.test(f.name) && !/text|csv/.test(f.type)) {
      setError('Export it as a CSV first — spreadsheets can "Save as CSV".');
      return;
    }
    open(f.name, await f.text());
  };

  const useSample = async () => {
    setError('');
    open('popin-2023-2025.csv (sample)', await fetch(sampleUrl).then((r) => r.text()));
  };

  let preview = null, previewError = '';
  if (file && mapping) {
    try { preview = toInvoices(file.parsed, mapping); } catch (e) { previewError = e.message; }
  }
  const problems = mapping ? mappingProblems(mapping) : [];
  const ready = preview && !problems.length && preview.invoices.length > 0 && !busy;

  const analyze = async () => {
    setBusy(true);
    setError('');
    try {
      setProgress('Loading the analysis engine (about 5 MB, first time only)');
      const [{ analyzeInvoices }, { default: schemaSql }] = await Promise.all([
        import('./analysis.js'),
        import('../schema.sql?raw'),
      ]);
      const result = await analyzeInvoices(preview.invoices, schemaSql, { onProgress: setProgress });
      onAnalyzed(result, { fileName: file.name, skipped: preview.skipped.length });
    } catch (e) {
      setError(`The analysis stopped: ${e.message}`);
      setBusy(false);
    }
    setProgress('');
  };

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <div className="modal try-modal" role="dialog" aria-modal="true" aria-labelledby="try-title">
        <div className="drawer-head">
          <div>
            <div className="drawer-title" id="try-title">Try it on your own invoices</div>
            <div className="faint small">
              Your file is analyzed inside this browser tab. Nothing is uploaded or stored.
            </div>
          </div>
          <button className="ghost close" disabled={busy} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          {!file && (
            <>
              <label
                className={'dropzone' + (dragging ? ' over' : '')}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); readFile(e.dataTransfer.files?.[0]); }}
              >
                <strong>Drop a spend CSV here</strong>
                <span className="faint small">or click to choose a file</span>
                <input
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv,text/plain"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; readFile(f); }}
                />
              </label>
              <p className="try-help">
                One row per line item: a <b>date</b>, a <b>vendor</b>, an <b>item</b>,
                a <b>quantity</b>, and a <b>unit price</b> (or line total). Rows with only
                an amount work too, as weaker evidence. Column names don't have to match —
                you'll confirm them next.
              </p>
              <div className="row try-links">
                <button className="ghost" onClick={useSample}>Use the 3-year sample file</button>
                <button className="ghost" onClick={downloadTemplate}>Download a template</button>
              </div>
            </>
          )}

          {file && mapping && (
            <>
              <div className="try-file">
                <span><b>{file.name}</b> · {file.parsed.rows.length.toLocaleString()} rows</span>
                {!busy && (
                  <button className="ghost" onClick={() => { setFile(null); setMapping(null); }}>
                    Choose another file
                  </button>
                )}
              </div>

              <div className="eyebrow try-eyebrow">Which column is which?</div>
              <div className="mapping">
                {FIELDS.map((f) => (
                  <label key={f.key}>
                    <span>{f.label}{f.required ? '' : <em> optional</em>}</span>
                    <select
                      value={mapping[f.key]}
                      disabled={busy}
                      onChange={(e) => setMapping({ ...mapping, [f.key]: Number(e.target.value) })}
                    >
                      <option value={-1}>— none —</option>
                      {file.parsed.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <p className="faint small">Dates like 03/04/2025 are read as March 4 (US order).</p>

              {problems.map((p) => <p key={p} className="error">{p}</p>)}
              {previewError && <p className="error">{previewError}</p>}

              {preview && !problems.length && (
                <div className="try-preview">
                  <b>{preview.invoices.length.toLocaleString()}</b> invoices ready to analyze.
                  {' '}Different spellings of one vendor are matched during analysis.
                  {preview.skipped.length > 0 && (
                    <details>
                      <summary>
                        {preview.skipped.length.toLocaleString()} row{preview.skipped.length === 1 ? '' : 's'} skipped — see why
                      </summary>
                      <ul className="skips">
                        {preview.skipped.slice(0, 8).map((s) => (
                          <li key={s.line}>Row {s.line}: {s.reason}</li>
                        ))}
                        {preview.skipped.length > 8 && <li>…and {preview.skipped.length - 8} more</li>}
                      </ul>
                    </details>
                  )}
                </div>
              )}

              <div className="row try-actions">
                <button disabled={!ready} onClick={analyze}>
                  {busy ? `${progress || 'Working'}…` : 'Analyze in my browser'}
                </button>
              </div>
            </>
          )}

          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
    </>
  );
}
