-- Stock ledger, delivery confirmation, consumption, alerts, prediction.
\set QUIET on
insert into tests.ctx values
  ('sup_user', tests.create_user('sup@test.in', 'supplier', 'Ravi')),
  ('cust_user', tests.create_user('cust@test.in', 'customer', 'Meena')),
  ('cust2_user', tests.create_user('cust2@test.in', 'customer', 'Arun'));

-- Supplier registers
select tests.login((select v from tests.ctx where k = 'sup_user'));
set role authenticated;
insert into tests.ctx select 'supplier', (public.register_supplier('Blue Spring Waters', 'Ravi', '9876543210',
  'sup@test.in', '12 Anna Salai, Chennai', 'T Nagar', 40)).id;
select tests.eq((select count(*)::int from public.supplier_settings), 1, 'supplier settings created');
reset role;

-- Customer connects with opening stock 5 (spec scenario)
select tests.login((select v from tests.ctx where k = 'cust_user'));
set role authenticated;
select tests.throws($$select public.connect_to_supplier('Meena', '9876500000', '4 Lake View Rd', null, 'NOPE1234', null, 5, 2)$$,
  'not found', 'cannot connect with an unknown supplier code');
select tests.throws($$select public.connect_to_supplier('Meena', '9876500000', '4 Lake View Rd', null, null, null, 5, 2)$$,
  'required', 'a code or invite is required to connect');
insert into tests.ctx select 'customer', (public.connect_to_supplier('Meena', '9876500000', '4 Lake View Rd', 'Ring bell',
  tests.supplier_code(), null, 5, 2)).id;
select tests.eq((select current_stock from public.customer_stock), 5, 'opening stock = 5');
reset role;

-- Supplier records delivery: expected 10, actual 8
select tests.login((select v from tests.ctx where k = 'sup_user'));
set role authenticated;
insert into tests.ctx select 'delivery1', (public.record_delivery((select v from tests.ctx where k = 'customer'), 10, 8)).id;
select tests.eq((select current_stock from public.customer_stock), 5, 'stock unchanged until customer confirms');
select tests.eq((select status::text from public.deliveries), 'awaiting_confirmation', 'delivery awaits confirmation');
select tests.throws(format('select public.confirm_delivery(%L, 8)', (select v from tests.ctx where k = 'delivery1')),
  'Not allowed', 'supplier cannot confirm on behalf of an app customer');
reset role;

-- Customer confirms 8
select tests.login((select v from tests.ctx where k = 'cust_user'));
set role authenticated;
select tests.eq((select count(*)::int from public.notifications where notification_type = 'delivery_confirmation_required'),
  1, 'customer notified to confirm delivery');
select public.confirm_delivery((select v from tests.ctx where k = 'delivery1'), 8);
select tests.eq((select current_stock from public.customer_stock), 13, 'stock after delivery = 13 (5 + 8 confirmed)');
select tests.throws(format('select public.confirm_delivery(%L, 8)', (select v from tests.ctx where k = 'delivery1')),
  'already been confirmed', 'duplicate confirmation is rejected');
select tests.eq((select current_stock from public.customer_stock), 13, 'stock still 13 after duplicate attempt');
select tests.eq((select discrepancy from public.deliveries), -2, 'shortage of 2 vs expected recorded');

-- Daily consumption 2 cans: day 1 → 11, day 2 → 9
select public.record_consumption((select v from tests.ctx where k = 'customer'), 2, public.customer_local_date((select v from tests.ctx where k = 'customer')) - 1);
select tests.eq((select current_stock from public.customer_stock), 11, 'after one day = 11');
select public.record_consumption((select v from tests.ctx where k = 'customer'), 2);
select tests.eq((select current_stock from public.customer_stock), 9, 'after two days = 9');

-- Editing a day sets the total (no duplicate record, only the delta hits the ledger)
select public.record_consumption((select v from tests.ctx where k = 'customer'), 3);
select tests.eq((select current_stock from public.customer_stock), 8, 'editing today 2→3 reduces stock by 1 only');
select tests.eq((select count(*)::int from public.consumption_records), 2, 'still one record per day');
select public.record_consumption((select v from tests.ctx where k = 'customer'), 2);
select tests.eq((select current_stock from public.customer_stock), 9, 'correcting back 3→2 returns 1 can');
select tests.throws(format('select public.record_consumption(%L, 1, current_date + 5)', (select v from tests.ctx where k = 'customer')),
  'future', 'future consumption rejected');
select tests.throws(format('select public.record_consumption(%L, 1, current_date - 30)', (select v from tests.ctx where k = 'customer')),
  'correction request', 'old entries need a correction request');

-- Ledger is append-only and cannot be written directly
select tests.throws($$insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity)
  select supplier_id, id, 'delivery_received', 100 from public.customers$$, 'permission denied', 'customer cannot insert ledger rows');
