-- Delivery location (GPS) + one owner with a Company and a Home at the same supplier (separate bills)
insert into tests.ctx values
  ('sup', tests.create_user('s@loc.in', 'supplier', 'Supplier One')),
  ('sup2', tests.create_user('s2@loc.in', 'supplier', 'Supplier Two')),
  ('owner', tests.create_user('o@loc.in', 'customer', 'Raja')),
  ('member', tests.create_user('m@loc.in', 'customer', 'Staff')),
  ('outsider', tests.create_user('x@loc.in', 'customer', 'Outsider'));

select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
insert into tests.ctx select 'sid', (public.register_supplier('Anna Waters', 'Supplier One', '9400000001', null, 'Anna Nagar, Chennai', 'Anna Nagar', 40)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'sup2')); set role authenticated;
select public.register_supplier('Other Aqua', 'Supplier Two', '9400000002', null, 'Velachery', 'Velachery', 35);
reset role;

-- Same owner: a company and their home, both with Anna Waters
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
insert into tests.ctx select 'co', (public.create_customer_account('Raja Tech', 'company')).id;
insert into tests.ctx select 'home', (public.create_customer_account('Raja family', 'home')).id;
insert into tests.ctx select 'cb', (public.connect_to_supplier('Raja', '9400000010', '12 Main Rd, Anna Nagar', null, tests.supplier_code(1), null, 5, 2,
  'office', 20, (select v from tests.ctx where k = 'co'), 'Office')).id;
insert into tests.ctx select 'hb', (public.connect_to_supplier('Raja', '9400000010', '4 Lake View, Anna Nagar', null, tests.supplier_code(1), null, 3, 1,
  'family', 4, (select v from tests.ctx where k = 'home'), null)).id;
select tests.eq((select bill_to_customer_id from public.customers where id = (select v from tests.ctx where k = 'hb')), null::uuid,
  'home is not merged into the company bill');
select tests.eq((select count(*)::int from public.customers), 2, 'owner sees both company and home');

-- Customer saves their location
select public.set_customer_location((select v from tests.ctx where k = 'hb'), 13.0850, 80.2101, 12);
select tests.eq((select latitude from public.customers where id = (select v from tests.ctx where k = 'hb')), 13.0850::double precision, 'customer saved home location');
select tests.throws(format('select public.set_customer_location(%L, 95, 80)', (select v from tests.ctx where k = 'hb')), 'Invalid location', 'latitude out of range rejected');
select tests.throws(format('select public.set_customer_location(%L, 13, null)', (select v from tests.ctx where k = 'hb')), 'Invalid location', 'half a location rejected');
-- Request with location, then approval copies it to the branch
insert into tests.ctx select 'req', (public.request_supplier_connection((select v from tests.ctx where k = 'co'), (select v from tests.ctx where k = 'sid'),
  'Raja', '9400000012', '9 Second St, Anna Nagar', 'Warehouse')).id;
select public.set_request_location((select v from tests.ctx where k = 'req'), 13.09, 80.21, 30);
reset role;

select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select tests.eq((select latitude from public.supplier_connection_requests where id = (select v from tests.ctx where k = 'req')), 13.09::double precision,
  'supplier sees the request location');
select public.decide_connection_request((select v from tests.ctx where k = 'req'), true);
reset role;
insert into tests.ctx select 'wb', (select customer_id from public.supplier_connection_requests where id = (select v from tests.ctx where k = 'req'));
select tests.eq((select latitude from public.customers where id = (select v from tests.ctx where k = 'wb')), 13.09::double precision,
  'approved branch gets the request location');
select tests.eq((select bill_to_customer_id from public.customers where id = (select v from tests.ctx where k = 'wb')),
  (select v from tests.ctx where k = 'cb'), 'second company branch still joins the company bill');

-- Supplier (or delivery staff) saves location at the door; can clear it
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select public.set_customer_location((select v from tests.ctx where k = 'cb'), 13.0827, 80.2707, 8);
select tests.eq((select location_accuracy_m from public.customers where id = (select v from tests.ctx where k = 'cb')), 8, 'supplier saved office location');
select public.set_customer_location((select v from tests.ctx where k = 'cb'), null, null);
select tests.eq((select latitude from public.customers where id = (select v from tests.ctx where k = 'cb')), null::double precision, 'supplier cleared location');
reset role;

-- Strangers cannot set locations
select tests.login((select v from tests.ctx where k = 'sup2')); set role authenticated;
select tests.throws(format('select public.set_customer_location(%L, 13, 80)', (select v from tests.ctx where k = 'hb')), 'Not allowed', 'other supplier blocked');
reset role;
select tests.login((select v from tests.ctx where k = 'outsider')); set role authenticated;
select tests.throws(format('select public.set_customer_location(%L, 13, 80)', (select v from tests.ctx where k = 'hb')), 'Not allowed', 'outsider blocked');
select tests.throws(format('select public.set_request_location(%L, 13, 80)', (select v from tests.ctx where k = 'req')), 'owner or an admin', 'outsider cannot touch requests');
reset role;

-- Separate bills: one invoice for the company group, one for the home
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
insert into tests.ctx select 'd1', (public.record_delivery((select v from tests.ctx where k = 'cb'), 4, 4, current_date - 1)).id;
insert into tests.ctx select 'd2', (public.record_delivery((select v from tests.ctx where k = 'hb'), 2, 2, current_date - 1)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'd1'), 4);
select public.confirm_delivery((select v from tests.ctx where k = 'd2'), 2);
reset role;
select public.generate_invoice_for_customer(id, date_trunc('month', current_date - 1)::date, current_date - 1, current_date)
  from public.customers;
select tests.eq((select count(*)::int from public.invoices), 2, 'company and home get separate bills');
select tests.eq((select total_quantity from public.invoices where customer_id = (select v from tests.ctx where k = 'hb')), 2, 'home bill has only home cans');
select tests.eq((select total_quantity from public.invoices where customer_id = (select v from tests.ctx where k = 'cb')), 4, 'company bill has only company cans');

-- Only the supplier may adjust a confirmed delivery
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
select tests.throws(format('select public.adjust_delivery(%L, 40, %L)', (select v from tests.ctx where k = 'd2'), 'more cans please'),
  'Only the supplier', 'customer cannot adjust their own delivery');
reset role;
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select public.adjust_delivery((select v from tests.ctx where k = 'd2'), 1, 'one can was returned');
reset role;
select tests.eq((select confirmed_quantity + adjusted_quantity from public.deliveries where id = (select v from tests.ctx where k = 'd2')), 1,
  'supplier adjustment still works');
