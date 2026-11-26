-- Customer accounts: types, branches, family/team members, supplier search & approval, combined bills
insert into tests.ctx values
  ('sup', tests.create_user('s@acc.in', 'supplier', 'Supplier One')),
  ('sup2', tests.create_user('s2@acc.in', 'supplier', 'Supplier Two')),
  ('hidden', tests.create_user('s3@acc.in', 'supplier', 'Hidden Sup')),
  ('owner', tests.create_user('o@acc.in', 'customer', 'Raja Stores Owner')),
  ('admin', tests.create_user('ad@acc.in', 'customer', 'Store Admin')),
  ('member', tests.create_user('m@acc.in', 'customer', 'Branch Staff')),
  ('outsider', tests.create_user('x@acc.in', 'customer', 'Outsider'));

select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
insert into tests.ctx select 'sid', (public.register_supplier('Anna Waters', 'Supplier One', '9400000001', null, 'Anna Nagar, Chennai', 'Anna Nagar', 40)).id;
update public.supplier_settings set billing_day = 1;
reset role;
select tests.login((select v from tests.ctx where k = 'sup2')); set role authenticated;
insert into tests.ctx select 'sid2', (public.register_supplier('Velachery Aqua', 'Supplier Two', '9400000002', null, 'Velachery, Chennai', 'Velachery', 35)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'hidden')); set role authenticated;
select public.register_supplier('Hidden Waters', 'Hidden', '9400000003', null, 'Anna Nagar', 'Anna Nagar', 30);
update public.suppliers set listed = false;
reset role;

-- Company account + supplier search
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
insert into tests.ctx select 'acc', (public.create_customer_account('Raja Stores', 'company')).id;
select tests.eq((select account_type::text from public.customer_accounts), 'company', 'company account created');
select tests.eq((select count(*)::int from public.search_suppliers('anna')), 1, 'search finds listed supplier, hides unlisted');
select tests.eq((select count(*)::int from public.search_suppliers(null)), 2, 'empty search lists all listed suppliers');
-- Branch 1 via request → approve
insert into tests.ctx select 'req1', (public.request_supplier_connection((select v from tests.ctx where k = 'acc'), (select v from tests.ctx where k = 'sid'),
  'Raja', '9400000010', '12 Main Rd, Anna Nagar', 'Head office', null, 'office', 12, 10, 3)).id;
select tests.throws(format('select public.request_supplier_connection(%L, %L, %L, %L, %L)', (select v from tests.ctx where k = 'acc'),
  (select v from tests.ctx where k = 'sid'), 'Raja', '9400000010', '12 main rd, anna nagar'), 'already waiting', 'duplicate pending request blocked');
select tests.eq((select count(*)::int from public.customers), 0, 'no branch before supplier approval');
reset role;

select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select tests.eq((select count(*)::int from public.supplier_connection_requests where status = 'pending'), 1, 'supplier sees the request');
select public.decide_connection_request((select v from tests.ctx where k = 'req1'), true);
reset role;
insert into tests.ctx select 'b1', (select customer_id from public.supplier_connection_requests where id = (select v from tests.ctx where k = 'req1'));
select tests.eq((select current_stock from public.customer_stock where customer_id = (select v from tests.ctx where k = 'b1')), 10, 'approved branch has opening stock');

-- Branch 2 same supplier via code (instant), branch 3 different supplier via request
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
insert into tests.ctx select 'b2', (public.connect_to_supplier('Raja', '9400000011', '8 Lake Rd, Anna Nagar', null, tests.supplier_code(1), null, 4, 2,
  'shop', 4, (select v from tests.ctx where k = 'acc'), 'Lake Rd branch')).id;
select tests.throws(format('select public.connect_to_supplier(%L, %L, %L, null, %L, null, null, 0, null, null, %L)', 'Raja', '9400000011',
  '8 lake rd, anna nagar', tests.supplier_code(1), (select v from tests.ctx where k = 'acc')), 'already connected', 'same address cannot be added twice');
