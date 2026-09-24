const headerWords = new Set([
  'amount', 'date', 'invoice date', 'item', 'line total', 'price', 'qty',
  'quantity', 'total', 'unit price', 'vendor', 'vendor name',
]);

const csvCells = (line) => {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(cell.trim().toLowerCase());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim().toLowerCase());
  return cells;
};

export function looksLikeCsvHeader(line = '') {
  if (!line.includes(',')) return false;
  const cells = csvCells(line);
  const recognized = cells.filter((cell) => headerWords.has(cell));
  return recognized.length >= 2
    && recognized.some((cell) => cell === 'date' || cell === 'invoice date')
    && recognized.some((cell) => cell === 'vendor' || cell === 'vendor name');
}

export function splitInput(text, size) {
  const lines = String(text).trim().split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];

  const header = looksLikeCsvHeader(lines[0]) ? lines.shift() : null;
  const batches = [];
  for (let i = 0; i < lines.length; i += size) {
    const rows = lines.slice(i, i + size);
    batches.push(header ? [header, ...rows].join('\n') : rows.join('\n'));
  }
  if (!batches.length && header) batches.push(header);
  return batches;
}

const vendorKey = (name) => String(name)
  .toLowerCase()
  .replace(/\b(co|inc|llc|ltd|corp|corporation|company)\b\.?/g, '')
  .replace(/[^a-z0-9 ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export function mergeExtractedInvoices(invoices) {
  const confidenceRank = { low: 0, medium: 1, high: 2 };
  const merged = new Map();

  for (const invoice of invoices) {
    const key = `${vendorKey(invoice.vendor_name)}|${invoice.invoice_date}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...invoice,
        lines: [...invoice.lines],
        source_line: invoice.source_line.trim(),
      });
      continue;
    }

    existing.lines.push(...invoice.lines);
    if (!existing.lines.length) existing.amount += invoice.amount;
    existing.confidence = confidenceRank[invoice.confidence] < confidenceRank[existing.confidence]
      ? invoice.confidence
      : existing.confidence;
    for (const line of invoice.source_line.trim().split(/\r?\n/)) {
      if (!existing.source_line.split(/\r?\n/).includes(line)) {
        existing.source_line += `\n${line}`;
      }
    }
  }

  return [...merged.values()];
}
