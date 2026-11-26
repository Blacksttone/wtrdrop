-- Co-workers, roles, blocking, household details
insert into tests.ctx values
  ('owner', tests.create_user('owner@s.in', 'supplier', 'Owner')),
  ('mgr', tests.create_user('mgr@s.in', 'supplier', 'Manager Mani')),
  ('boy', tests.create_user('boy@s.in', 'supplier', 'Delivery Dinesh')),
  ('other', tests.create_user('other@s.in', 'supplier', 'Other Owner')),
  ('cust', tests.create_user('c@s.in', 'customer', 'Kavya')),
  ('cust_user2', tests.create_user('c2@s.in', 'customer', 'Not A Supplier'));

select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
insert into tests.ctx select 'sid', (public.register_supplier('Owner Waters', 'Owner', '9300000001', null, 'Addr', null, 40)).id;
insert into tests.ctx select 'inv_mgr', (public.create_staff_invite('manager', 'Mani')).id;
insert into tests.ctx select 'inv_boy', (public.create_staff_invite('delivery', 'Dinesh')).id;
select tests.eq(public.my_supplier_role(), 'owner', 'registrant is owner');
reset role;
create temp table codes as select id, code from public.staff_invites;
grant select on codes to authenticated;

select tests.login((select v from tests.ctx where k = 'other')); set role authenticated;
select public.register_supplier('Other Waters', 'Other', '9300000002', null, 'Addr 2', null, 30);
select tests.throws(format('select public.join_supplier_as_staff(%L)', (select code from codes where id = (select v from tests.ctx where k = 'inv_mgr'))),
  'already owns', 'an owner cannot join another business');
reset role;

select tests.login((select v from tests.ctx where k = 'cust_user2')); set role authenticated;
select tests.throws(format('select public.join_supplier_as_staff(%L)', (select code from codes where id = (select v from tests.ctx where k = 'inv_mgr'))),
  'I supply water', 'customer accounts cannot join as co-workers');
reset role;

select tests.login((select v from tests.ctx where k = 'mgr')); set role authenticated;
select public.join_supplier_as_staff(lower((select code from codes where id = (select v from tests.ctx where k = 'inv_mgr'))));
select tests.eq(public.my_supplier_role(), 'manager', 'manager joined with code (case-insensitive)');
select tests.eq(public.my_supplier_id(), (select v from tests.ctx where k = 'sid'), 'manager belongs to owner business');
select tests.eq((select count(*)::int from public.suppliers), 1, 'manager can read the business');
select tests.throws($$select public.create_staff_invite('delivery')$$, 'business owner', 'manager cannot invite co-workers');
reset role;

select tests.login((select v from tests.ctx where k = 'boy')); set role authenticated;
select tests.throws(format('select public.join_supplier_as_staff(%L)', (select code from codes where id = (select v from tests.ctx where k = 'inv_mgr'))),
  'invalid, used or expired', 'a code works only once');
select public.join_supplier_as_staff((select code from codes where id = (select v from tests.ctx where k = 'inv_boy')));
select tests.eq(public.my_supplier_role(), 'delivery', 'delivery co-worker joined');
reset role;

-- Customer connects with household details
select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
insert into tests.ctx select 'cid', (public.connect_to_supplier('Kavya', '9300000010', '5 Lake Rd', null,
  tests.supplier_code(1), null, 6, 2, 'family', 5)).id;
select tests.eq((select household_type from public.customers), 'family', 'household type saved');
select tests.eq((select members_count from public.customers), 5, 'members count saved');
select public.update_my_customer_settings((select v from tests.ctx where k = 'cid'), p_household_type => 'shared_room', p_members_count => 3);
select tests.eq((select members_count from public.customers), 3, 'household editable in settings');
insert into tests.ctx select 'order', (public.place_order((select v from tests.ctx where k = 'cid'), 4)).id;
reset role;

