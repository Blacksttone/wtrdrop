-- Monthly billing from confirmed deliveries, payments, idempotency
insert into tests.ctx values
  ('sup_user', tests.create_user('s@b.in', 'supplier', 'Kannan')),
  ('cust_user', tests.create_user('c@b.in', 'customer', 'Priya'));
select tests.login((select v from tests.ctx where k = 'sup_user')); set role authenticated;
insert into tests.ctx select 'supplier', (public.register_supplier('Crystal Cans', 'Kannan', '9000000011', null, '5 Bypass Rd, Coimbatore', null, 40)).id;
update public.supplier_settings set billing_day = 1, billing_due_days = 10;
reset role;
select tests.login((select v from tests.ctx where k = 'cust_user')); set role authenticated;
insert into tests.ctx select 'customer', (public.connect_to_supplier('Priya', '9000000012', '3 Race Course Rd', null, tests.supplier_code(), null, 5, 2)).id;
reset role;

-- Two deliveries last month: (exp 10, actual 8, confirmed 8) and (exp 5, actual 5, confirmed 4)
select tests.login((select v from tests.ctx where k = 'sup_user')); set role authenticated;
insert into tests.ctx select 'd1', (public.record_delivery((select v from tests.ctx where k = 'customer'), 10, 8, (date_trunc('month', current_date) - interval '20 days')::date)).id;
insert into tests.ctx select 'd2', (public.record_delivery((select v from tests.ctx where k = 'customer'), 5, 5, (date_trunc('month', current_date) - interval '10 days')::date)).id;
insert into tests.ctx select 'd3', (public.record_delivery((select v from tests.ctx where k = 'customer'), 6, 6, (date_trunc('month', current_date) - interval '5 days')::date)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'cust_user')); set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'd1'), 8);
select public.confirm_delivery((select v from tests.ctx where k = 'd2'), 4);
-- d3 left unconfirmed: must NOT be billed
-- lots of consumption: must NOT affect the bill
select public.record_consumption((select v from tests.ctx where k = 'customer'), 6);
reset role;

-- Supplier cannot write invoices directly
select tests.login((select v from tests.ctx where k = 'sup_user')); set role authenticated;
select tests.throws($$insert into public.invoices (supplier_id, customer_id, invoice_number, invoice_date, billing_period_start, billing_period_end, due_date)
  select supplier_id, id, 'X', current_date, current_date, current_date, current_date from public.customers$$, 'permission denied', 'no direct invoice inserts');
select tests.throws($$select public.generate_invoices()$$, 'permission denied', 'clients cannot call the billing job directly');
select public.run_my_billing();
select public.run_my_billing();  -- idempotent re-run
reset role;
select tests.eq((public.run_monthly_billing(current_date) ->> 'errors'), '[]', 'billing ran without errors');  -- cron re-run
select tests.eq((select count(*)::int from public.invoices), 1, 'exactly one invoice after 3 billing runs');
select tests.eq((select total_quantity from public.invoices), 12, 'bill uses confirmed quantities only (8 + 4)');
select tests.eq((select subtotal from public.invoices), 480.00::numeric, '12 cans × ₹40 = ₹480');
select tests.eq((select amount_due from public.invoices), 480.00::numeric, 'amount due ₹480');
select tests.eq((select count(*)::int from public.invoice_items), 2, 'unconfirmed delivery excluded');
select tests.eq((select billing_period_start from public.invoices), (date_trunc('month', current_date) - interval '1 month')::date, 'period = previous month');
select tests.eq((select status::text from public.invoices), 'unpaid', 'new invoice unpaid');
select tests.throws($$update public.invoices set amount_due = 1$$, 'credit note', 'finalized invoice amounts are immutable');
select tests.eq((select count(*)::int from public.notifications where notification_type = 'bill_generated'), 1, 'customer notified once of bill');

-- Partial payments
select tests.login((select v from tests.ctx where k = 'cust_user')); set role authenticated;
select tests.throws(format('select public.submit_payment(%L, 100, %L, null)', (select v from tests.ctx where k = 'customer'), 'upi'),
  'reference', 'UPI submission needs a reference');
