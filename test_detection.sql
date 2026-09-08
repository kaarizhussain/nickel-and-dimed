-- The check. Run after schema.sql:
--   psql "$DATABASE_URL" -f test_detection.sql
-- or paste into the Supabase SQL editor. Rolls back -- leaves no data behind, so
-- it is safe against a database with real data in it.
--
-- The first block is the important one. Everything else verifies arithmetic; that
-- one verifies the METHODOLOGY -- that a vendor whose invoices grew 210% without
-- ever changing its price does not get reported as a price increase.

begin;

-- ===========================================================================
-- 1. QUANTITY IS NOT PRICE
-- ===========================================================================
-- Decor holds $32.00/unit for eight months while order size climbs 2 -> 6.2
-- units. Invoice totals rise 210%. Pizza holds order size at 3 while unit price
-- steps $31 -> $37. Only the second is a price increase.
--
-- Detecting on avg(invoice total) -- which this project did originally -- flagged
-- decor SEVEN times, peaking at +46.2% and "$921.60/yr", on a price that never
-- moved a cent.

insert into vendors (name) values ('Testfix Qty Decor'), ('Testfix Price Pizza');

do $$
declare v_dec bigint; v_piz bigint; inv bigint; q numeric;
begin
  select id into v_dec from vendors where name = 'Testfix Qty Decor';
  select id into v_piz from vendors where name = 'Testfix Price Pizza';

  for m in 0..7 loop
    q := 2 + m * 0.6;                                   -- order size climbs
    for k in 1..3 loop
      insert into invoices (vendor_id, amount, invoice_date)
      values (v_dec, 0, date '2025-01-05' + (m || ' months')::interval + (k || ' days')::interval)
      returning id into inv;
      insert into invoice_lines (invoice_id, item, qty, unit_price)
      values (inv, 'themed decor kit', q, 32.00);       -- price never moves

      insert into invoices (vendor_id, amount, invoice_date)
      values (v_piz, 0, date '2025-01-05' + (m || ' months')::interval + (k || ' days')::interval)
      returning id into inv;
      insert into invoice_lines (invoice_id, item, qty, unit_price)
      values (inv, 'party pizza', 3, case when m < 5 then 31.00 else 37.00 end);
    end loop;
  end loop;

  -- headers derived from their own lines, the way ingest_invoices does it
  update invoices i set amount = t.total
    from (select invoice_id, sum(line_total) as total from invoice_lines group by 1) t
   where t.invoice_id = i.id and i.vendor_id in (v_dec, v_piz);
end $$;

do $$
declare spend_growth numeric; f record;
begin
  select round((max(spend) - min(spend)) / min(spend) * 100, 0) into spend_growth
    from item_monthly where vendor_name = 'Testfix Qty Decor';
  assert spend_growth > 150,
    format('fixture is wrong: decor spend should climb hard, grew only %s%%', spend_growth);

  assert (select count(distinct avg_unit_price) from item_monthly
           where vendor_name = 'Testfix Qty Decor') = 1,
    'fixture is wrong: decor unit price must never move';

  -- THE ASSERTION THIS PROJECT EXISTS FOR
  assert not exists (select 1 from price_flags where vendor_name = 'Testfix Qty Decor'),
    'a vendor whose invoices grew 210% on a flat unit price must NOT be reported '
    'as a price increase -- that is order size, not pricing';

  select * into f from price_flags
   where vendor_name = 'Testfix Price Pizza' and period_end = date '2025-06-01';
  assert found, 'a real $31 -> $37 unit price step must be caught';
  assert f.basis = 'unit_price', format('basis should be unit_price, got %s', f.basis);
  assert f.pct_change = 19.4, format('pct_change should be 19.4, got %s', f.pct_change);
  -- 3 observations a month and still elevated 3 months later: sustained, but the
  -- month is thinner than the >= 4 observations "high" asks for. Medium is the
  -- honest answer, and this is the assertion that proves the floor bites.
  assert f.confidence = 'medium',
    format('3 observations is sustained but thin -- expected medium, got %s', f.confidence);
  -- 9 units/month x 12 months of trailing history at this point, x $6.00 per unit
  assert f.annualized_impact = 324.00,
    format('annualized_impact should be 324.00, got %s', f.annualized_impact);

  raise notice 'quantity-vs-price ok';
