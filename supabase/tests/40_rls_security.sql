-- Row Level Security & role-based access
insert into tests.ctx values
  ('supA', tests.create_user('a@s.in', 'supplier', 'Supplier A')),
  ('supB', tests.create_user('b@s.in', 'supplier', 'Supplier B')),
  ('custA', tests.create_user('a@c.in', 'customer', 'Customer A')),
  ('custA2', tests.create_user('a2@c.in', 'customer', 'Customer A2')),
  ('custB', tests.create_user('b@c.in', 'customer', 'Customer B')),
  ('admin', tests.create_user('admin@w.in', 'admin', 'Admin'));

-- Self-signup can never create an admin
select tests.eq((select role::text from public.profiles where id = (select v from tests.ctx where k = 'admin')), 'customer',
  'signup metadata role=admin is ignored');
update public.profiles set role = 'admin' where id = (select v from tests.ctx where k = 'admin');

select tests.login((select v from tests.ctx where k = 'supA')); set role authenticated;
insert into tests.ctx select 'sA', (public.register_supplier('A Waters', 'Supplier A', '9100000001', null, 'Addr A', null, 30)).id;
select tests.throws($$select public.register_supplier('A2', 'Supplier A', '9100000001', null, 'Addr A', null, 30)$$, 'already registered', 'one business per supplier account');
reset role;
select tests.login((select v from tests.ctx where k = 'supB')); set role authenticated;
insert into tests.ctx select 'sB', (public.register_supplier('B Waters', 'Supplier B', '9100000002', null, 'Addr B', null, 50)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'custA')); set role authenticated;
select tests.throws($$select public.register_supplier('Sneaky', 'X', '9100000003', null, 'Addr', null, 1)$$, 'not registered as a water supplier', 'customer cannot become supplier');
insert into tests.ctx select 'cA', (public.connect_to_supplier('Customer A', '9100000010', 'Home A', null, tests.supplier_code(1), null, 4, 1)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'custA2')); set role authenticated;
insert into tests.ctx select 'cA2', (public.connect_to_supplier('Customer A2', '9100000011', 'Home A2', null, tests.supplier_code(1), null, 4, 1)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'custB')); set role authenticated;
insert into tests.ctx select 'cB', (public.connect_to_supplier('Customer B', '9100000012', 'Home B', null, tests.supplier_code(2), null, 4, 1)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'supA')); set role authenticated;
select public.record_delivery((select v from tests.ctx where k = 'cA'), 3, 3);
select public.record_delivery((select v from tests.ctx where k = 'cA2'), 3, 3);
reset role;
select tests.login((select v from tests.ctx where k = 'supB')); set role authenticated;
select public.record_delivery((select v from tests.ctx where k = 'cB'), 2, 2);
reset role;

-- Supplier isolation
select tests.login((select v from tests.ctx where k = 'supA')); set role authenticated;
select tests.eq((select count(*)::int from public.customers), 2, 'supplier A sees only own 2 customers');
select tests.eq((select count(*)::int from public.deliveries), 2, 'supplier A sees only own deliveries');
select tests.eq((select count(*)::int from public.suppliers), 1, 'supplier A sees only own business');
select tests.eq((select count(*)::int from public.inventory_transactions), 2, 'supplier A sees only own ledger rows');
select tests.throws(format('select public.record_delivery(%L, 5, 5)', (select v from tests.ctx where k = 'cB')), 'Customer not found', 'supplier A cannot deliver to B''s customer');
select tests.throws(format('select public.record_payment(%L, 5, %L)', (select v from tests.ctx where k = 'cB'), 'cash'), 'Customer not found', 'supplier A cannot record B''s payments');
select tests.throws(format('select public.get_customer_summary(%L)', (select v from tests.ctx where k = 'cB')), 'Not allowed', 'supplier A cannot read B''s customer summary');
update public.customers set can_price = 1 where id = (select v from tests.ctx where k = 'cB');
reset role;
select tests.eq((select can_price from public.customers where id = (select v from tests.ctx where k = 'cB')), null::numeric, 'cross-tenant update silently blocked by RLS');
select tests.login((select v from tests.ctx where k = 'supA')); set role authenticated;
select tests.throws($$update public.suppliers set status = 'active', business_code = 'HACKED12'$$, 'Only platform admins', 'supplier cannot change own status/code');
select tests.throws($$update public.supplier_settings set invoice_seq = 99$$, 'system managed', 'supplier cannot reset invoice numbering');
select tests.throws($$update public.profiles set role = 'admin' where id = auth.uid()$$, 'Not allowed to change role', 'supplier cannot escalate role');
select tests.throws($$select public.admin_platform_stats()$$, 'admin access required', 'supplier cannot use admin functions');
select tests.eq((select count(*)::int from public.admin_list_suppliers()), 0, 'admin supplier list empty for non-admin');
reset role;

