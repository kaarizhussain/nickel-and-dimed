-- Nickel and Dimed schema. Paste into the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -f schema.sql
--
-- ============================================================================
-- THE DATA CONTRACT
-- ============================================================================
-- A PRICE OBSERVATION is the unit price of a comparable item, from one vendor,
-- on one invoice date.
--
-- Invoice totals are NOT treated as evidence of a price change whenever quantity
-- information is available.
--
-- This rule exists because an invoice total moves for two unrelated reasons, and
-- only one of them is a vendor raising prices:
--
--   order size   2 pizzas -> 3 pizzas takes an invoice from $62 to $93
--   unit price   $31/pizza -> $34/pizza takes the same 2-pizza order to $68
--
-- An earlier version of this schema detected on avg(invoice total) and could not
-- tell those apart. It survived only because averaging ~10 invoices a month made
-- order-size noise cancel out -- which is luck, not method, and it fails outright
-- for any vendor whose order sizes trend rather than wobble.
--
-- Vendors who do not itemize still get analysed, on invoice averages, but that
-- weaker basis is carried all the way through to the alert instead of hidden.
-- ============================================================================
--
-- Three tables: vendors, invoices, invoice_lines. Every flag is a view derived
-- from them, so detection has no write path and can never go stale.
--
-- ============================================================================
-- TUNING: every number that decides what counts as a finding
-- ============================================================================
-- The detection logic lives in SQL rather than application code, which makes it
-- fast and inspectable but means sensitivity is tuned here. These are all of them:
--
--   0.08   jump threshold -- price vs its trailing 3-month baseline   [price_flags]
--   0.10   drift threshold -- price vs the same month last year       [price_flags]
--   4      rising months required before drift is called              [price_flags]
--   2      observations a month needs to count at all      [item_changes, price_flags]
--   3      months in the trailing baseline window                   [item_changes w3]
--   6      months the rising-month count looks back                 [item_changes w6]
--   11     months in the trailing quantity window                  [item_changes w12]
--   1.05   how far above the reference a month must sit to count as "still held"
--                                                                     [price_flags]
--
-- They are deliberately literals rather than a settings table or wrapper functions:
-- one indirection layer to change a constant makes the window definitions harder to
-- read, and reading them is the point. Change a number, re-run this file, done --
-- every flag is a view, so nothing needs recomputing or invalidating afterwards.
-- ============================================================================

-- ---------------------------------------------------------------- normalization

-- Collapses "ACME Supply" / "Acme Supply Co." to one key, and does the same job
-- for item names so "Balloon Arch" and "balloon arch" are one comparable item.
-- This is the exact-dedup safety net; fuzzy matching happens in the extraction
-- prompt, which sees the existing vendor list.
--
-- lowercase -> drop legal suffixes -> drop punctuation -> collapse spaces ->
-- drop a trailing plural from every word.
--
-- The plural strip is what lets "Party Time Balloons LLC" and "Party Time Balloon
-- Co." resolve to one vendor without the model's help. Loading the seed directly,
-- bypassing extraction, split that vendor in two and divided its impact across
-- both rows -- a safety net that only works when the smart layer already worked
-- is not a safety net.
--
-- ponytail: naive plural strip ("Express" -> "expres", "Sons" -> "son"). Harmless
-- while applied to both sides of every comparison; it would mis-merge two vendors
-- whose names differ only by a plural. pg_trgm similarity is the upgrade.
create or replace function norm(t text) returns text
language sql immutable strict as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(t), '\y(co|inc|llc|ltd|corp|corporation|company)\y\.?', '', 'g'),
      '[^a-z0-9 ]', '', 'g'),
    '\s+', ' ', 'g'),
  's\y', '', 'g'))
$$;

-- ---------------------------------------------------------------------- tables

