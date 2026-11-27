-- Push notifications: device tokens and the push outbox channel
insert into tests.ctx values
  ('sup', tests.create_user('s@push.in', 'supplier', 'Ravi')),
  ('cust', tests.create_user('c@push.in', 'customer', 'Meena')),
  ('other', tests.create_user('o@push.in', 'customer', 'Other'));

select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select public.register_supplier('Blue Waters', 'Ravi', '9400000001', null, 'Anna Nagar', 'Anna Nagar', 40);
select public.register_push_token('supplier-phone-token-0123456789', 'android');
select tests.eq((select count(*)::int from public.push_tokens), 1, 'supplier registered a phone');
select tests.throws($q$select public.register_push_token('short')$q$, 'Invalid push token', 'bad token rejected');
reset role;

select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
insert into tests.ctx select 'c', (public.connect_to_supplier('Meena', '9400000010', '4 Lake View', null, tests.supplier_code(1), null, 5, 2)).id;
select tests.eq((select count(*)::int from public.push_tokens), 0, 'customer cannot see the supplier''s tokens');
select tests.throws($q$insert into public.push_tokens (user_id, token) values (auth.uid(), 'direct-insert-token-0123456789')$q$,
  'permission denied', 'tokens only through the function');
-- Customer places an order -> supplier gets a push queued
select public.place_order((select v from tests.ctx where k = 'c'), 3);
reset role;
select tests.eq((select push_status from public.notifications
                  where user_id = (select v from tests.ctx where k = 'sup') and notification_type = 'new_order'), 'pending',
  'new order queues a push for the supplier');
select tests.eq((select count(*)::int from public.notifications
                  where user_id = (select v from tests.ctx where k = 'cust') and push_status <> 'skipped'), 0,
  'no push queued for the customer without a phone token');

-- Dispatcher claim / completion (service role)
set role service_role;
select tests.eq((select count(*)::int from public.claim_notification_batch(50) where channel = 'push' and notification_type = 'new_order'), 1, 'dispatcher claims the order push');
select public.complete_notification_delivery(id, 'push', true) from public.notifications
  where user_id = (select v from tests.ctx where k = 'sup') and notification_type = 'new_order';
select tests.eq((select push_status from public.notifications
                  where user_id = (select v from tests.ctx where k = 'sup') and notification_type = 'new_order'), 'sent', 'push marked sent');
reset role;
select tests.eq((select email_status from public.notifications
                  where user_id = (select v from tests.ctx where k = 'sup') and notification_type = 'new_order'), 'sending',
  'email channel still in flight (handled separately)');
set role service_role;
select public.complete_notification_delivery(id, 'email', false, 'not configured: RESEND_API_KEY') from public.notifications
  where user_id = (select v from tests.ctx where k = 'sup') and notification_type = 'new_order';
reset role;
select tests.eq((select email_status from public.notifications
                  where user_id = (select v from tests.ctx where k = 'sup') and notification_type = 'new_order'), 'skipped',
  'unconfigured channel is skipped, not retried');

-- Clients cannot claim the outbox or read the dispatch secret
select tests.login((select v from tests.ctx where k = 'cust')); set role authenticated;
select tests.throws('select * from public.claim_notification_batch(5)', 'permission denied', 'customers cannot claim the outbox');
select tests.throws($q$select public.verify_dispatch_secret('x')$q$, 'permission denied', 'customers cannot probe the dispatch secret');
reset role;

-- A phone moves to whoever logs in on it; logout removes it
select tests.login((select v from tests.ctx where k = 'other')); set role authenticated;
select public.register_push_token('supplier-phone-token-0123456789', 'android');
select tests.eq((select count(*)::int from public.push_tokens), 1, 'token moved to the new user on that phone');
select public.unregister_push_token('supplier-phone-token-0123456789');
select tests.eq((select count(*)::int from public.push_tokens), 0, 'logout removes the token');
reset role;
select tests.eq((select count(*)::int from public.push_tokens), 0, 'supplier no longer gets pushes on that phone');
