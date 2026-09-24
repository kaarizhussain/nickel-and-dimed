# Two-minute walkthrough

## 0:00–0:20 — Start with the decision

The lead number says the detected increases cost `$2,190/year`. The supporting
cards identify the vendor, item, price move, annual impact, evidence count, and
confidence without requiring the viewer to understand the implementation.

## 0:20–0:45 — Show the analytical distinction

Point to the indexed unit-price chart. Tony's Pizza and Party Time Balloons step
up and hold; Roast House Coffee rises later with visibly noisier evidence. Theme
Party Decor does not appear even though its invoices became much larger, because
its unit price never changed.

## 0:45–1:10 — Inspect the evidence

Open Tony's Pizza. The drawer shows both detected price steps, the invoices behind
them, parsed line items, extraction confidence, and the verbatim source rows. This
is the audit trail behind the dashboard number.

## 1:10–1:35 — Close the correction loop

Choose **Correct** on an invoice. Quantity and unit price can be fixed directly;
the raw source cannot be edited. Saving changes the derived invoice total and all
dependent findings immediately because alerts are database views rather than a
cached result.

## 1:35–2:00 — Exercise ingestion and safeguards

Open **Add invoices** and use `sample-input.csv`. It includes inconsistent vendor
names, inconsistent item casing, multiple date formats, a subtotal row, and a
non-itemized vendor. Retrying the same file is safe: source fingerprints prevent
the same extracted invoice from being counted twice.
