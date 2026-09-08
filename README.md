# Nickel and Dimed

Hand it a messy vendor spend export. Within a minute it tells you which vendor is
quietly raising prices on you, and what that costs over a year.

I ran vendor negotiations by hand for four years at a play space and café and cut
year-over-year cost about 10%. This is that job, automated.

---

## What the analysis found

Three years of spend, 1,193 invoices, 1,698 line items, six vendors.

| Vendor | Item | Price move | When | Per year |
|---|---|---|---|---|
| Tony's Pizza | party pizza | $34.00 → $37.00 (+8.8%) | Mar 2024 | **$1,263** |
| Party Time Balloons | balloon arch | $43.00 → $47.00 (+9.3%) | Dec 2023 | **$508** |
| Roast House Coffee | whole bean 5lb | $50.06 → $58.43 (+16.7%) | Sep 2025 | **$419** |

**$2,190 a year**, none of it announced by anyone.

### And what it deliberately did not find

A decor supplier's monthly bill went from **$512 to $1,952 — up 281%.**

It raised **zero** alerts, correctly. That vendor's unit price is $32.00 and has
never changed. The bill grew because the business threw more parties and ordered
more kits. Calling that a price increase would send an owner into a renegotiation
over a price that never moved.

Separating those two cases is the whole methodology, and it is the thing the first
version of this project got wrong.

---

## Methodology

**The data contract.** A *price observation* is the unit price of a comparable item,
from one vendor, on one invoice date. Invoice totals are **not** treated as evidence
of a price change whenever quantity information is available.

That rule exists because an invoice total moves for two unrelated reasons:

| | |
|---|---|
| **order size** | 2 pizzas → 3 takes an invoice from $62 to $93 |
| **unit price** | $31 → $34 takes the same 2-pizza order to $68 |

Only the second is a vendor raising prices. Detection compares each item's unit
price against its own trailing three-month baseline, and annualized impact is the
per-unit increase multiplied by the item's actual trailing-12-month **quantity** —
"you buy 421 of these a year and each now costs $3 more."

**Vendors who don't itemize** are still analysed, on invoice averages. That basis
cannot separate price from order size, so it is labelled as such on the alert
rather than quietly mixed in with the stronger findings.

---

## Model validation and iteration

The first version of the detector was wrong in two separate ways. Both were found
by measurement, not by inspection.

### Round one — noise read as signal

Detecting on a single prior month with a 5% threshold produced **11 false positives
out of 20 flags.** Worst case, a vendor with deliberately random pricing produced a
$301/yr "finding" ranked *above* a real one, because it invoiced 132 times a year
and the annualized multiplier scales noise as readily as signal.

Two causes. Comparing against one prior month meant comparing one noisy estimate to
another, roughly doubling the noise in the difference — now a **three-month trailing
baseline**. And a vendor billing once a month has no average at all, so ordinary
variation crossed any threshold — now a floor of **two observations** in the month.
Measured noise sat at 5.0–6.3% and every genuine increase at 9.3–17.7%, an empty
gap, so the threshold moved to **8%**.

Result: 7 flags, all real, zero false positives.

> A floor of *three* observations also eliminated every false positive — and
> silently dropped a real finding from a twice-monthly vendor. Trading a true
> positive for a cleaner-looking dashboard is invisible unless you check for it.

### Round two — order size read as price

The fixed detector still measured `avg(invoice total)`, which cannot distinguish a
vendor raising prices from a customer buying more. It survived only because
averaging ~10 invoices a month made order-size noise cancel out — luck, not method,
and it fails outright for any vendor whose order sizes *trend*.

Tested against a vendor holding $32.00/unit for three years while order size climbed:

| Method | Flags raised | Reality |
|---|---|---|
| `avg(invoice total)` | **7**, peaking at "+46.2%, $921.60/yr" | price never moved |
| unit price | **0** | correct |

That case is now the first assertion in the test suite.

---

## Validation

```bash
psql "$DATABASE_URL" -f test_detection.sql
```

Known-answer SQL assertions, wrapped in a transaction that rolls back, so it is safe
against a database with real data in it. They cover:

- **a 281% rise in invoice totals on a flat unit price raises no alert** — quantity is not price
- a genuine $31 → $37 unit-price step is caught, with the right percentage and annualized figure
- a 3% rise stays under the threshold
- year-over-year reaches across a ten-month gap in the history, which `lag(price, 12)` would miss
- the trailing-12-month window excludes the month sitting exactly 12 back
- vendors without line items still produce findings, labelled `invoice_average`
- three spellings of one vendor collapse to a single record
- `paper goods` and `Paper Goods` are one comparable item; invoice totals derive from their own lines

