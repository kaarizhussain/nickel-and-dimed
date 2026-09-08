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

-- ---------------------------------------------------------------- normalization

-- Collapses "ACME Supply" / "Acme Supply Co." to one key, and does the same job
-- for item names so "Balloon Arch" and "balloon arch" are one comparable item.
-- This is the exact-dedup safety net; fuzzy matching happens in the extraction
-- prompt, which sees the existing vendor list.
-- ponytail: word-list suffix strip. A vendor genuinely named "Co Op Market" loses
-- its "Co". Swap in pg_trgm similarity if that ever bites.
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

-- One round trip: upsert vendors, insert invoices, then their lines.
create or replace function ingest_invoices(payload jsonb)
returns integer
language plpgsql as $$
declare inserted integer;
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

  delete from _batch
   where vendor_name is null or invoice_date is null
      or (amount is null and (lines is null or jsonb_array_length(lines) = 0));

  insert into vendors (name, category)
  select distinct on (norm(vendor_name)) vendor_name, category
    from _batch
   order by norm(vendor_name), length(vendor_name) desc  -- keep the fullest spelling
  on conflict (normalized_name) do nothing;

  drop table if exists _new;
  create temp table _new on commit drop as
  with ins as (
    insert into invoices (vendor_id, amount, invoice_date, category, confidence, raw_input)
    select v.id,
           -- when lines are present the total is derived from them, so the header
           -- figure can never silently disagree with its own detail
           coalesce(
             (select sum((l->>'qty')::numeric * (l->>'unit_price')::numeric)
                from jsonb_array_elements(b.lines) l),
             b.amount),
           b.invoice_date,
           -- an off-list category would fail the check constraint and kill the whole
           -- batch; anything unrecognized lands in 'other'
           case when lower(b.category) in ('food and beverage','supplies','apparel','services','utilities')
                then lower(b.category) else 'other' end,
           b.confidence,
           b.raw_input
      from _batch b
      join vendors v on v.normalized_name = norm(b.vendor_name)
     order by b.rn
    returning id
  )
  select id, row_number() over () as rn from ins;

  insert into invoice_lines (invoice_id, item, qty, unit_price)
  select n.id,
         l->>'item',
         (l->>'qty')::numeric,
         (l->>'unit_price')::numeric
    from _batch b
    join _new n on n.rn = b.rn
    cross join lateral jsonb_array_elements(coalesce(b.lines, '[]'::jsonb)) l
   where (l->>'item') is not null
     and (l->>'qty')::numeric > 0
     and (l->>'unit_price')::numeric >= 0;

  select count(*) into inserted from _new;
  return inserted;
end $$;

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
select m.vendor_id,
       m.vendor_name,
       m.item_key,
       m.item,
       m.basis,
       m.month,
       m.qty,
       m.spend,
       m.observations,
       m.avg_unit_price,
       lag(m.avg_unit_price)  over w   as prev_month_price,
       -- Compare against the THREE months before this one, not just the last one.
       -- A single prior month is itself a noisy estimate, so comparing one noisy
       -- number against another roughly doubles the noise in the difference.
       --
       -- The FILTER applies the same observation floor to the baseline that the
       -- flagged month has to clear. Without it a single-invoice month could anchor
       -- the comparison and move the verdict, which is the exact weakness the floor
       -- exists to close -- enforced on one side only. If every month in the window
       -- is that thin the baseline is null and no finding is produced, which is the
       -- right answer rather than a guess.
       --
       -- This is an unweighted mean of monthly means, NOT a quantity-weighted unit
       -- price, and that is deliberate: the question is "did this vendor reprice",
       -- so each month is one observation of the quoted price regardless of how
       -- much was bought. A quantity-weighted baseline would answer a different and
       -- also useful question -- effective spend-weighted unit cost, which mixes in
       -- purchasing behaviour. Measured across 210 item-months on the demo data the
       -- two baselines diverge by at most 1.7% and change zero verdicts.
       avg(m.avg_unit_price) filter (where m.observations >= 2) over w3 as baseline_price,
       y.avg_unit_price                as prev_year_price,
       sum(m.qty)             over w12 as trailing_12mo_qty,
       sum(m.spend)           over w12 as trailing_12mo_spend
  from item_monthly m
  left join item_monthly y
    on  y.vendor_id = m.vendor_id
    and y.item_key  = m.item_key
    and y.month     = (m.month - interval '12 months')::date