end $$;

-- ===========================================================================
-- 2. THRESHOLD, YEAR-OVER-YEAR ACROSS A GAP, AND THE OBSERVATION FLOOR
-- ===========================================================================

insert into vendors (name) values ('Testfix Coffee Co.'), ('Testfix Napkins');

do $$
declare v_cof bigint; v_nap bigint; inv bigint; d date;
begin
  select id into v_cof from vendors where name = 'Testfix Coffee Co.';
  select id into v_nap from vendors where name = 'Testfix Napkins';

  -- Feb 2024, then a ten-month gap. The gap is the point: lag(price, 12) looks
  -- back twelve ROWS and would find nothing here, so year-over-year has to be a
  -- join on the actual date.
  foreach d in array array[date '2024-02-12', date '2024-02-26',
                               date '2025-01-10', date '2025-01-24'] loop
    insert into invoices (vendor_id, amount, invoice_date) values (v_cof, 0, d) returning id into inv;
    insert into invoice_lines (invoice_id, item, qty, unit_price) values (inv, 'whole bean 5lb', 2, 50.00);
  end loop;
  foreach d in array array[date '2025-02-10', date '2025-02-24'] loop
    insert into invoices (vendor_id, amount, invoice_date) values (v_cof, 0, d) returning id into inv;
    insert into invoice_lines (invoice_id, item, qty, unit_price) values (inv, 'whole bean 5lb', 2, 55.00);
  end loop;

  -- 3%: under the 8% threshold, must stay quiet
  insert into invoices (vendor_id, amount, invoice_date) values (v_nap, 0, date '2025-01-10') returning id into inv;
  insert into invoice_lines (invoice_id, item, qty, unit_price) values (inv, 'napkins', 4, 25.00);
  insert into invoices (vendor_id, amount, invoice_date) values (v_nap, 0, date '2025-01-24') returning id into inv;
  insert into invoice_lines (invoice_id, item, qty, unit_price) values (inv, 'napkins', 4, 25.00);
  insert into invoices (vendor_id, amount, invoice_date) values (v_nap, 0, date '2025-02-10') returning id into inv;
  insert into invoice_lines (invoice_id, item, qty, unit_price) values (inv, 'napkins', 4, 25.75);
  insert into invoices (vendor_id, amount, invoice_date) values (v_nap, 0, date '2025-02-24') returning id into inv;
  insert into invoice_lines (invoice_id, item, qty, unit_price) values (inv, 'napkins', 4, 25.75);

  update invoices i set amount = t.total
    from (select invoice_id, sum(line_total) as total from invoice_lines group by 1) t
   where t.invoice_id = i.id and i.vendor_id in (v_cof, v_nap);
end $$;

do $$
declare f record;
begin
  select * into f from price_flags
   where vendor_name = 'Testfix Coffee Co.' and period_end = date '2025-02-01';

  -- `found`, not `f is not null`: a record IS NOT NULL only when EVERY field is
  -- non-null, and pct_change_yoy is legitimately null whenever there is no
  -- prior-year data. That form reports a missing row when the row is right there.
  assert found, 'a 10% unit-price rise should produce a flag';
  assert f.pct_change = 10.0, format('pct_change should be 10.0, got %s', f.pct_change);
  -- exercises the 12-month self-join across the ten-month gap
  assert f.pct_change_yoy = 10.0, format('pct_change_yoy should be 10.0, got %s', f.pct_change_yoy);
  -- 11-months-preceding RANGE window: Feb 2024 is 12 months back and falls outside
  -- it, so this counts only Jan and Feb 2025 -- 4 invoices x 2 units
  assert f.trailing_12mo_qty = 8, format('trailing_12mo_qty should be 8, got %s', f.trailing_12mo_qty);
  assert f.annualized_impact = 40.00,
    format('annualized_impact should be 40.00, got %s', f.annualized_impact);

  assert not exists (select 1 from price_flags where vendor_name = 'Testfix Napkins'),
    'a 3% increase is under the 8% threshold and must not be flagged';

  raise notice 'threshold and year-over-year ok';
