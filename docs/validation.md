# Validation and claim provenance

This page separates results that can be reproduced from this repository from
experience-based context that cannot be independently reconstructed here.

## Reproducible checks

| Claim | Evidence | Command |
|---|---|---|
| The seed has 1,698 data rows, including six junk subtotal rows | deterministic generator and committed CSV | `node seed/generate.mjs` and compare with `seed/popin-2023-2025.csv` |
| Valid rows produce 1,193 invoices and 1,692 line items | seed loader's deterministic grouping | `node --env-file=.env seed/load.mjs` |
| Increasing order quantity at a flat unit price raises no alert | known-answer SQL fixture | `npm run test:sql` |
| A slow 2% monthly ratchet is caught as drift | known-answer SQL fixture | `npm run test:sql` |
| A reverted increase is not a current alert | known-answer SQL fixture | `npm run test:sql` |
| Retrying the same source record does not duplicate it | source-hash uniqueness assertion | `npm run test:sql` |
| Headerless text does not repeat its first invoice across chunks | Node unit test | `npm test` |
| The production frontend compiles | Vite production build | `npm test` |

The SQL suite runs inside a transaction and ends with `rollback`, so it does not
leave its fixtures behind. CI runs it against PostgreSQL 17.

## Dataset-backed findings

The three dashboard findings and the `$2,190/year` total are outputs of the
committed synthetic reconstruction. They can be reproduced by loading the seed
into a fresh schema. They should not be represented as audited historical business
records.

## Contextual claims

The following are disclosed context, not results independently proven by this
repository:

- the approximately 10% year-over-year operating-cost reduction from the author's
  prior vendor negotiations;
- the comparison that Haiku cost approximately five times less than Opus for the
  extraction experiment;
- the exploratory Chicago procurement-data variance measurement.

These claims explain product and model choices, but are deliberately kept separate
from the automated validation suite.