---

## How it works

1. **Ingest** — paste raw invoice text or drop a CSV. Nothing is pre-parsed.
2. **Extract** — Claude returns structured invoices against a schema, groups rows
   that belong to one invoice, splits out quantity and unit price, and matches each
   vendor against the list already in the database so `ACME Supply Co.` and
   `Acme Supply` land on one vendor.
3. **Detect** — SQL compares each item's unit price to its own trailing baseline and
   prices the increase out over a year.
4. **Review** — click any vendor to see every flag it produced and the invoices
   underneath, each with its line items, the model's confidence, and the verbatim
   source text it was parsed from. Corrections are made in place; detection
   recomputes immediately.

### Provenance and correction

Every extracted invoice keeps the exact source line it came from, and that text is
never editable — correcting a reading must not rewrite the evidence it is being
corrected against. Corrections set `corrected_at` rather than raising the
confidence, because "the model was confident" and "a person checked this" are
different facts and collapsing them would launder a guess into a verified figure.

---

## Where the SQL lives

Detection is written by hand rather than pushed through an ORM, because the
detection *is* the product.

- `price_observations` — unions itemized lines and non-itemized invoices into one
  stream, carrying the evidence basis through
- `item_changes` — `lag()` for month-over-month, `RANGE BETWEEN INTERVAL '3 months'
  PRECEDING` for the baseline, an 11-month `RANGE` window for trailing quantity
- year-over-year is a **self-join on an exact 12-month offset**, not `lag(..., 12)`.
  An item with any gap in its history would have lag-12-*rows* silently compare the
  wrong two months
- `vendor_alerts` — `DISTINCT ON` twice (latest flag per item, then worst item per
  vendor) and `RANK()` by annual cost
- `norm()` backs unique indexes on both vendor and item names, so deduplication is a
  database constraint rather than application code

## Data model

Three tables — `vendors`, `invoices`, `invoice_lines`. Every flag is a **view**
derived from them, so detection has no write path and cannot go stale. That choice
pays for itself in the correction workflow: editing one invoice re-derives the
vendor's flags with no cache, no recompute job, and no invalidation logic.

---

## Data sourcing

The demo data is a **synthetic reconstruction**, not a financial record.

**Real, from operating the business:** the vendor list, the per-unit costs (balloon
arch $38, pizza $31, decor kit $32, coffee ~$46/bag), party volume, restock cadence,
and which vendors raised prices — balloons after the helium shortage, pizza twice,
coffee beans on tariffs.

**Modelled:** exact dates, exact amounts, exact quantities, and the size of each
increase. The original records were no longer accessible. Vendor names are
anonymized. `seed/generate.mjs` is deterministic and carries the same note, so the
file regenerates identically and nobody has to guess which numbers are which.

Public procurement data was the obvious alternative and was rejected after testing
it: city payment records are contract disbursements, not recurring invoices. The
steadiest vendor in Chicago's dataset still swings 42% month to month, which would
have produced confident dollar figures on noise.

## Setup

```bash
npm install
psql "$DATABASE_URL" -f schema.sql     # or paste schema.sql into the Supabase SQL editor
```

`.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<secret key, sb_secret_...>
```

That last one is the **secret** key from Project Settings → API Keys, not the
publishable one. The publishable key is browser-safe by design, so it cannot write
past RLS — and reads come back empty rather than erroring, which fails quietly and
looks like the app is simply empty. It stays server-side; the browser only ever
talks to the Node API, which is why the tables run RLS with no policies at all.

```bash
npm run api     # terminal 1
npm run dev     # terminal 2
```

Then drop in `sample-input.csv`, or load the full demo dataset:

```bash
node --env-file=.env seed/load.mjs
```

`seed/load.mjs` writes straight to SQL, skipping extraction, so the demo database
rebuilds in seconds for free. The extraction path is what a real upload exercises.

**Stack:** React, Node, Supabase/Postgres, Claude API. Extraction runs on Haiku 4.5
— it is a mechanical parse against a fixed schema, run once per 40 rows, and cost
5× less than Opus for identical validated output. The written summary stays on Opus,
where the prose is what people actually read.

## Not in v1

No auth, no accounting-system integrations, no invoice OCR, no forecasting, no
mobile layout, no multi-currency. Each is a plausible reason a two-week build never
ships.