create table if not exists vendors (
  id              bigint generated always as identity primary key,
  name            text not null,
  normalized_name text generated always as (norm(name)) stored,
  category        text,
  created_at      timestamptz not null default now()
);
create unique index if not exists vendors_normalized_name_key on vendors (normalized_name);

create table if not exists invoices (
  id           bigint generated always as identity primary key,
  vendor_id    bigint not null references vendors(id) on delete cascade,
  amount       numeric(12,2) not null check (amount >= 0),
  invoice_date date not null,
  category     text not null default 'other'
    check (category in ('food and beverage','supplies','apparel','services','utilities','other')),
  raw_input    text,
  confidence   text check (confidence in ('low','medium','high')),
  -- "high confidence" is the model's own claim about its extraction. Once a person
  -- edits a row that is a different and much stronger fact, and collapsing the two
  -- would launder a guess into a verified figure. Null means nobody has checked it.
  corrected_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists invoices_vendor_date on invoices (vendor_id, invoice_date);

-- The price observations themselves. item_key is what makes two lines comparable
-- across months; without it "3 Cheese Pizza" and "cheese pizza" are different
-- products and neither ever accumulates enough history to analyse.
create table if not exists invoice_lines (
  id         bigint generated always as identity primary key,
  invoice_id bigint not null references invoices(id) on delete cascade,
  item       text not null,
  item_key   text generated always as (norm(item)) stored,
  qty        numeric(12,3) not null check (qty > 0),
  unit_price numeric(12,4) not null check (unit_price >= 0),
  line_total numeric(12,2) generated always as (round(qty * unit_price, 2)) stored
);
create index if not exists invoice_lines_invoice on invoice_lines (invoice_id);
create index if not exists invoice_lines_item on invoice_lines (item_key);

-- No auth in v1, and the browser never talks to Supabase directly -- the Node API
-- holds the secret key. RLS on with zero policies means anon/authenticated get
-- nothing even if the URL and anon key leak.
alter table vendors       enable row level security;
alter table invoices      enable row level security;
alter table invoice_lines enable row level security;

-- --------------------------------------------------------------------- ingest

-- Upsert vendors, then insert each invoice with its own lines.
create or replace function ingest_invoices(payload jsonb)
returns integer
language plpgsql as $$
declare b record; inv bigint; n integer := 0;
begin
  drop table if exists _batch;
  create temp table _batch on commit drop as
  select row_number() over () as rn, *
    from jsonb_to_recordset(payload) as r(
      vendor_name  text,
      amount       numeric,
      invoice_date date,
      category     text,
      lines        jsonb,
      confidence   text,
      raw_input    text
    );

  -- Fail closed. The header total is summed over the incoming lines, so a malformed
  -- line that got filtered out of the detail would still inflate the total that the
  -- detail is supposed to justify. Money data rejects the whole record instead.
  -- Types are checked before casting, so a non-numeric qty fails the record rather
  -- than raising.
  delete from _batch
   where vendor_name is null
      or invoice_date is null
      or (amount is null and (lines is null or jsonb_array_length(lines) = 0))
      or exists (
        select 1 from jsonb_array_elements(coalesce(lines, '[]'::jsonb)) l
         where jsonb_typeof(l->'item')       is distinct from 'string'
            or jsonb_typeof(l->'qty')        is distinct from 'number'
            or jsonb_typeof(l->'unit_price') is distinct from 'number'
            or (l->>'qty')::numeric <= 0
            or (l->>'unit_price')::numeric < 0
      );

  insert into vendors (name, category)
  select distinct on (norm(vendor_name)) vendor_name, category
    from _batch
   order by norm(vendor_name), length(vendor_name) desc  -- keep the fullest spelling
  on conflict (normalized_name) do nothing;

  -- Each invoice is inserted together with its own lines, so a line can only ever
  -- attach to the record it came from.
  --
  -- This was two set-based inserts joined on row_number(). That join broke the
  -- moment a record was rejected from anywhere but the END of the batch: the delete
  -- shifted the numbering on one side only, and lines silently attached to the wrong
  -- invoice or vanished. It passed every test because the one rejected row in the
  -- fixtures happened to be last -- the single position where the bug is invisible.
  -- A positional join across two separately-numbered sets is not a key.
  for b in select * from _batch order by rn loop
    insert into invoices (vendor_id, amount, invoice_date, category, confidence, raw_input)
    select v.id,
           -- when lines are present the total is derived from them, so the header
           -- can never silently disagree with its own detail
           coalesce((select sum((l->>'qty')::numeric * (l->>'unit_price')::numeric)
                       from jsonb_array_elements(b.lines) l), b.amount),
           b.invoice_date,
           -- an off-list category would fail the check constraint and kill the whole
           -- batch; anything unrecognized lands in 'other'
           case when lower(b.category) in ('food and beverage','supplies','apparel','services','utilities')
                then lower(b.category) else 'other' end,
           b.confidence,
           b.raw_input
      from vendors v
     where v.normalized_name = norm(b.vendor_name)
    returning id into inv;

    if inv is not null then
      insert into invoice_lines (invoice_id, item, qty, unit_price)
      select inv, l->>'item', (l->>'qty')::numeric, (l->>'unit_price')::numeric
        from jsonb_array_elements(coalesce(b.lines, '[]'::jsonb)) l;
      n := n + 1;
    end if;
  end loop;

  return n;
end $$;

-- The schema says an invoice total is derived from its own lines. Nothing enforced
-- that after ingest: a later write could set amount to anything while the lines said
-- otherwise. A rule the application is trusted to remember is not a rule.
create or replace function sync_invoice_amount() returns trigger
language plpgsql as $$
declare target bigint := coalesce(new.invoice_id, old.invoice_id);
begin
  update invoices i
     set amount = coalesce((select sum(l.line_total) from invoice_lines l
                             where l.invoice_id = target), i.amount)
   where i.id = target;
  return null;
end $$;

drop trigger if exists invoice_lines_sync_amount on invoice_lines;
-- ponytail: row-level, so a bulk load fires once per line. Fine at this scale
-- (~1,700 lines load in seconds); move to a statement-level trigger with transition
-- tables if that stops being true.
create trigger invoice_lines_sync_amount
after insert or update or delete on invoice_lines
for each row execute function sync_invoice_amount();

-- ------------------------------------------------------------------ detection

-- Every price observation in the system, on one of two evidence bases. The
-- fallback is deliberate: a vendor who never itemizes should still be analysed,
-- but the alert has to say the evidence is weaker.
create or replace view price_observations as
select i.vendor_id,
       v.name          as vendor_name,
       l.item_key,
       l.item,
       i.invoice_date,
       l.unit_price,
       l.qty,
       'unit_price'::text as basis,
       i.id            as invoice_id
  from invoice_lines l
  join invoices i on i.id = l.invoice_id
  join vendors  v on v.id = i.vendor_id
union all
select i.vendor_id,
       v.name,
       '(whole invoice)',
       '(whole invoice)',
       i.invoice_date,
       i.amount,           -- the invoice is treated as a single unit
       1,
       'invoice_average',
       i.id
  from invoices i
  join vendors v on v.id = i.vendor_id
 where not exists (select 1 from invoice_lines l where l.invoice_id = i.id);

create or replace view item_monthly as
select vendor_id,
       vendor_name,
       item_key,
       min(item)                                 as item,
       basis,
       date_trunc('month', invoice_date)::date   as month,
       round(avg(unit_price), 4)                 as avg_unit_price,
       sum(qty)                                  as qty,
       round(sum(unit_price * qty), 2)           as spend,
       count(*)::int                             as observations
  from price_observations
 group by vendor_id, vendor_name, item_key, basis, date_trunc('month', invoice_date);

-- Month-over-month via lag(). Year-over-year via a self-join on an exact 12-month
-- offset, NOT lag(..., 12): an item with any gap in its history would have
-- lag-12-rows silently compare the wrong months.
create or replace view item_changes as
with lagged as (
  select m.*,
         lag(m.avg_unit_price) over (partition by m.vendor_id, m.item_key order by m.month)
           as prev_month_price
    from item_monthly m
)
select l.vendor_id, l.vendor_name, l.item_key, l.item, l.basis, l.month,
       l.qty, l.spend, l.observations, l.avg_unit_price, l.prev_month_price,
       -- Compare against the THREE months before this one, not just the last one.
       -- A single prior month is itself a noisy estimate, so comparing one noisy
       -- number against another roughly doubles the noise in the difference.
       --
       -- FILTER applies the same observation floor to the baseline that the flagged
       -- month must clear. Without it a single-invoice month could anchor the
       -- comparison and move the verdict -- the exact weakness the floor exists to
       -- close, enforced on one side only. If every month in the window is that thin
       -- the baseline is null and no finding is produced, which is the right answer
       -- rather than a guess.
       --
       -- This is an unweighted mean of monthly means, NOT a quantity-weighted unit
       -- price, and that is deliberate: the question is "did this vendor reprice",
       -- so each month is one observation of the quoted price regardless of how much
       -- was bought. A quantity-weighted baseline answers a different and also
       -- useful question -- effective spend-weighted unit cost, which mixes
       -- purchasing behaviour back into a price signal. Measured across 210
       -- item-months the two diverge by at most 1.7% and change zero verdicts.
       avg(l.avg_unit_price) filter (where l.observations >= 2) over w3 as baseline_price,
       y.avg_unit_price               as prev_year_price,
       sum(l.qty)            over w12 as trailing_12mo_qty,
       sum(l.spend)          over w12 as trailing_12mo_spend,
       -- How many of the last six months moved UP. A ratchet is many small rises all
       -- in one direction; seasonality wobbles both ways and can happen to end high.
       count(*) filter (where l.avg_unit_price > l.prev_month_price) over w6 as rising_months
  from lagged l
  -- Year over year via a self-join on an exact 12-month offset, NOT lag(..., 12):
  -- an item with any gap in its history would have lag-12-ROWS silently compare the
  -- wrong two months.
  left join item_monthly y
    on y.vendor_id = l.vendor_id and y.item_key = l.item_key
   and y.month = (l.month - interval '12 months')::date
window
  w3  as (partition by l.vendor_id, l.item_key order by l.month
          range between interval '3 months' preceding and interval '1 month' preceding),
  w6  as (partition by l.vendor_id, l.item_key order by l.month
          range between interval '5 months' preceding and current row),
  w12 as (partition by l.vendor_id, l.item_key order by l.month
          range between interval '11 months' preceding and current row);

-- TWO KINDS OF FINDING.
--
--   jump   a discrete step away from the recent baseline: >= 8% above the trailing
--          three months.
--
--   drift  a slow ratchet the baseline cannot see. A trailing baseline CHASES a
--          creeping price upward, so the gap never opens -- 2%/month for a year
--          reads as 4% vs baseline every single month and never trips the jump
--          rule, while the price actually rises 27%. Year over year is the
--          comparison that cannot be walked away from. Requiring most of the last
--          six months to have risen separates a genuine ratchet from seasonal noise
--          that happens to end high.
--
-- Annualized impact is the per-unit increase times the item's actual trailing
-- 12-month QUANTITY -- "you buy 421 of these a year and each now costs $3 more" --
-- measured against the baseline for a jump and against last year for a drift.
--
-- The guards below were set by measuring three years of real spend, where the
-- original rule (5% vs the single prior month, no minimum) produced 11 false
-- positives out of 20 flags:
--
--   observations >= 2  A month with one observation has no average to speak of, so
--                      ordinary variation crosses any threshold. A floor of 3 also
--                      works but silently drops real findings from twice-monthly
--                      vendors.
--
--   0.08 not 0.05      Measured noise landed at 5.0-6.3% and every genuine increase
--                      at 9.3-17.7%. The gap between them is empty, so the threshold
--                      belongs in it. Tuned to these vendors' volumes and variance --
--                      re-check it against your own. The properly statistical
--                      version scales by each item's own standard error.
create or replace view price_flags as
with detected as (
  select vendor_id, vendor_name, item_key, item, basis,
         month as period_end, baseline_price, avg_unit_price as current_price,
         prev_year_price, observations, qty, trailing_12mo_qty, trailing_12mo_spend,
         rising_months,
         round((avg_unit_price - prev_year_price) / nullif(prev_year_price, 0) * 100, 1)
           as pct_change_yoy,
         case
           when (avg_unit_price - baseline_price) / nullif(baseline_price, 0) >= 0.08
             then 'jump'
           when (avg_unit_price - prev_year_price) / nullif(prev_year_price, 0) >= 0.10
            and rising_months >= 4
             then 'drift'
         end as kind
    from item_changes
   where observations >= 2
),
-- what the finding is measured against: the recent baseline for a jump, the price a
-- year ago for a drift
ref as (
  select d.*,
         case when d.kind = 'drift' then d.prev_year_price else d.baseline_price end as ref_price
    from detected d
   where d.kind is not null
),
held as (
  select r.vendor_id, r.item_key, r.period_end,
         (select count(*) from item_monthly m
           where m.vendor_id = r.vendor_id
             and m.item_key  = r.item_key
             and m.month    >= r.period_end
             and m.avg_unit_price >= r.ref_price * 1.05) as months_held
    from ref r
)
select r.vendor_id, r.vendor_name, r.item_key, r.item, r.basis, r.kind,
       case when r.kind = 'drift' then (r.period_end - interval '12 months')::date
            else (r.period_end - interval '3 months')::date end as period_start,
       r.period_end,
       r.ref_price as baseline_price,
       r.current_price, r.observations, r.qty,
       r.trailing_12mo_qty, r.trailing_12mo_spend, r.rising_months, r.pct_change_yoy,
       round((r.current_price - r.ref_price) / nullif(r.ref_price, 0) * 100, 1) as pct_change,
       round((r.current_price - r.ref_price) * r.trailing_12mo_qty, 2) as annualized_impact,
       h.months_held,
       -- Confidence is derived from evidence already on the row, not asserted.
       --   basis         is it the right KIND of evidence? A finding resting on
       --                 invoice averages cannot separate a price rise from a bigger
       --                 order, so it is never better than low however clean the
       --                 numbers look.
       --   observations  is there ENOUGH of it?
       --   months_held   did it STICK? A one-month spike is as easily a product-mix
       --                 change or a one-off as a repricing. An increase still
       --                 standing months later is a repricing.
       case
         when r.basis = 'invoice_average'                 then 'low'
         when r.observations >= 4 and h.months_held >= 3  then 'high'
         when r.observations >= 2 and h.months_held >= 2  then 'medium'
         else 'low'
       end as confidence
  from ref r
  join held h
    on h.vendor_id = r.vendor_id and h.item_key = r.item_key and h.period_end = r.period_end;

-- What the dashboard reads: each vendor's worst current problem. A vendor is
-- ranked by the item costing it the most per year, not by how many items moved.
create or replace view vendor_alerts as
select *, rank() over (order by annualized_impact desc) as impact_rank
  from (
    select distinct on (vendor_id) *
      from (
        -- only the most recent flag per item, so a sustained increase is one
        -- finding rather than one per month it persisted
        select distinct on (vendor_id, item_key) *
          from price_flags
         order by vendor_id, item_key, period_end desc
      ) latest_per_item
     order by vendor_id, annualized_impact desc
  ) worst_per_vendor
 order by impact_rank;

-- Kept for the chart and the vendor drawer: total spend per vendor per month.
create or replace view vendor_monthly as
select v.id                                      as vendor_id,
       v.name                                    as vendor_name,
       date_trunc('month', i.invoice_date)::date as month,
       sum(i.amount)                             as spend,
       count(*)::int                             as invoice_count,
       round(avg(i.amount), 2)                   as avg_invoice
  from invoices i
  join vendors v on v.id = i.vendor_id
 group by 1, 2, 3;

-- Views default to running as their owner, which bypasses the RLS above.
alter view price_observations set (security_invoker = on);
alter view item_monthly       set (security_invoker = on);
alter view item_changes       set (security_invoker = on);
alter view price_flags        set (security_invoker = on);
alter view vendor_alerts      set (security_invoker = on);
alter view vendor_monthly     set (security_invoker = on);

-- ---------------------------------------------------- duplicate vendor review

-- Duplicate vendors silently shatter a price series: one business under two records
-- means two half-length histories, neither long enough to detect anything. norm()
-- only catches what it can PROVE -- casing, punctuation, legal suffixes, plurals.
-- Judgement calls ("Sysco Foods NYC" and "Sysco New York") live in the extraction
-- prompt, and when the model slips there was nothing to notice it.
--
-- This merges NOTHING. Auto-merging is the dangerous direction: two genuinely
-- different vendors collapsed into one corrupts every series they touch, invisibly,
-- whereas a duplicate is at least visible and fixable. It surfaces candidates for a
-- person -- the same division of labour as everywhere else here.
--
-- TWO SIGNALS, because neither is sufficient alone:
--
--   name_similarity  trigram distance. Strong on typos and truncations
--                    ("acme supply" / "acme supplie" = 0.667). WEAK on regional
--                    naming: "sysco food nyc" / "sysco new york" scores 0.304 while
--                    "smith and son" / "smith brother" -- different businesses --
--                    scores 0.286. No threshold separates those two, so name
--                    distance alone cannot be trusted for that class of duplicate.
--
--   shared_items     how much of their catalogue overlaps. Two records billing for
--                    the same products are far more likely one vendor, and this is
--                    the signal that reaches the case string distance cannot.
create extension if not exists pg_trgm with schema extensions;

create or replace view vendor_merge_candidates as
with pairs as (
  select a.id as a_id, a.name as a_name, a.normalized_name as a_key,
         b.id as b_id, b.name as b_name, b.normalized_name as b_key,
         round(extensions.similarity(a.normalized_name, b.normalized_name)::numeric, 3)
           as name_similarity
    from vendors a
    join vendors b on b.id > a.id          -- each pair once, never against itself
),
catalogue as (
  select p.a_id, p.b_id,
         count(*) filter (where ia.item_key is not null and ib.item_key is not null)
           as shared_items
    from pairs p
    left join (select distinct i.vendor_id, l.item_key
                 from invoice_lines l join invoices i on i.id = l.invoice_id) ia
           on ia.vendor_id = p.a_id
    left join (select distinct i.vendor_id, l.item_key
                 from invoice_lines l join invoices i on i.id = l.invoice_id) ib
           on ib.vendor_id = p.b_id and ib.item_key = ia.item_key
   group by p.a_id, p.b_id
)
select p.a_id, p.a_name, p.b_id, p.b_name,
       p.name_similarity,
       coalesce(c.shared_items, 0) as shared_items,
       case
         when p.name_similarity >= 0.55 then 'likely same vendor'
         when coalesce(c.shared_items, 0) >= 2 and p.name_similarity >= 0.25
           then 'same catalogue, similar name'
         else 'worth a look'
       end as why
  from pairs p
  left join catalogue c on c.a_id = p.a_id and c.b_id = p.b_id
 where p.name_similarity >= 0.40
    or (coalesce(c.shared_items, 0) >= 2 and p.name_similarity >= 0.25)
 order by p.name_similarity desc;

alter view vendor_merge_candidates set (security_invoker = on);