select tests.throws($$update public.customer_stock set current_stock = 999$$, 'permission denied', 'customer cannot edit stock');
select tests.throws($$update public.deliveries set confirmed_quantity = 50$$, 'permission denied', 'customer cannot edit deliveries');
reset role;
select tests.throws($$update public.inventory_transactions set quantity = 50$$, 'append-only', 'ledger is append-only even for owner');

-- Ledger sum equals cached balance
select tests.eq((select sum(quantity)::int from public.inventory_transactions), 9, 'ledger sum = 9');
select tests.eq((select balance_after from public.inventory_transactions order by created_at desc limit 1), 9, 'balance_after trail correct');

-- Prediction: 3 days of history needed; with 2 days falls back to configured 2/day
select tests.eq((public.compute_prediction((select v from tests.ctx where k = 'customer')) ->> 'basis'), 'configured', 'fallback to configured consumption');
select tests.eq((public.compute_prediction((select v from tests.ctx where k = 'customer')) ->> 'days_remaining')::numeric, 4.5, '9 cans / 2 per day = 4.5 days');
select tests.eq((public.compute_prediction((select v from tests.ctx where k = 'customer')) ->> 'predicted_empty_date')::date,
  public.customer_local_date((select v from tests.ctx where k = 'customer')) + 4, 'predicted empty date = today + 4');

-- Consuming more than available: stock floors at 0 with a stockout event
select tests.login((select v from tests.ctx where k = 'cust_user'));
set role authenticated;
select public.record_consumption((select v from tests.ctx where k = 'customer'), 7, public.customer_local_date((select v from tests.ctx where k = 'customer')) - 2);
select tests.eq((select current_stock from public.customer_stock), 2, 'stock 9 - 7 = 2');
select tests.eq((select alert_level::text from public.customer_stock), 'low', 'low alert state at 2 cans (threshold 3)');
select tests.eq((select count(*)::int from public.notifications where notification_type = 'low_stock'), 1, 'one low-stock alert');
select public.record_consumption((select v from tests.ctx where k = 'customer'), 6);
select tests.eq((select current_stock from public.customer_stock), 0, 'stock never negative (today 2 → 6 with only 2 cans left)');
select tests.eq((select unmet_quantity from public.consumption_records where consumption_date = public.customer_local_date((select v from tests.ctx where k = 'customer'))), 2,
  'unmet demand of 2 recorded');
reset role;
select tests.eq((select count(*)::int from public.inventory_transactions where transaction_type = 'stockout'), 1, 'stockout event recorded');
select tests.eq((select alert_level::text from public.customer_stock), 'critical', 'critical alert state at 0');
select tests.eq((select count(*)::int from public.notifications n join public.customers c on c.user_id = n.user_id where n.notification_type = 'critical_stock'),
  1, 'exactly one critical alert to customer');
select tests.eq((select count(*)::int from public.notifications n join public.suppliers s on s.owner_id = n.user_id where n.notification_type = 'critical_stock'),
  1, 'supplier told about critical customer');
-- more consumption at 0 stock does not re-alert
select tests.login((select v from tests.ctx where k = 'cust_user'));
set role authenticated;
select public.record_consumption((select v from tests.ctx where k = 'customer'), 7);
select tests.eq((select unmet_quantity from public.consumption_records order by consumption_date desc limit 1), 3, 'unmet grows to 3');
select public.record_consumption((select v from tests.ctx where k = 'customer'), 5);
select tests.eq((select unmet_quantity from public.consumption_records order by consumption_date desc limit 1), 1, 'lowering reduces unmet first');
select tests.eq((select current_stock from public.customer_stock), 0, 'no cans returned while unmet remains');
reset role;
select tests.eq((select count(*)::int from public.notifications where notification_type = 'critical_stock'), 2, 'no duplicate critical alerts');

-- Delivery adjustment: never overwrites, creates a record + ledger delta
select tests.login((select v from tests.ctx where k = 'sup_user'));
set role authenticated;
select tests.throws(format('select public.adjust_delivery(%L, 7, %L)', (select v from tests.ctx where k = 'delivery1'), ''),
  'reason', 'adjustment requires a reason');
select public.adjust_delivery((select v from tests.ctx where k = 'delivery1'), 9, 'One can found in van, delivered late');
reset role;
select tests.eq((select current_stock from public.customer_stock), 1, 'adjustment +1 hits stock');
select tests.eq((select confirmed_quantity from public.deliveries), 8, 'original confirmed quantity preserved');
select tests.eq((select adjusted_quantity from public.deliveries), 1, 'adjustment tracked on delivery');
select tests.eq((select count(*)::int from public.delivery_adjustments), 1, 'adjustment record stored');
select tests.eq((select adjusted_by from public.delivery_adjustments), (select v from tests.ctx where k = 'sup_user'), 'adjustment records who made it');
select tests.throws($$update public.deliveries set confirmed_quantity = 3$$, 'cannot be edited', 'confirmed delivery frozen');