window
  w   as (partition by m.vendor_id, m.item_key order by m.month),
  w3  as (partition by m.vendor_id, m.item_key order by m.month
          range between interval '3 months' preceding and interval '1 month' preceding),
  w12 as (partition by m.vendor_id, m.item_key order by m.month
          range between interval '11 months' preceding and current row);

-- A unit price that rose at least 8% above its own trailing three-month baseline.
--
-- Annualized impact is the per-unit increase applied to the item's actual
-- trailing-12-month QUANTITY -- "you buy 4,200 of these a year and each now costs
-- $0.34 more". Under the old invoice-average model this multiplied by invoice
-- count instead, which silently assumed order sizes never change.
--
-- Both guards were set by measuring against three years of real spend, where the
-- original rule (5% vs the single prior month, no minimum) produced 11 false
-- positives out of 20 flags:
--
--   observations >= 2  A month with one observation has no average to speak of --
--                      the "monthly average" IS that observation, so ordinary
--                      variation crosses any threshold. A floor of 3 also works
--                      but silently drops real findings from twice-monthly vendors.
--
--   0.08 not 0.05      Measured noise landed at 5.0-6.3% and every genuine increase
--                      at 9.3-17.7%. The gap between them is empty, so the
--                      threshold belongs in it. Tuned to these vendors' volumes and
--                      variance -- re-check against your own. The properly
--                      statistical version scales by each item's own standard error.
-- Confidence is derived from the evidence already on the row, not asserted. Three
-- things make a price finding trustworthy, and each maps to a column:
--
--   basis         is it the right KIND of evidence? A finding resting on invoice
--                 averages cannot separate a price rise from a bigger order, so it
--                 is never better than low however clean the numbers look.
--   observations  is there ENOUGH of it? Two is the floor to have an average at
--                 all; four or more is a month you can lean on.
--   months_held   did it STICK? A one-month spike is as easily a product-mix change
--                 or a one-off as a repricing. An increase still standing months
--                 later is a repricing.
create or replace view price_flags as
with detected as (
  select vendor_id,
         vendor_name,
         item_key,
         item,
         basis,
         (month - interval '3 months')::date as period_start,
         month                               as period_end,
         baseline_price,
         avg_unit_price                      as current_price,
         observations,
         qty,
         trailing_12mo_qty,
         trailing_12mo_spend,
         round((avg_unit_price - baseline_price) / baseline_price * 100, 1)          as pct_change,
         round((avg_unit_price - prev_year_price) / nullif(prev_year_price, 0) * 100, 1) as pct_change_yoy,
         round((avg_unit_price - baseline_price) * trailing_12mo_qty, 2)             as annualized_impact
    from item_changes
   where baseline_price > 0
     and observations >= 2
     and (avg_unit_price - baseline_price) / baseline_price >= 0.08
),
held as (
  -- months at or above 5% over the old baseline, from the flag month onward
  -- ponytail: counts months at the level, not strictly consecutive ones. Prices
  -- rarely fall back so the two agree in practice; make it a gaps-and-islands
  -- query if a vendor ever oscillates across the threshold.
  select d.vendor_id, d.item_key, d.period_end,
         (select count(*) from item_monthly m
           where m.vendor_id = d.vendor_id
             and m.item_key  = d.item_key
             and m.month    >= d.period_end
             and m.avg_unit_price >= d.baseline_price * 1.05) as months_held
    from detected d
)
select d.*,
       h.months_held,
       case
         when d.basis = 'invoice_average'                         then 'low'
         when d.observations >= 4 and h.months_held >= 3          then 'high'
         when d.observations >= 2 and h.months_held >= 2          then 'medium'
         else 'low'
       end as confidence
  from detected d
  join held h
    on h.vendor_id = d.vendor_id and h.item_key = d.item_key and h.period_end = d.period_end;

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
