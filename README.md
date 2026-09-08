# Nickel and Dimed

Hand it a messy vendor spend export. Within a minute it tells you which vendor is
quietly costing you the most, and what that adds up to over a year.

I ran vendor negotiations by hand for four years and cut year-over-year cost about
10%. This is that job, automated.

## How it works

1. **Ingest** — paste raw invoice text or drop a CSV. Nothing is pre-parsed; the
   messy input goes straight through.
2. **Extract** — Claude returns structured invoices against a schema, and matches
   each vendor against the list already in the database, so `ACME Supply Co.` and
   `Acme Supply` land on one vendor instead of two.
3. **Detect** — SQL finds month-over-month and year-over-year moves in each
   vendor's average invoice, flags anything past 8% of its own trailing baseline, and
   over a year.
4. **Display** — one page, vendors ranked by what they cost you annually, with a
   three-sentence summary at the top and a CSV export.

## Setup

```bash
npm install
```

Create the schema — paste `schema.sql` into the Supabase SQL editor, or:

```bash
psql "$DATABASE_URL" -f schema.sql
```

Create `.env` in this directory:

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<secret key, sb_secret_...>
```

That last one is the **secret** key from Project Settings → API Keys, not the
publishable one. The publishable key is browser-safe by design, so it cannot write
past RLS — and reads come back as an empty result rather than an error, which
fails quietly and looks like the app is simply empty.

The secret key stays server-side. The browser only ever talks to the Node API,
never to Supabase directly — which is why the tables can run RLS with no policies
at all.

Two terminals:

```bash
npm run api
```

```bash
npm run dev
```

Then open the Vite URL and drop in `sample-input.csv`.

## Checks

```bash
psql "$DATABASE_URL" -f test_detection.sql
```

Ten known-answer assertions, verified green against Postgres 17. A 10% jump on
four invoices a year has to come out at exactly $40/yr; a 3% jump has to stay under
the threshold; year-over-year has to reach across a ten-month gap in the fixture
(which is what `lag(..., 12)` would miss); the trailing-12-month window has to
exclude the month that sits exactly 12 back; and three spellings of one vendor have
to collapse to a single row. Wraps itself in a transaction and rolls back, so it is
safe to run against a database with real data in it.

`sample-input.csv` is a small shape example for smoke-testing the pipeline —
inconsistent vendor spellings, three date formats, dollar signs, and a subtotal row
that should be skipped.

## The demo data

`seed/popin-2023-2025.csv` is three years of vendor spend from Pop In! Play Space &
Café — 1,253 invoices across six vendors. Where it comes from matters, so:

**Real, from operating the business:** the vendor list, the per-party unit costs
(balloons $38 base, pizza $31, decor $30–40), party volume (2–5 a weekend), café
restock (~$50 biweekly), cleaning (~$50/mo), toys ($100–150 every few months), and
which vendors rose — balloons after the helium shortage, pizza twice, coffee beans
on tariffs.

**Reconstructed:** exact dates, exact amounts, and the size of each increase. The
original records were no longer accessible. Vendor names are anonymized.

So the *shape* is real and the digits are modeled. `seed/generate.mjs` is
deterministic and carries the same note at the top, so the file regenerates
identically and nobody has to guess which numbers are which.

Public procurement data was the obvious alternative and turned out not to work:
city payment records are contract disbursements, not recurring invoices. The
steadiest vendor in Chicago's dataset still swings 42% month to month, which would
have produced confident dollar figures on noise.

## What it found, and what it got wrong first

Against those three years the detector caught all four known increases — balloons
Oct 2023 (+14.9%), pizza Jul 2023 (+11.0%) and Mar 2024 (+9.3%), coffee Aug 2025
(+14.4%, and +26.3% year over year).

It also flagged six vendors that had no trend at all: **11 of 20 flags were false.**
Worst case, a decor vendor with deliberately random $30–40 pricing produced a
$301/yr "finding" ranked *above* the real coffee increase, because it bills 132
times a year and the annualized multiplier scales noise as readily as signal.

Two causes. Comparing against the single prior month meant comparing one noisy
estimate against another, roughly doubling the noise in the difference — now a
three-month trailing baseline. And a vendor billing once a month has no average at
all, so ordinary variation crossed any threshold — now a floor of two invoices in
the month. The threshold moved 5% → 8% because measured noise landed at 5.0–6.3%
and every genuine increase at 9.3–17.7%, with an empty gap between.

Result: 7 flags, all four real increases, zero false positives.

Worth noting a floor of *three* invoices also eliminated every false positive — and
silently dropped the coffee increase, because coffee bills twice a month. Trading a
real finding for a cleaner dashboard is not visible unless you check for it.

## Where the SQL lives

Detection is written by hand in `schema.sql` rather than pushed through an ORM,
because the detection *is* the product:

- `vendor_changes` — `lag()` for month-over-month, and a `RANGE BETWEEN INTERVAL
  '11 months' PRECEDING` window for trailing-12-month spend and invoice volume.
- Year-over-year is a **self-join on an exact 12-month offset**, not `lag(..., 12)`.
  A vendor with any gap in its history would have lag-12-*rows* silently compare
  the wrong two months.
- `price_flags` — the 8% threshold and the annualized-impact arithmetic, in one
  place. Annualized impact is the per-invoice increase times the vendor's actual
  trailing-12-month invoice count: "if this holds, it costs you $X a year."
- `vendor_alerts` — `DISTINCT ON` for each vendor's most recent flag, then `RANK()`
  by annual cost.
- `ingest_invoices(jsonb)` — upserts vendors and inserts invoices in one round trip.

## Data model

Two tables, `vendors` and `invoices`. `price_flags` is a **view**, not a table:
it is derived entirely from `invoices`, so there is no write path and it cannot go
stale. `norm()` (lowercase, strip legal suffixes and punctuation) backs a unique
index on `vendors`, so deduplication is a database constraint rather than
application code.

## Not in v1

No auth, no QuickBooks or Square integration, no invoice OCR, no forecasting, no
mobile layout, no multi-currency. Each of those is a plausible reason a two-week
build never ships.