insert into tests.ctx select 'req3', (public.request_supplier_connection((select v from tests.ctx where k = 'acc'), (select v from tests.ctx where k = 'sid2'),
  'Raja', '9400000012', '3 Station Rd, Velachery', 'Velachery branch')).id;
reset role;
select tests.eq((select bill_to_customer_id from public.customers where id = (select v from tests.ctx where k = 'b2')),
  (select v from tests.ctx where k = 'b1'), 'second branch with same supplier bills to the head branch');
select tests.login((select v from tests.ctx where k = 'sup2')); set role authenticated;
select tests.throws(format('select public.decide_connection_request(%L, false)', (select v from tests.ctx where k = 'req3')), 'reason', 'rejection needs a reason');
select public.decide_connection_request((select v from tests.ctx where k = 'req3'), false, 'We do not deliver to Station Road yet');
select tests.eq((select count(*)::int from public.customers), 0, 'other supplier cannot see this account''s branches');
reset role;
select tests.eq((select count(*)::int from public.notifications n join public.customer_accounts a on a.owner_id = n.user_id
  where n.title = 'Supplier declined your request'), 1, 'owner told about the rejection');

-- Members: admin (all branches), member limited to Lake Rd branch
select tests.login((select v from tests.ctx where k = 'owner')); set role authenticated;
insert into tests.ctx select 'inv_admin', (public.create_member_invite((select v from tests.ctx where k = 'acc'), 'admin')).id;
insert into tests.ctx select 'inv_member', (public.create_member_invite((select v from tests.ctx where k = 'acc'), 'member', false,
  array[(select v from tests.ctx where k = 'b2')])).id;
reset role;
create temp table codes as select id, code from public.customer_member_invites;
grant select on codes to authenticated;
select tests.login((select v from tests.ctx where k = 'admin')); set role authenticated;
select public.join_customer_account((select code from codes where id = (select v from tests.ctx where k = 'inv_admin')));
select tests.eq((select count(*)::int from public.customers), 2, 'admin sees both branches');
reset role;
select tests.login((select v from tests.ctx where k = 'member')); set role authenticated;
select tests.throws(format('select public.join_customer_account(%L)', (select code from codes where id = (select v from tests.ctx where k = 'inv_admin'))),
  'invalid, used or expired', 'invite codes work once');
select public.join_customer_account((select code from codes where id = (select v from tests.ctx where k = 'inv_member')));
select tests.eq((select count(*)::int from public.customers), 1, 'branch-limited member sees only their branch');
select tests.eq((select branch_name from public.customers), 'Lake Rd branch', 'member sees the Lake Rd branch');
-- member can order and record usage on their branch
insert into tests.ctx select 'ord', (public.place_order((select v from tests.ctx where k = 'b2'), 5)).id;
select public.record_consumption((select v from tests.ctx where k = 'b2'), 1);
select tests.throws(format('select public.place_order(%L, 5)', (select v from tests.ctx where k = 'b1')), 'Not allowed', 'member cannot order for other branches');
select tests.throws(format('select public.submit_payment(%L, 100, %L, %L)', (select v from tests.ctx where k = 'b2'), 'upi', 'UPI12345'),
  'owner or an admin', 'member cannot pay bills');
select tests.eq((public.get_customer_summary((select v from tests.ctx where k = 'b2')) ->> 'can_see_money')::boolean, false, 'member summary hides money');
select tests.throws($$select public.create_member_invite((select id from public.customer_accounts), 'member')$$, 'owner or an admin', 'member cannot invite others');
reset role;
select tests.login((select v from tests.ctx where k = 'outsider')); set role authenticated;
select tests.eq((select count(*)::int from public.customers), 0, 'outsiders see nothing');
select tests.throws(format('select public.place_order(%L, 1)', (select v from tests.ctx where k = 'b1')), 'Not allowed', 'outsiders cannot order');
reset role;

-- Notifications reach every member with access
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
insert into tests.ctx select 'd2', (public.record_delivery((select v from tests.ctx where k = 'b2'), 6, 6, (date_trunc('month', current_date) - interval '10 days')::date)).id;
insert into tests.ctx select 'd1', (public.record_delivery((select v from tests.ctx where k = 'b1'), 10, 10, (date_trunc('month', current_date) - interval '12 days')::date)).id;
reset role;
select tests.eq((select count(distinct user_id)::int from public.notifications where notification_type = 'delivery_confirmation_required'
  and data ->> 'delivery_id' = (select v from tests.ctx where k = 'd2')::text), 3, 'Lake Rd delivery alert sent to owner, admin and member');
