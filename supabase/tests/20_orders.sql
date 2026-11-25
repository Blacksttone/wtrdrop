-- Order workflow
insert into tests.ctx values
  ('sup_user', tests.create_user('s@o.in', 'supplier', 'Siva')),
  ('cust_user', tests.create_user('c@o.in', 'customer', 'Lakshmi'));
select tests.login((select v from tests.ctx where k = 'sup_user')); set role authenticated;
select public.register_supplier('Aqua Fresh', 'Siva', '9000000001', null, '1 Main Rd, Madurai', 'Anna Nagar', 35);
reset role;
select tests.login((select v from tests.ctx where k = 'cust_user')); set role authenticated;
insert into tests.ctx select 'customer', (public.connect_to_supplier('Lakshmi', '9000000002', '22 Temple St', null, tests.supplier_code(), null, 2, 2)).id;

select tests.throws(format('select public.place_order(%L, 0)', (select v from tests.ctx where k = 'customer')), 'between 1 and 1000', 'zero-can order rejected');
select tests.throws(format('select public.place_order(%L, 2, current_date - 3)', (select v from tests.ctx where k = 'customer')), 'next 60 days', 'past delivery date rejected');
insert into tests.ctx select 'order1', (public.place_order((select v from tests.ctx where k = 'customer'), 4, null, 'Leave at gate')).id;
insert into tests.ctx select 'order2', (public.place_order((select v from tests.ctx where k = 'customer'), 25)).id;
select tests.eq((select is_bulk from public.orders where id = (select v from tests.ctx where k = 'order2')), true, '25 cans ≥ bulk threshold → bulk order');
select tests.eq((select status::text from public.orders where id = (select v from tests.ctx where k = 'order1')), 'pending', 'new order is pending');
select tests.throws(format('select public.update_order_status(%L, %L)', (select v from tests.ctx where k = 'order1'), 'accepted'),
  'Supplier account required', 'customer cannot accept their own order');
select public.cancel_order((select v from tests.ctx where k = 'order2'), 'Ordered by mistake');
select tests.eq((select status::text from public.orders where id = (select v from tests.ctx where k = 'order2')), 'cancelled', 'customer cancels pending order');
reset role;
select tests.eq((select count(*)::int from public.notifications n join public.suppliers s on s.owner_id = n.user_id where n.notification_type = 'new_order'), 2, 'supplier notified of new orders');

select tests.login((select v from tests.ctx where k = 'sup_user')); set role authenticated;
select tests.throws(format('select public.record_delivery(%L, 4, 4, null, %L)', (select v from tests.ctx where k = 'customer'), (select v from tests.ctx where k = 'order1')),
  'must be accepted', 'cannot deliver a pending order');
select tests.throws(format('select public.update_order_status(%L, %L)', (select v from tests.ctx where k = 'order1'), 'out_for_delivery'),
  'Cannot move order', 'invalid transition pending → out_for_delivery');
select tests.throws(format('select public.update_order_status(%L, %L)', (select v from tests.ctx where k = 'order1'), 'delivered'),
  'Record a delivery', 'delivered only via delivery confirmation workflow');
select public.update_order_status((select v from tests.ctx where k = 'order1'), 'accepted', current_date + 1);
select public.update_order_status((select v from tests.ctx where k = 'order1'), 'out_for_delivery');
reset role;
select tests.login((select v from tests.ctx where k = 'cust_user')); set role authenticated;
select tests.throws(format('select public.cancel_order(%L)', (select v from tests.ctx where k = 'order1')), 'before the supplier accepts', 'cannot cancel after acceptance');
select tests.eq((select count(*)::int from public.notifications where notification_type in ('order_accepted', 'delivery_scheduled', 'order_status')), 3,
  'customer notified: accepted, scheduled, out for delivery');
reset role;

select tests.login((select v from tests.ctx where k = 'sup_user')); set role authenticated;
insert into tests.ctx select 'delivery', (public.record_delivery((select v from tests.ctx where k = 'customer'), 4, 4, null, (select v from tests.ctx where k = 'order1'))).id;
select tests.throws(format('select public.record_delivery(%L, 4, 4, null, %L)', (select v from tests.ctx where k = 'customer'), (select v from tests.ctx where k = 'order1')),
  'must be accepted', 'second delivery for same order rejected');
reset role;
select tests.eq((select status::text from public.orders where id = (select v from tests.ctx where k = 'order1')), 'delivered', 'order marked delivered');
select tests.eq((select current_stock from public.customer_stock), 2, 'but stock waits for customer confirmation');
select tests.login((select v from tests.ctx where k = 'cust_user')); set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'delivery'), 4);
select tests.eq((select current_stock from public.customer_stock), 6, 'stock 2 + 4 confirmed = 6');
select tests.eq((select count(*)::int from public.order_status_history where order_id = (select v from tests.ctx where k = 'order1')), 4,
  'order history: pending, accepted, out_for_delivery, delivered');
reset role;