-- Delivery co-worker: orders + deliveries yes, money no
select tests.login((select v from tests.ctx where k = 'boy')); set role authenticated;
select tests.eq((select count(*)::int from public.list_supplier_customers()), 1, 'delivery sees customers');
select tests.eq((select household_type from public.list_supplier_customers()), 'shared_room', 'supplier sees household type');
select public.update_order_status((select v from tests.ctx where k = 'order'), 'accepted', current_date);
insert into tests.ctx select 'del', (public.record_delivery((select v from tests.ctx where k = 'cid'), 4, 4, null, (select v from tests.ctx where k = 'order'))).id;
select tests.throws(format('select public.record_payment(%L, 100, %L)', (select v from tests.ctx where k = 'cid'), 'cash'), 'owner or a manager', 'delivery cannot record payments');
select tests.throws($$select public.run_my_billing()$$, 'owner or a manager', 'delivery cannot run billing');
select tests.throws(format('select public.adjust_delivery(%L, 3, %L)', (select v from tests.ctx where k = 'del'), 'test'), 'owner or a manager|confirmed', 'delivery cannot adjust deliveries');
select tests.throws($$select * from public.report_deliveries(current_date - 30, current_date)$$, 'owner or a manager', 'delivery cannot view reports');
select tests.eq((select count(*)::int from public.payments), 0, 'delivery cannot read payments');
select tests.eq((select count(*)::int from public.list_staff()), 0, 'delivery cannot list co-workers');
update public.customers set can_price = 1;
update public.supplier_settings set default_can_price = 1;
reset role;
select tests.eq((select can_price from public.customers where id = (select v from tests.ctx where k = 'cid')), null::numeric, 'delivery cannot change prices');
select tests.eq((select default_can_price from public.supplier_settings where supplier_id = (select v from tests.ctx where k = 'sid')), 40.00::numeric, 'delivery cannot change business settings');

-- Manager: money yes, staff/settings no
select tests.login((select v from tests.ctx where k = 'mgr')); set role authenticated;
select public.record_payment((select v from tests.ctx where k = 'cid'), 100, 'cash');
select tests.eq((select count(*)::int from public.payments), 1, 'manager records and sees payments');
select tests.eq((select count(*)::int from public.list_staff()), 2, 'manager can list co-workers');
select tests.throws(format('select public.update_staff(%L, null, %L)', (select id from public.supplier_staff where role = 'delivery'), 'blocked'), 'business owner', 'manager cannot block co-workers');
update public.supplier_settings set default_can_price = 2;
reset role;
select tests.eq((select default_can_price from public.supplier_settings where supplier_id = (select v from tests.ctx where k = 'sid')), 40.00::numeric, 'manager cannot change business settings');

-- Customer blocking
select tests.login((select v from tests.ctx where k = 'mgr')); set role authenticated;
select tests.throws(format('select public.set_customer_blocked(%L, true)', (select v from tests.ctx where k = 'cid')), 'reason', 'blocking needs a reason');
select public.set_customer_blocked((select v from tests.ctx where k = 'cid'), true, 'Unpaid for 3 months');
select tests.eq((select blocked from public.list_supplier_customers()), true, 'customer shows as blocked');
reset role;
select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
select tests.throws(format('select public.place_order(%L, 2)', (select v from tests.ctx where k = 'cid')), 'blocked by your supplier', 'blocked customer cannot order');
select tests.throws(format('select public.get_customer_summary(%L)', (select v from tests.ctx where k = 'cid')), 'blocked by your supplier', 'blocked customer cannot use the app');
select tests.eq((select block_reason from public.customers), 'Unpaid for 3 months', 'customer can see the block reason');
reset role;
select tests.login((select v from tests.ctx where k = 'boy')); set role authenticated;
select tests.throws(format('select public.set_customer_blocked(%L, false)', (select v from tests.ctx where k = 'cid')), 'owner or a manager', 'delivery cannot unblock customers');
reset role;
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
select tests.throws($$update public.customers set blocked_at = null$$, 'Use block / unblock', 'direct table edits cannot unblock');
reset role;
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
select public.set_customer_blocked((select v from tests.ctx where k = 'cid'), false);
reset role;
select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
select tests.eq((public.get_customer_summary((select v from tests.ctx where k = 'cid')) ->> 'customer_name'), 'Kavya', 'unblocked customer can use the app again');
reset role;

-- Co-worker blocking
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
select public.update_staff((select id from public.supplier_staff where role = 'delivery'), null, 'blocked');
reset role;
select tests.login((select v from tests.ctx where k = 'boy')); set role authenticated;
select tests.eq(public.my_supplier_id(), null::uuid, 'blocked co-worker loses access');
select tests.throws(format('select public.record_delivery(%L, 1, 1)', (select v from tests.ctx where k = 'cid')), 'blocked by the owner', 'blocked co-worker gets a clear message');
select tests.eq((select count(*)::int from public.customers), 0, 'blocked co-worker sees no customers');
reset role;
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
select public.update_staff((select id from public.supplier_staff where role = 'delivery'), 'manager', 'active');
reset role;
select tests.login((select v from tests.ctx where k = 'boy')); set role authenticated;
select tests.eq(public.my_supplier_role(), 'manager', 'unblocked and promoted to manager');
reset role;
select tests.eq((select count(*)::int from public.audit_logs where action like 'staff.%' or action like 'customer.%block%'), 8, 'staff and blocking actions audited');
