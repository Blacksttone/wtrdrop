-- Supplier pays the Waterdrop bill online: start, record order, finalize (idempotent), access rules
insert into tests.ctx values
  ('sup', tests.create_user('s@pp.in', 'supplier', 'Ravi')),
  ('drv', tests.create_user('d@pp.in', 'supplier', 'Dinesh')),
  ('other', tests.create_user('o@pp.in', 'supplier', 'Other')),
  ('admin', tests.create_user('a@pp.in', 'customer', 'Owner'));
update public.profiles set role = 'admin' where id = (select v from tests.ctx where k = 'admin');
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
insert into tests.ctx select 'sid', (public.register_supplier('Blue Waters', 'Ravi', '9400000001', null, 'Anna Nagar', 'Anna Nagar', 40)).id;
create temp table _inv as select (public.create_staff_invite('delivery', 'Dinesh')).code;
reset role;
grant select on _inv to authenticated;
select tests.login((select v from tests.ctx where k = 'drv')); set role authenticated;
select public.join_supplier_as_staff((select code from _inv));
reset role;
select tests.login((select v from tests.ctx where k = 'other')); set role authenticated;
select public.register_supplier('Other Aqua', 'Other', '9400000002', null, 'Velachery', 'Velachery', 35);
reset role;
update public.suppliers set created_at = now() - interval '70 days';
insert into tests.ctx select 'pi', (public.generate_platform_invoice((select v from tests.ctx where k = 'sid'), date_trunc('month', current_date)::date)).id;
select tests.eq((select total from public.platform_invoices where id = (select v from tests.ctx where k = 'pi')), 388::numeric, 'bill ₹359 + 1 co-worker');

select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select tests.eq((public.start_platform_payment((select v from tests.ctx where k = 'pi')) ->> 'amount')::numeric, 388::numeric, 'owner can start paying');
select tests.throws('select public.record_platform_order(gen_random_uuid(), ''wdp_x123456'', 1, auth.uid())', 'permission denied', 'clients cannot create orders directly');
select tests.throws('select public.finalize_platform_payment(''wdp_x123456'', 1)', 'permission denied', 'clients cannot mark payments paid');
reset role;
select tests.login((select v from tests.ctx where k = 'drv')); set role authenticated;
select tests.throws(format('select public.start_platform_payment(%L)', (select v from tests.ctx where k = 'pi')), 'owner or a manager', 'delivery staff cannot pay');
reset role;
select tests.login((select v from tests.ctx where k = 'other')); set role authenticated;
select tests.throws(format('select public.start_platform_payment(%L)', (select v from tests.ctx where k = 'pi')), 'not found', 'another supplier cannot pay this bill');
reset role;

-- Service role (Edge Function): record order, gateway confirms
set role service_role;
select public.record_platform_order((select v from tests.ctx where k = 'pi'), 'wdp_test_0001', 388, (select v from tests.ctx where k = 'sup'));
select tests.throws('select public.finalize_platform_payment(''wdp_test_0001'', 100)', 'less than the bill', 'short payment rejected');
select public.finalize_platform_payment('wdp_test_0001', 388, 'cf_998877');
select public.finalize_platform_payment('wdp_test_0001', 388, 'cf_998877');
reset role;
select tests.eq((select status from public.platform_invoices where id = (select v from tests.ctx where k = 'pi')), 'paid', 'bill marked paid by the gateway');
select tests.eq((select payment_reference from public.platform_invoices where id = (select v from tests.ctx where k = 'pi')), 'Cashfree cf_998877', 'gateway reference stored');
select tests.eq((select count(*)::int from public.notifications where notification_type = 'payment_received'), 2, 'owner and admin notified once (idempotent)');
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select tests.throws(format('select public.start_platform_payment(%L)', (select v from tests.ctx where k = 'pi')), 'already settled', 'paid bill cannot be paid again');
select tests.eq((select count(*)::int from public.platform_payments), 1, 'owner sees the payment');
reset role;
select tests.eq((select total from public.generate_platform_invoice((select v from tests.ctx where k = 'sid'), date_trunc('month', current_date)::date)), 388::numeric, 'paid bill is not recalculated');
