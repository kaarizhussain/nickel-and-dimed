-- Nickel and Dimed schema. Paste into the Supabase SQL editor, or: psql "$DATABASE_URL" -f schema.sql
--
-- Two tables (vendors, invoices). price_flags is a VIEW, not a table: detection is
-- derived from invoices, so there is no write path and it can never go stale.
-- All the detection math lives here rather than in JS -- that is the point.

-- ---------------------------------------------------------------- normalization

-- Collapses "ACME Supply" / "Acme Supply Co." to one key. This is the exact-dedup
-- safety net; the fuzzy matching happens in the extraction prompt, which sees the
-- existing vendor list.
-- ponytail: word-list suffix strip. A vendor genuinely named "Co Op Market" loses
-- its "Co". Swap in pg_trgm similarity if that ever bites.
create or replace function norm(t text) returns text
language sql immutable strict as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(t), '\y(co|inc|llc|ltd|corp|corporation|company)\y\.?', '', 'g'),
    '[^a-z0-9 ]', '', 'g'),
  '\s+', ' ', 'g'))
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
  line_items   jsonb,
  raw_input    text,
  confidence   text check (confidence in ('low','medium','high')),
  created_at   timestamptz not null default now()
);
create index if not exists invoices_vendor_date on invoices (vendor_id, invoice_date);

-- No auth in v1, and the browser never talks to Supabase directly -- the Node API
-- holds the secret key. RLS on with zero policies means anon/authenticated
-- get nothing even if the URL and anon key leak.
alter table vendors  enable row level security;
alter table invoices enable row level security;

-- --------------------------------------------------------------------- ingest

-- One round trip: upsert vendors, then insert invoices joined to them.
create or replace function ingest_invoices(payload jsonb)
returns integer
language plpgsql as $$
declare inserted integer;
begin
  drop table if exists _batch;
  create temp table _batch on commit drop as
  select * from jsonb_to_recordset(payload) as r(
    vendor_name  text,
    amount       numeric,
    invoice_date date,
    category     text,
    line_items   jsonb,
    confidence   text,
    raw_input    text
  );

  delete from _batch
   where vendor_name is null or amount is null or invoice_date is null;

  insert into vendors (name, category)
  select distinct on (norm(vendor_name)) vendor_name, category
    from _batch
   order by norm(vendor_name), length(vendor_name) desc  -- keep the fullest spelling
  on conflict (normalized_name) do nothing;

  insert into invoices (vendor_id, amount, invoice_date, category, line_items, confidence, raw_input)
  select v.id,
         b.amount,
         b.invoice_date,
         -- an off-list category would fail the check constraint and kill the whole
         -- batch; anything unrecognized lands in 'other'
         case when lower(b.category) in ('food and beverage','supplies','apparel','services','utilities')
              then lower(b.category) else 'other' end,
         b.line_items,
         b.confidence,
         b.raw_input
    from _batch b
    join vendors v on v.normalized_name = norm(b.vendor_name);

  get diagnostics inserted = row_count;
  return inserted;
end $$;

-- ------------------------------------------------------------------ detection

create or replace view vendor_monthly as
select v.id                                     as vendor_id,
       v.name                                   as vendor_name,
       date_trunc('month', i.invoice_date)::date as month,
       sum(i.amount)                            as spend,
       count(*)::int                            as invoice_count,
       round(avg(i.amount), 2)                  as avg_invoice
  from invoices i
  join vendors v on v.id = i.vendor_id
 group by 1, 2, 3;

-- Month-over-month via lag(). Year-over-year via a self-join on an exact 12-month
-- offset, NOT lag(..., 12): a vendor with any gap in its history would have
-- lag-12-rows silently compare the wrong months.
create or replace view vendor_changes as
select m.vendor_id,
       m.vendor_name,
       m.month,
       m.spend,
       m.invoice_count,
       m.avg_invoice,
       lag(m.avg_invoice)   over w   as prev_month_avg,
       -- Detection compares against the THREE months before this one, not just the
       -- last one. A single prior month is itself a noisy estimate, so comparing
       -- one noisy number against another roughly doubles the noise in the
       -- difference -- which is how a vendor with no trend at all produced a $301
       -- "finding" on real data.
       avg(m.avg_invoice)   over w3  as baseline_avg,
       y.avg_invoice                 as prev_year_avg,
       sum(m.spend)         over w12 as trailing_12mo_spend,
       sum(m.invoice_count) over w12 as trailing_12mo_invoices
  from vendor_monthly m
  left join vendor_monthly y
    on  y.vendor_id = m.vendor_id
    and y.month     = (m.month - interval '12 months')::date
window
  w   as (partition by m.vendor_id order by m.month),
  w3  as (partition by m.vendor_id order by m.month
          range between interval '3 months' preceding and interval '1 month' preceding),
  w12 as (partition by m.vendor_id order by m.month
          range between interval '11 months' preceding and current row);

-- Every month a vendor's average invoice rose at least 8% above its own trailing
-- three-month baseline. Annualized impact = the per-invoice increase applied to
-- the vendor's actual trailing-12-month invoice volume: "if this holds, it costs
-- you $X a year."
--
-- Both guards below were added after measuring against three years of real spend,
-- where the original rule (5% vs the single prior month, no minimum) produced 11
-- false positives out of 20 flags:
--
--   invoice_count >= 2  A month with one invoice has no average to speak of -- the
--                       "monthly average" IS that invoice, so ordinary variation
--                       crosses any threshold. Two vendors fired 10 times between
--                       them on completely flat prices. A floor of 3 also works but
--                       silently drops a real finding from any twice-monthly vendor.
--
--   0.08 not 0.05       Measured on real data, noise landed at 5.0-6.3% and every
--                       genuine increase at 9.3-17.7%. The gap between them is
--                       empty, so the threshold belongs in it. This is tuned to
--                       these vendors' invoice volumes and variance -- re-check it
--                       against your own before trusting it. The statistically
--                       proper version scales the threshold by each vendor's own
--                       standard error instead of using one fixed number.
create or replace view price_flags as
select vendor_id,
       vendor_name,
       (month - interval '3 months')::date as period_start,
       month                               as period_end,
       baseline_avg,
       prev_month_avg,
       avg_invoice                         as current_avg,
       invoice_count,
       trailing_12mo_spend,
       trailing_12mo_invoices,
       round((avg_invoice - baseline_avg) / baseline_avg * 100, 1)              as pct_change,
       round((avg_invoice - prev_year_avg) / nullif(prev_year_avg, 0) * 100, 1) as pct_change_yoy,
       round((avg_invoice - baseline_avg) * trailing_12mo_invoices, 2)          as annualized_impact
  from vendor_changes
 where baseline_avg > 0
   and invoice_count >= 2
   and (avg_invoice - baseline_avg) / baseline_avg >= 0.08;

-- What the dashboard reads: each vendor's most recent flag, ranked by annual cost.
create or replace view vendor_alerts as
select *, rank() over (order by annualized_impact desc) as impact_rank
  from (select distinct on (vendor_id) *
          from price_flags
         order by vendor_id, period_end desc) latest
 order by impact_rank;

-- Views default to running as their owner, which bypasses the RLS above.
alter view vendor_monthly  set (security_invoker = on);
alter view vendor_changes  set (security_invoker = on);
alter view price_flags     set (security_invoker = on);
alter view vendor_alerts   set (security_invoker = on);
