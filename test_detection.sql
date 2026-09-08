-- The one check. Run after schema.sql:
--   psql "$DATABASE_URL" -f test_detection.sql
-- or paste into the Supabase SQL editor. Rolls back -- leaves no data behind.
--
-- Fails loudly if the detection math breaks: percent change, the 5% threshold,
-- or the trailing-12-month volume that annualized impact multiplies by.

begin;

insert into vendors (name) values ('Testfix Coffee Co.'), ('Testfix Napkins');

insert into invoices (vendor_id, amount, invoice_date)
select v.id, x.amt, x.d
  from vendors v
  join (values
    -- Feb 2024, then a ten-month gap. The gap is the point: lag(avg_invoice, 12)
    -- looks back twelve ROWS and would find nothing here, so year-over-year has
    -- to be a join on the actual date.
    ('Testfix Coffee Co.', 100.00, date '2024-02-12'),
    ('Testfix Coffee Co.', 100.00, date '2024-02-26'),
    -- avg invoice: Jan $100 -> Feb $110, on 4 invoices/yr => +$40/yr
    ('Testfix Coffee Co.', 100.00, date '2025-01-10'),
    ('Testfix Coffee Co.', 100.00, date '2025-01-24'),
    ('Testfix Coffee Co.', 110.00, date '2025-02-10'),
    ('Testfix Coffee Co.', 110.00, date '2025-02-24'),
    -- 3%: under threshold, must stay quiet
    ('Testfix Napkins',    100.00, date '2025-01-10'),
    ('Testfix Napkins',    103.00, date '2025-02-10')
  ) as x(nm, amt, d) on v.name = x.nm;

do $$
declare f record;
begin
  select * into f
    from price_flags
   where vendor_name = 'Testfix Coffee Co.'
     and period_end  = date '2025-02-01';

  -- `found`, not `f is not null`: a record IS NOT NULL only when EVERY field is
  -- non-null, and pct_change_yoy is legitimately null whenever there is no
  -- prior-year data. That form reports a missing row when the row is right there.
  assert found,
    'a 10% jump should produce a flag';
  assert f.pct_change_mom = 10.0,
    format('pct_change_mom should be 10.0, got %s', f.pct_change_mom);
  -- exercises the 12-month self-join across the gap year
  assert f.pct_change_yoy = 10.0,
    format('pct_change_yoy should be 10.0, got %s', f.pct_change_yoy);
  -- 11-months-preceding RANGE window: Feb 2024 is 12 months back and must fall
  -- outside it, so this stays 4 rather than counting all six invoices
  assert f.trailing_12mo_invoices = 4,
    format('trailing_12mo_invoices should be 4, got %s', f.trailing_12mo_invoices);
  assert f.annualized_impact = 40.00,
    format('annualized_impact should be 40.00, got %s', f.annualized_impact);
  assert not exists (select 1 from price_flags where vendor_name = 'Testfix Napkins'),
    'a 3% increase is under the 5% threshold and must not be flagged';

  raise notice 'detection ok';
end $$;

-- Ingest and vendor normalization: three spellings of one vendor have to collapse
-- to a single row, an off-list category has to fall back rather than fail the
-- whole batch on the check constraint, and a row with no vendor has to be dropped
-- rather than taking its batch down with it.
do $$
declare n integer;
begin
  n := ingest_invoices('[
    {"vendor_name":"ACME Supply Co.","amount":100.00,"invoice_date":"2025-01-05","category":"supplies","confidence":"high","raw_input":"line 1"},
    {"vendor_name":"Acme Supply","amount":110.00,"invoice_date":"2025-02-05","category":"Supplies","confidence":"high","raw_input":"line 2"},
    {"vendor_name":"ACME SUPPLY CO","amount":120.00,"invoice_date":"2025-03-05","category":"totally made up","confidence":"low","raw_input":"line 3"},
    {"vendor_name":null,"amount":99.00,"invoice_date":"2025-01-07","category":"supplies","confidence":"low","raw_input":"junk row"}
  ]'::jsonb);

  assert n = 3,
    format('3 of the 4 rows are real invoices, got %s', n);
  assert (select count(*) from vendors where normalized_name = 'acme supply') = 1,
    'three spellings of ACME must collapse to one vendor';
  assert (select count(*) from invoices i
            join vendors v on v.id = i.vendor_id
           where v.normalized_name = 'acme supply') = 3,
    'all three ACME invoices must attach to that one vendor';
  assert (select category from invoices where raw_input = 'line 3') = 'other',
    'an off-list category must fall back to other, not fail the batch';

  raise notice 'ingest ok';
end $$;

rollback;
