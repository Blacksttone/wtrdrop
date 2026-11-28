-- Weekly stock check, supplier map columns, first-come orders
insert into tests.ctx values
  ('sup', tests.create_user('s@sc.in', 'supplier', 'Ravi')),
  ('cust', tests.create_user('c@sc.in', 'customer', 'Meena')),
  ('fam', tests.create_user('f@sc.in', 'customer', 'Amma')),
  ('cust2', tests.create_user('c2@sc.in', 'customer', 'Raja')),
  ('other', tests.create_user('o@sc.in', 'customer', 'Other'));
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select public.register_supplier('Blue Waters', 'Ravi', '9400000001', null, 'Anna Nagar', 'Anna Nagar', 40);
reset role;
select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
insert into tests.ctx select 'c', (public.connect_to_supplier('Meena', '9400000010', '4 Lake View', null, tests.supplier_code(1), null, 10, 2)).id;
create temp table _inv as select (public.create_member_invite((select account_id from public.customers limit 1), 'member')).code;
reset role;
grant select on _inv to authenticated;
select tests.login((select v from tests.ctx where k = 'fam')); set role authenticated;
select public.join_customer_account((select code from _inv));
reset role;
select tests.login((select v from tests.ctx where k = 'cust2')); set role authenticated;
insert into tests.ctx select 'c2', (public.connect_to_supplier('Raja', '9400000011', '9 Hill Rd', null, tests.supplier_code(1), null, null, 2)).id;
reset role;

-- Customer counts fewer cans than the app thinks
select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
select tests.eq((public.customer_stock_check((select v from tests.ctx where k = 'c'), 6) ->> 'change')::int, -4, 'counted 6 vs 10: change −4');
select tests.eq((select current_stock from public.customer_stock where customer_id = (select v from tests.ctx where k = 'c')), 6, 'stock corrected to 6');
select tests.throws(format('select public.customer_stock_check(%L, -1)', (select v from tests.ctx where k = 'c')), 'between 0 and 1000', 'negative count rejected');
reset role;
select tests.eq((select count(*)::int from public.notifications where notification_type = 'stock_check'), 1, 'supplier told about a big difference');
-- Same count again: no new ledger row
select tests.login((select v from tests.ctx where k = 'fam')); set role authenticated;
select tests.eq((public.customer_stock_check((select v from tests.ctx where k = 'c'), 6) ->> 'change')::int, 0, 'family member can do the check; no change');
reset role;
select tests.eq((select count(*)::int from public.inventory_transactions where customer_id = (select v from tests.ctx where k = 'c') and transaction_type = 'adjustment'), 1, 'only one correction entry');
-- First count for a customer with no stock yet = opening stock
select tests.login((select v from tests.ctx where k = 'cust2')); set role authenticated;
select public.customer_stock_check((select v from tests.ctx where k = 'c2'), 3);
reset role;
select tests.eq((select transaction_type::text from public.inventory_transactions where customer_id = (select v from tests.ctx where k = 'c2')), 'opening_stock', 'first count becomes opening stock');
-- Outsiders blocked
select tests.login((select v from tests.ctx where k = 'other')); set role authenticated;
select tests.throws(format('select public.customer_stock_check(%L, 1)', (select v from tests.ctx where k = 'c')), 'Not allowed', 'outsider cannot change stock');
reset role;

-- Sunday job: one notification per member per week (owner + family member + other customer)
select public.run_weekly_stock_check(now());
select public.run_weekly_stock_check(now());
select tests.eq((select count(*)::int from public.notifications where notification_type = 'stock_check' and link = '/app?stockcheck=1'), 3, 'weekly reminder once per person per week');

-- Supplier list carries map coordinates
select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
select public.set_customer_location((select v from tests.ctx where k = 'c'), 13.08, 80.21, 10);
reset role;
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select tests.eq((select latitude from public.list_supplier_customers() where id = (select v from tests.ctx where k = 'c')), 13.08::double precision, 'supplier list has the location for the map');
select tests.eq((select current_stock from public.list_supplier_customers() where id = (select v from tests.ctx where k = 'c')), 6, 'map shows the counted stock');
reset role;

-- First come, first served on the dashboard
select tests.login((select v from tests.ctx where k = 'cust2')); set role authenticated;
select public.place_order((select v from tests.ctx where k = 'c2'), 2);
reset role;
select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
select public.place_order((select v from tests.ctx where k = 'c'), 3);
reset role;
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select tests.eq((select public.get_supplier_dashboard() -> 'needs_delivery_today' -> 0 ->> 'customer_name'), 'Raja', 'oldest order is first');
reset role;
