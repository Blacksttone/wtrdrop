-- Empty can tracking: empties per delivery, cans with customer, corrections, daily report
insert into tests.ctx values
  ('sup', tests.create_user('s@can.in', 'supplier', 'Ravi')),
  ('drv', tests.create_user('d@can.in', 'supplier', 'Dinesh')),
  ('sup2', tests.create_user('s2@can.in', 'supplier', 'Other')),
  ('cust', tests.create_user('c@can.in', 'customer', 'Meena')),
  ('outsider', tests.create_user('x@can.in', 'customer', 'Outsider'));

select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
insert into tests.ctx select 'sid', (public.register_supplier('Blue Waters', 'Ravi', '9400000001', null, 'Anna Nagar', 'Anna Nagar', 40)).id;
reset role;
-- delivery co-worker
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
create temp table _inv as select (public.create_staff_invite('delivery', 'Dinesh')).code;
reset role;
grant select on _inv to authenticated;
select tests.login((select v from tests.ctx where k = 'drv')); set role authenticated;
select public.join_supplier_as_staff((select code from _inv));
reset role;
select tests.login((select v from tests.ctx where k = 'sup2')); set role authenticated;
select public.register_supplier('Other Aqua', 'Other', '9400000002', null, 'Velachery', 'Velachery', 35);
reset role;

select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
insert into tests.ctx select 'c', (public.connect_to_supplier('Meena', '9400000010', '4 Lake View', null, tests.supplier_code(1), null, 2, 2)).id;
reset role;

-- Driver delivers 5 full cans and takes back 3 empties (customer confirms 5)
select tests.login((select v from tests.ctx where k = 'drv')); set role authenticated;
insert into tests.ctx select 'd1', (public.record_delivery((select v from tests.ctx where k = 'c'), 5, 5, null, null, null, 3)).id;
select tests.eq((select public.cans_with_customer((select v from tests.ctx where k = 'c'))), 2, 'awaiting delivery counts: 5 given − 3 back');
select tests.throws(format('select public.record_delivery(%L, 1, 1, null, null, null, -1)', (select v from tests.ctx where k = 'c')),
  'Empty cans must be between', 'negative empties rejected');
reset role;
select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'd1'), 4, 'one can short');
select tests.eq((select public.cans_with_customer((select v from tests.ctx where k = 'c'))), 1, 'customer sees cans with them: 4 confirmed − 3 back');
select tests.eq((select empty_cans_collected from public.deliveries where id = (select v from tests.ctx where k = 'd1')), 3,
  'customer sees empty cans taken back');
select tests.throws(format('select public.set_delivery_empty_cans(%L, 0)', (select v from tests.ctx where k = 'd1')),
  'Supplier account required', 'customer cannot change empties');
reset role;

-- Old app versions (no p_empty_cans) still work: empties = 0
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
insert into tests.ctx select 'd2', (public.record_delivery((select v from tests.ctx where k = 'c'), 2, 2)).id;
select tests.eq((select empty_cans_collected from public.deliveries where id = (select v from tests.ctx where k = 'd2')), 0, 'old call defaults to 0 empties');
-- Driver fixes it later (even works after confirmation)
reset role;
select tests.login((select v from tests.ctx where k = 'drv')); set role authenticated;
select public.set_delivery_empty_cans((select v from tests.ctx where k = 'd2'), 2);
select public.set_delivery_empty_cans((select v from tests.ctx where k = 'd1'), 4);
select tests.eq((select public.cans_with_customer((select v from tests.ctx where k = 'c'))), 0, 'after fixes: (4 − 4) + (2 − 2) = 0');
reset role;

-- Supplier list column and correction for cans held before Waterdrop
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select tests.eq((select cans_out from public.list_supplier_customers() where id = (select v from tests.ctx where k = 'c')), 0, 'customer list shows cans out');
select public.set_cans_with_customer((select v from tests.ctx where k = 'c'), 6, 'had 4 of our cans before the app');
select tests.eq((select public.cans_with_customer((select v from tests.ctx where k = 'c'))), 6, 'owner set cans with customer to 6');
reset role;
select tests.login((select v from tests.ctx where k = 'drv')); set role authenticated;
select tests.throws(format('select public.set_cans_with_customer(%L, 0)', (select v from tests.ctx where k = 'c')),
  'Only the owner or a manager', 'delivery staff cannot reset the balance');
-- Daily report
select tests.eq((select (public.supplier_can_report() ->> 'full_cans')::int), 7, 'report: 7 full cans today');
select tests.eq((select (public.supplier_can_report() ->> 'empty_cans')::int), 6, 'report: 6 empty cans back today');
select tests.eq((select (public.supplier_can_report() ->> 'cans_with_customers')::int), 6, 'report: 6 cans with customers');
select tests.eq((select jsonb_array_length(public.supplier_can_report() -> 'by_person')), 2, 'report split by owner and driver');
select tests.eq((select (x ->> 'empty_cans')::int from jsonb_array_elements(public.supplier_can_report() -> 'by_person') x where x ->> 'name' = 'Dinesh'),
  4, 'driver brought back 4 empties');
reset role;

-- Cancelled deliveries do not count
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select public.set_delivery_empty_cans((select v from tests.ctx where k = 'd2'), 0);
select tests.eq((select public.cans_with_customer((select v from tests.ctx where k = 'c'))), 8, 'd2 with no empties: 6 + 2');
select public.cancel_delivery((select v from tests.ctx where k = 'd2'), 'recorded by mistake');
select tests.eq((select public.cans_with_customer((select v from tests.ctx where k = 'c'))), 6, 'cancelled delivery removed from the balance');
reset role;

-- Strangers
select tests.login((select v from tests.ctx where k = 'sup2')); set role authenticated;
select tests.throws(format('select public.cans_with_customer(%L)', (select v from tests.ctx where k = 'c')), 'Not allowed', 'other supplier blocked');
select tests.throws(format('select public.set_delivery_empty_cans(%L, 1)', (select v from tests.ctx where k = 'd1')), 'not found', 'other supplier cannot edit empties');
reset role;
select tests.login((select v from tests.ctx where k = 'outsider')); set role authenticated;
select tests.throws(format('select public.cans_with_customer(%L)', (select v from tests.ctx where k = 'c')), 'Not allowed', 'outsider blocked');
reset role;