insert into tests.ctx select 'p_cust', (public.submit_payment((select v from tests.ctx where k = 'customer'), 100, 'upi', 'UPI123456')).id;
select tests.eq((select status::text from public.invoices), 'unpaid', 'customer-submitted payment does not count until verified');
reset role;
select tests.login((select v from tests.ctx where k = 'sup_user')); set role authenticated;
select public.record_payment((select v from tests.ctx where k = 'customer'), 200, 'cash');
select tests.eq((select status::text from public.invoices), 'partially_paid', 'partial payment → partially paid');
select tests.eq(public.customer_balance((select v from tests.ctx where k = 'customer')), 280.00::numeric, 'outstanding ₹280');
select public.verify_payment((select v from tests.ctx where k = 'p_cust'), true);
select tests.throws(format('select public.verify_payment(%L, true)', (select v from tests.ctx where k = 'p_cust')), 'already', 'cannot verify twice');
select tests.eq(public.customer_balance((select v from tests.ctx where k = 'customer')), 180.00::numeric, 'outstanding ₹180 after verified UPI');
select tests.throws(format('select public.record_payment(%L, 50, %L)', (select v from tests.ctx where k = 'customer'), 'online'),
  'payment gateway', 'online payments cannot be recorded manually');
reset role;

-- Gateway payment: only webhook confirmation counts, idempotent, amount-checked
select public.create_gateway_payment((select v from tests.ctx where k = 'customer'), 80, 'razorpay', 'order_TEST1', (select v from tests.ctx where k = 'cust_user'));
select tests.eq(public.customer_balance((select v from tests.ctx where k = 'customer')), 180.00::numeric, 'pending online payment not counted');
select tests.throws($$select public.confirm_gateway_payment('order_TEST1', 'pay_1', 99)$$, 'mismatch', 'amount mismatch rejected');
select public.confirm_gateway_payment('order_TEST1', 'pay_1', 80);
select public.confirm_gateway_payment('order_TEST1', 'pay_1', 80);
select tests.eq((select count(*)::int from public.payments where status = 'succeeded'), 3, 'webhook retry does not double count');
select tests.eq(public.customer_balance((select v from tests.ctx where k = 'customer')), 100.00::numeric, 'outstanding ₹100');
select tests.eq((select amount_paid from public.invoices), 380.00::numeric, 'invoice shows ₹380 paid');

-- Next month: confirm d3 late (it belongs to the closed period) + a new delivery; chain balances
select tests.login((select v from tests.ctx where k = 'cust_user')); set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'd3'), 6);
reset role;
select tests.login((select v from tests.ctx where k = 'sup_user')); set role authenticated;
select public.issue_credit_note((select v from tests.ctx where k = 'customer'), 20, 'Damaged can last month');
reset role;
select public.run_monthly_billing((current_date + interval '1 month')::date);
select public.run_monthly_billing((current_date + interval '1 month')::date);
select tests.eq((select count(*)::int from public.invoices), 2, 'second period → second invoice, no duplicates');
select tests.eq((select previous_balance from public.invoices order by generated_at desc limit 1), 480.00::numeric, 'previous balance carried');
select tests.eq((select payments_received from public.invoices order by generated_at desc limit 1), 380.00::numeric, 'payments since last bill');
select tests.eq((select credits from public.invoices order by generated_at desc limit 1), 20.00::numeric, 'credits since last bill');
select tests.eq((select current_charges from public.invoices order by generated_at desc limit 1), 240.00::numeric, 'late-confirmed 6 cans billed once');
select tests.eq((select amount_due from public.invoices order by generated_at desc limit 1), 320.00::numeric, '480 + 240 − 380 − 20 = 320');
select tests.eq(public.customer_balance((select v from tests.ctx where k = 'customer')), 320.00::numeric, 'account balance matches invoice chain');
select tests.eq((select count(*)::int from public.invoice_items where delivery_id = (select v from tests.ctx where k = 'd3')), 1, 'delivery billed exactly once');
select tests.eq((select superseded_by is not null from public.invoices order by generated_at asc limit 1), true, 'old invoice superseded');

-- Overdue + reminders are deduplicated
update public.supplier_settings set billing_due_days = 0;
select public.process_payment_reminders((current_date + interval '2 months')::date);
select public.process_payment_reminders((current_date + interval '2 months')::date);
select tests.eq((select count(*)::int from public.notifications where notification_type = 'payment_overdue'), 1, 'one overdue reminder per invoice per week');