-- Alert state resets when stock rises above threshold, so next drop alerts again
select tests.login((select v from tests.ctx where k = 'sup_user'));
set role authenticated;
insert into tests.ctx select 'delivery2', (public.record_delivery((select v from tests.ctx where k = 'customer'), 10, 10)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'cust_user'));
set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'delivery2'), 10);
reset role;
select tests.eq((select current_stock from public.customer_stock), 11, '1 + 10 = 11');
select tests.eq((select alert_level::text from public.customer_stock), 'none', 'alert state reset above threshold');

-- Auto consumption: idempotent, never duplicates a day
update public.customers set auto_consumption_enabled = true, auto_consumption_since = current_date - 10,
  auto_consumption_time = '00:00', daily_consumption = 1;
delete from public.job_runs;
select public.process_auto_consumption();
select public.process_auto_consumption();
select tests.eq((select count(*)::int from public.consumption_records where source = 'auto'), 0,
  'auto skips days that already have manual entries');
-- remove today's/past manual entries? use a fresh customer instead:
select tests.login((select v from tests.ctx where k = 'cust2_user'));
set role authenticated;
insert into tests.ctx select 'customer2', (public.connect_to_supplier('Arun', '9876500001', '9 Hill St', null,
  tests.supplier_code(), null, 10, 2)).id;
select public.update_my_customer_settings((select v from tests.ctx where k = 'customer2'), p_auto_consumption_enabled => true,
  p_auto_consumption_time => '00:00', p_daily_consumption => 2);
reset role;
select public.process_auto_consumption();
select public.process_auto_consumption();
select tests.eq((select count(*)::int from public.consumption_records where customer_id = (select v from tests.ctx where k = 'customer2')), 1,
  'auto consumption creates exactly one record for today');
select tests.eq((select current_stock from public.customer_stock where customer_id = (select v from tests.ctx where k = 'customer2')), 8,
  'auto consumption reduced stock 10 → 8');

-- Alternative spec path: customer confirms only 7 of 10 → stock 12
select tests.login((select v from tests.ctx where k = 'sup_user'));
set role authenticated;
insert into tests.ctx select 'customer3', (public.supplier_add_customer('Offline Kumar', '9876500002', '1 Market Rd', null, null, 0, 5)).id;
reset role;
-- emulate an app customer for the 7-can path using customer2 history
insert into tests.ctx values ('cust4_user', tests.create_user('cust4@test.in', 'customer', 'Divya'));
select tests.login((select v from tests.ctx where k = 'cust4_user'));
set role authenticated;
insert into tests.ctx select 'customer4', (public.connect_to_supplier('Divya', '9876500003', '7 Beach Rd', null,
  tests.supplier_code(), null, 5, 2)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'sup_user'));
set role authenticated;
insert into tests.ctx select 'delivery4', (public.record_delivery((select v from tests.ctx where k = 'customer4'), 10, 10)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'cust4_user'));
set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'delivery4'), 7, 'Only 7 cans were left at the gate');
select tests.eq((select current_stock from public.customer_stock where customer_id = (select v from tests.ctx where k = 'customer4')), 12,
  'supplier recorded 10 but customer confirmed 7 → stock 12');
reset role;
select tests.eq((select claim_gap from public.deliveries where id = (select v from tests.ctx where k = 'delivery4')), -3,
  'supplier claim gap of 3 recorded for accuracy reporting');
select tests.eq((select count(*)::int from public.notifications where notification_type = 'delivery_shortage'), 2,
  'supplier notified of shortages');

-- Offline customer deliveries are supplier-confirmed (and flagged)
select tests.login((select v from tests.ctx where k = 'sup_user'));
set role authenticated;
select public.record_delivery((select v from tests.ctx where k = 'customer3'), 4, 4);
reset role;
select tests.eq((select current_stock from public.customer_stock where customer_id = (select v from tests.ctx where k = 'customer3')), 9,
  'offline customer 5 + 4 = 9');
select tests.eq((select confirmed_by_supplier from public.deliveries where customer_id = (select v from tests.ctx where k = 'customer3')), true,
  'offline confirmation flagged as supplier-confirmed');

-- Prediction with lead time: 2 cans, 2/day, lead 1 → order now
update public.customer_stock set current_stock = 2 where customer_id = (select v from tests.ctx where k = 'customer3');
update public.customers set daily_consumption = 2, safety_stock = 2 where id = (select v from tests.ctx where k = 'customer3');
select tests.eq((public.compute_prediction((select v from tests.ctx where k = 'customer3')) ->> 'order_now')::boolean, true,
  '2 cans @ 2/day with 1-day lead time → order now');
select tests.eq((public.compute_prediction((select v from tests.ctx where k = 'customer3')) ->> 'recommended_order_quantity')::int, 2,
  'recommended = 2*1 lead + 2 safety - 2 stock = 2');
update public.customers set daily_consumption = 0 where id = (select v from tests.ctx where k = 'customer3');
select tests.eq((public.compute_prediction((select v from tests.ctx where k = 'customer3')) ->> 'days_remaining'), null,
  'no consumption data → no false prediction');