-- Customer isolation
select tests.login((select v from tests.ctx where k = 'custA')); set role authenticated;
select tests.eq((select count(*)::int from public.customers), 1, 'customer sees only own account');
select tests.eq((select count(*)::int from public.deliveries), 1, 'customer sees only own deliveries');
select tests.eq((select count(*)::int from public.suppliers), 1, 'customer sees only connected supplier');
select tests.eq((select count(*)::int from public.profiles), 2, 'customer sees own profile + supplier owner only');
select tests.eq((select count(*)::int from public.notifications where user_id <> auth.uid()), 0, 'no foreign notifications visible');
select tests.throws(format('select public.record_consumption(%L, 1)', (select v from tests.ctx where k = 'cA2')), 'Not allowed', 'customer cannot record consumption for another customer');
select tests.throws(format('select public.place_order(%L, 1)', (select v from tests.ctx where k = 'cA2')), 'Not allowed', 'customer cannot order for another customer');
select tests.throws(format('select public.apply_delivery_confirmation(%L, 99, null, false)', (select id from public.deliveries limit 1)),
  'permission denied', 'internal confirmation function is not callable by clients');
select tests.throws(format('select public.compute_prediction(%L)', (select v from tests.ctx where k = 'cA2')),
  'permission denied', 'cannot read another customer''s prediction via internal helper');
select tests.throws(format('select public.customer_balance(%L)', (select v from tests.ctx where k = 'cA2')),
  'permission denied', 'cannot read another customer''s balance via internal helper');
select tests.eq((public.get_customer_summary((select v from tests.ctx where k = 'cA')) -> 'prediction' ->> 'current_stock')::int, 4,
  'public summary RPC still works for own account');
select tests.throws(format('select public.record_delivery(%L, 1, 1)', (select v from tests.ctx where k = 'cA')), 'Supplier account required', 'customer cannot record deliveries');
select tests.throws($$select public.record_payment((select id from public.customers limit 1), 1000, 'cash')$$, 'Supplier account required', 'customer cannot mark bills paid');
update public.customers set can_price = 0;
reset role;
select tests.eq((select can_price from public.customers where id = (select v from tests.ctx where k = 'cA')), null::numeric, 'customer cannot change own price (RLS)');
-- customer A2 cannot confirm customer A's delivery
select tests.login((select v from tests.ctx where k = 'custA2')); set role authenticated;
select tests.throws(format('select public.confirm_delivery(%L, 3)', (select id from public.deliveries where customer_id = (select v from tests.ctx where k = 'cA'))),
  'Delivery not found|Not allowed', 'customer cannot confirm someone else''s delivery');
reset role;

-- Anonymous users get nothing
select tests.logout(); set role anon;
select tests.throws($$select count(*) from public.customers$$, 'permission denied', 'anon cannot read customers');
select tests.throws($$select public.lookup_supplier('ABC')$$, 'permission denied|Not authenticated', 'anon cannot look up suppliers');
select tests.throws($$select public.place_order(gen_random_uuid(), 1)$$, 'permission denied', 'anon has no RPC access');
reset role;

-- Suspension
select tests.login((select v from tests.ctx where k = 'admin')); set role authenticated;
select tests.eq((select count(*)::int from public.customers), 3, 'admin sees all customers');
select tests.eq((public.admin_platform_stats() ->> 'suppliers')::int, 2, 'admin platform stats');
select public.admin_set_supplier_status((select v from tests.ctx where k = 'sB'), 'suspended', 'Unpaid subscription');
reset role;
select tests.login((select v from tests.ctx where k = 'supB')); set role authenticated;
select tests.throws(format('select public.record_delivery(%L, 1, 1)', (select v from tests.ctx where k = 'cB')), 'suspended', 'suspended supplier cannot operate');
select tests.eq((select count(*)::int from public.customers), 1, 'suspended supplier can still read own data');
reset role;
select tests.login((select v from tests.ctx where k = 'custB')); set role authenticated;
select tests.throws(format('select public.place_order(%L, 2)', (select v from tests.ctx where k = 'cB')), 'not accepting orders', 'customers of suspended supplier cannot order');
select tests.throws(format('select public.connect_to_supplier(%L, %L, %L, null, %L)', 'X', '9100000099', 'Somewhere', tests.supplier_code(2)),
  'already connected|not found', 'cannot connect to suspended supplier');
reset role;
select tests.eq((select count(*)::int from public.audit_logs where action = 'admin.supplier_suspended'), 1, 'suspension audited');
select tests.eq((select count(*)::int from public.audit_logs where action = 'delivery.confirmed'), 0, 'no confirmations yet audited');
select tests.eq((select count(*)::int from public.audit_logs where action = 'delivery.recorded'), 3, 'deliveries audited');