select tests.eq((select count(distinct user_id)::int from public.notifications where notification_type = 'delivery_confirmation_required'
  and data ->> 'delivery_id' = (select v from tests.ctx where k = 'd1')::text), 2, 'head office alert not sent to the Lake Rd-only member');
select tests.login((select v from tests.ctx where k = 'member')); set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'd2'), 5, 'one can missing');
reset role;
select tests.login((select v from tests.ctx where k = 'admin')); set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'd1'), 10);
reset role;

-- Combined bill: one invoice for both branches
select public.run_monthly_billing(current_date);
select tests.eq((select count(*)::int from public.invoices), 1, 'one combined invoice for two branches');
select tests.eq((select total_quantity from public.invoices), 15, 'combined cans = 10 + 5 confirmed');
select tests.eq((select subtotal from public.invoices), 600.00::numeric, '15 cans × ₹40');
select tests.eq((select customer_id from public.invoices), (select v from tests.ctx where k = 'b1'), 'billed to the head branch');
select tests.eq((select count(*)::int from public.invoice_items where description like 'Lake Rd branch – %'), 1, 'items labelled by branch');
select tests.eq((select customer_snapshot ->> 'customer_name' from public.invoices), 'Raja Stores', 'bill addressed to the company');
select tests.eq((select count(distinct user_id)::int from public.notifications where notification_type = 'bill_generated'), 2,
  'bill notice to owner and admin only');
select tests.login((select v from tests.ctx where k = 'member')); set role authenticated;
select tests.eq((select count(*)::int from public.invoices), 0, 'member cannot see bills');
reset role;
select tests.login((select v from tests.ctx where k = 'admin')); set role authenticated;
select tests.eq((select count(*)::int from public.invoices), 1, 'admin sees the combined bill');
select public.submit_payment((select v from tests.ctx where k = 'b2'), 200, 'cash');
reset role;
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select public.verify_payment((select id from public.payments limit 1), true);
select public.record_payment((select v from tests.ctx where k = 'b2'), 100, 'cash');
select tests.eq((select balance from public.list_supplier_customers() where id = (select v from tests.ctx where k = 'b1')), 300.00::numeric,
  'payments on any branch reduce the combined balance (600 − 200 − 100)');
select tests.eq((select balance from public.list_supplier_customers() where id = (select v from tests.ctx where k = 'b2')), null::numeric,
  'child branch shows no separate balance');
select tests.eq((select status::text from public.invoices), 'partially_paid', 'combined invoice partially paid');
reset role;

-- Blocking a member and roles
select tests.login((select v from tests.ctx where k = 'admin')); set role authenticated;
select tests.throws(format('select public.update_account_member(%L, null, %L)',
  (select id from public.customer_account_members where role = 'owner'), 'blocked'), 'owner cannot', 'nobody can block the owner');
select public.update_account_member((select m.id from public.customer_account_members m join public.profiles p on p.id = m.user_id where p.email = 'm@acc.in'), null, 'blocked');
reset role;
select tests.login((select v from tests.ctx where k = 'member')); set role authenticated;
select tests.eq((select count(*)::int from public.customers), 0, 'blocked member loses access immediately');
reset role;

-- Old app versions (no account id) still connect: an account is created for them
insert into tests.ctx values ('legacy', tests.create_user('l@acc.in', 'customer', 'Legacy User'));
select tests.login((select v from tests.ctx where k = 'legacy')); set role authenticated;
select public.connect_to_supplier('Legacy User', '9400000099', '1 Old St', null, tests.supplier_code(1), null, 3, 1);
select tests.eq((select count(*)::int from public.customer_accounts), 1, 'legacy connect creates an account');
select tests.eq((select role::text from public.customer_account_members), 'owner', 'legacy user owns it');
reset role;
