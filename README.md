# Nickel and Dimed

Hand it a messy vendor spend export. Within a minute it tells you which vendor is
quietly raising prices on you, and what that costs over a year.

I ran vendor negotiations by hand for four years at a play space and café and cut
year-over-year cost about 10%. This is that job, automated.

---

## What the analysis found

Three years of spend, **1,193 invoices, 1,692 line items, six vendors** — loaded from
1,698 CSV rows, six of which are subtotal junk the ingest correctly refuses.

| Vendor | Item | Price move | When | Per year | Confidence |
|---|---|---|---|---|---|
| Tony's Pizza | party pizza | $34.00 → $37.00 (+8.8%) | Mar 2024 | **$1,263** | high — 13 obs, held 22 mo |
| Party Time Balloons | balloon arch | $43.00 → $47.00 (+9.3%) | Dec 2023 | **$508** | high — 10 obs, held 25 mo |
| Roast House Coffee | whole bean 5lb | $50.06 → $58.43 (+16.7%) | Sep 2025 | **$419** | medium — 2 obs, held 4 mo |

**$2,190 a year**, none of it announced by anyone.

Coffee comes back *medium* on purpose: it is a real increase, but it rests on two
observations a month, so the alert says so rather than presenting it with the same
weight as the other two.

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

Only the second is a vendor raising prices. Annualized impact is the per-unit
increase multiplied by the item's actual trailing-12-month **quantity** — "you buy
421 of these a year and each now costs $3 more."

**Two kinds of finding**, because one detector cannot see both:

| | |
|---|---|
| **jump** | a discrete step: ≥8% above the item's trailing three-month baseline |
| **drift** | a slow ratchet: ≥10% year over year, with most of the last six months rising |

Drift exists because a trailing baseline *chases a creeping price upward*. A vendor
raising 2% a month for a year reads as **4% above baseline every single month** and
never trips the jump rule — while the price actually rises **27%**. That's the
quietest version of the problem this tool is named after, and the jump detector
alone is blind to it. Year over year is the comparison that can't be walked away
from; requiring most of the last six months to have risen separates a real ratchet
from seasonal noise that happens to end high.

**Vendors who don't itemize** are still analysed, on invoice averages. That basis
cannot separate price from order size, so it is labelled as such on the alert
rather than quietly mixed in with the stronger findings.

**Confidence is derived, not asserted.** Every alert carries a grade computed from
evidence already on the row, and shows the evidence next to it so the grade is
checkable rather than something the app asks you to trust:

| Signal | Question | Column |
|---|---|---|
| basis | Is it the right *kind* of evidence? | `basis` |
| observations | Is there *enough* of it? | `observations` |
| persistence | Did the increase *stick*? | `months_held` |

A finding resting on invoice averages is capped at **low** no matter how clean the
numbers look, because that evidence cannot answer the question being asked. A
sustained increase on a thin month is **medium**. **High** needs four or more
observations in the flagged month and the new level still standing three months
later.

**One measurement choice worth stating.** The baseline is an unweighted mean of
monthly mean unit prices, not a quantity-weighted price. That is deliberate: the
question is *"did this vendor reprice?"*, so each month is one observation of the
quoted price regardless of how much was bought. A quantity-weighted baseline answers
a different and also useful question — effective spend-weighted unit cost — which
mixes purchasing behaviour back into a price signal. Measured across 210 item-months
here, the two diverge by at most **1.7%** and change **zero** verdicts, but they are
not the same measure and the code says which one it means.

The same observation floor applies to the baseline months as to the flagged month.
Enforcing it on only one side would have let a single-invoice month anchor the
comparison — the exact weakness the floor exists to close.

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
- **a 2%/month ratchet produces no jump at all, and is caught as drift** — 27% over a year,
  4% above baseline every month, invisible to a jump detector
- a genuine $31 → $37 unit-price step is caught, with the right percentage and annualized figure
- a 3% rise stays under the threshold
- year-over-year reaches across a ten-month gap in the history, which `lag(price, 12)` would miss
- the trailing-12-month window excludes the month sitting exactly 12 back
- vendors without line items still produce findings, labelled `invoice_average`, capped
  at low confidence, and priced against the trailing invoice count rather than a unit count
- a corrected quantity changes the annualized figure, and a corrected unit price retracts the flag
- `raw_input` survives every correction untouched
- a record with any malformed line is rejected whole, and lines stay attached to their own invoice
  even when the rejected record sits in the middle of the batch
- an invoice total cannot be left disagreeing with the sum of its lines
- a vendor split across two records surfaces for review, on catalogue overlap rather
  than name distance, and the six genuine vendors are never proposed as duplicates
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
   The dashboard chart plots the same thing the detector reads: each item's unit
   price, indexed to its own early average. Flat means the price held; climbing
   means it did not. It previously plotted average invoice size — the very metric
   the detector was changed to stop trusting — so a reader could have drawn a
   conclusion the engine explicitly refuses to draw.
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

**Corrections reach the numbers the analysis actually uses.** Quantity and unit
price *are* the analysis, so those are editable per line; the invoice total is not,
because it is derived from its lines and a database trigger keeps it that way. An
itemized invoice refuses a direct edit to its total and tells you to correct the
lines instead. Because every flag is a view, a correction re-derives detection
immediately — no cache, no recompute job, no stale alert.

### Duplicate vendors are surfaced, never auto-merged

A duplicate vendor silently shatters a price series — one business under two records
means two half-length histories, neither long enough to detect anything. `norm()`
cannot bridge `Sysco Foods NYC` and `Sysco New York`; only the extraction prompt
can, and when it slips there needs to be something that notices.

`vendor_merge_candidates` surfaces likely duplicates for a person to judge. It
merges nothing, because auto-merging is the dangerous direction: two genuinely
different vendors collapsed into one corrupts every series they touch, invisibly,
while a duplicate is at least visible.

It uses two signals because neither works alone:

| Signal | Catches | Misses |
|---|---|---|
| trigram name distance | typos, truncations (`acme supply`/`acme supplie` = 0.667) | regional naming |
| shared catalogue | two records billing for the same products | vendors with no overlap yet |

Measured: `sysco food nyc`/`sysco new york` scores **0.304**, while
`smith and son`/`smith brother` — different businesses — scores **0.286**. No name
threshold separates those, which is exactly why the catalogue overlap is there.

### Normalization is deliberately exact, not fuzzy

`norm()` handles casing, punctuation, legal suffixes and simple plurals, so
`ACME Supply Co.` and `Acme Supply` are one vendor. It does **not** do fuzzy
matching automatically, because a false merge is worse than a duplicate record: two
genuinely different vendors collapsed into one silently corrupts every price series
they touch, while a duplicate is visible and fixable. Judgement calls about whether
two names are the same business happen in the extraction prompt, which sees the
existing vendor list; the database layer only catches what it can prove.

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

That makes v1 deliberately a **periodic audit tool** rather than continuous AP
monitoring. Hooking into an accounting system is the next step toward the latter,
and it is a plumbing problem — OAuth, token refresh, incremental sync, dedup,
reconciliation — not an analytical one, so it would have crowded out the part of
this project worth showing.