end $$;

-- ===========================================================================
-- 3. THE FALLBACK, AND THAT IT DECLARES ITSELF
-- ===========================================================================
-- A vendor who never itemizes still gets analysed on invoice averages -- but the
-- alert has to carry basis = 'invoice_average' so nobody mistakes it for a
-- unit-price finding. This is the case that cannot distinguish order size from
-- price, and saying so is the point.

insert into vendors (name) values ('Testfix No Lines');

do $$
declare v bigint; d date;
begin
  select id into v from vendors where name = 'Testfix No Lines';
  foreach d in array array[date '2025-01-08', date '2025-01-22',
                               date '2025-02-08', date '2025-02-22',
                               date '2025-03-08', date '2025-03-22',
                               date '2025-04-08', date '2025-04-22'] loop
    insert into invoices (vendor_id, amount, invoice_date)
    values (v, case when d < date '2025-04-01' then 100.00 else 130.00 end, d);
  end loop;
end $$;

do $$
declare f record;
begin
  select * into f from price_flags
   where vendor_name = 'Testfix No Lines' and period_end = date '2025-04-01';
  assert found, 'a vendor without line items should still be analysed';
  assert f.basis = 'invoice_average',
    format('basis must declare the weaker evidence, got %s', f.basis);
  assert f.item = '(whole invoice)',
    format('unitless fallback should say so, got %s', f.item);
  -- invoice averages cannot separate price from order size, so however clean the
  -- numbers look this evidence is never better than low
  assert f.confidence = 'low',
    format('an invoice-average finding can never exceed low confidence, got %s', f.confidence);
  assert f.pct_change = 30.0, format('pct_change should be 30.0, got %s', f.pct_change);

  raise notice 'invoice-average fallback ok';
end $$;

-- ===========================================================================
-- 4. INGEST: NORMALIZATION, LINE ITEMS, AND DERIVED TOTALS
-- ===========================================================================

do $$
declare n integer;
begin
  n := ingest_invoices('[
    {"vendor_name":"ACME Supply Co.","invoice_date":"2025-01-05","category":"supplies","confidence":"high","raw_input":"line 1",
     "lines":[{"item":"paper goods","qty":2,"unit_price":50.00},{"item":"cups","qty":1,"unit_price":12.50}]},
    {"vendor_name":"Acme Supply","invoice_date":"2025-02-05","category":"Supplies","confidence":"high","raw_input":"line 2",
     "lines":[{"item":"Paper Goods","qty":2,"unit_price":55.00}]},
    {"vendor_name":"ACME SUPPLY CO","invoice_date":"2025-03-05","category":"totally made up","confidence":"low","raw_input":"line 3",
     "lines":[{"item":"paper goods","qty":3,"unit_price":55.00}]},
    {"vendor_name":null,"amount":99.00,"invoice_date":"2025-01-07","category":"supplies","confidence":"low","raw_input":"junk row"}
  ]'::jsonb);

  assert n = 3, format('3 of the 4 rows are real invoices, got %s', n);
  assert (select count(*) from vendors where normalized_name = 'acme supply') = 1,
    'three spellings of ACME must collapse to one vendor';
  -- "paper goods" and "Paper Goods" are the same product
  assert (select count(distinct item_key) from invoice_lines l
            join invoices i on i.id = l.invoice_id
            join vendors v on v.id = i.vendor_id
           where v.normalized_name = 'acme supply') = 2,
    'paper goods and Paper Goods are one comparable item, cups is another';
  -- header total is derived from the lines, so the two can never disagree
  assert (select amount from invoices where raw_input = 'line 1') = 112.50,
    'invoice total must be derived from its own line items';
  assert (select category from invoices where raw_input = 'line 3') = 'other',
    'an off-list category must fall back to other, not fail the batch';

  raise notice 'ingest ok';
end $$;

rollback;
