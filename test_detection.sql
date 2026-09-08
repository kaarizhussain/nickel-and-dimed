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

  assert f is not null,
    'a 10% jump should produce a flag';
  assert f.pct_change_mom = 10.0,
    format('pct_change_mom should be 10.0, got %s', f.pct_change_mom);
  assert f.trailing_12mo_invoices = 4,
    format('trailing_12mo_invoices should be 4, got %s', f.trailing_12mo_invoices);
  assert f.annualized_impact = 40.00,
    format('annualized_impact should be 40.00, got %s', f.annualized_impact);
  assert not exists (select 1 from price_flags where vendor_name = 'Testfix Napkins'),
    'a 3% increase is under the 5% threshold and must not be flagged';

  raise notice 'detection ok';
end $$;

rollback;
