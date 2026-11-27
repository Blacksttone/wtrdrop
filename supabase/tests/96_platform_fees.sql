-- Platform service fees: customer fee lines, first month free, supplier Waterdrop bill, admin controls
insert into tests.ctx values
  ('sup', tests.create_user('s@fee.in', 'supplier', 'Ravi')),
  ('drv', tests.create_user('d@fee.in', 'supplier', 'Dinesh')),
  ('home', tests.create_user('h@fee.in', 'customer', 'Meena')),
  ('store', tests.create_user('st@fee.in', 'customer', 'Raja Stores')),
  ('co1', tests.create_user('c1@fee.in', 'customer', 'Small Co')),
  ('co', tests.create_user('c@fee.in', 'customer', 'Big Co')),
  ('newbie', tests.create_user('n@fee.in', 'customer', 'New Home')),
  ('admin', tests.create_user('a@fee.in', 'customer', 'Owner'));
update public.profiles set role = 'admin' where id = (select v from tests.ctx where k = 'admin');

select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
insert into tests.ctx select 'sid', (public.register_supplier('Blue Waters', 'Ravi', '9400000001', null, 'Anna Nagar', 'Anna Nagar', 40)).id;
create temp table _inv as select (public.create_staff_invite('delivery', 'Dinesh')).code;
reset role;
grant select on _inv to authenticated;
select tests.login((select v from tests.ctx where k = 'drv')); set role authenticated;
select public.join_supplier_as_staff((select code from _inv));
reset role;

-- Customers (all connect by supplier code)
select tests.login((select v from tests.ctx where k = 'home')); set role authenticated;
insert into tests.ctx select 'h', (public.connect_to_supplier('Meena', '9400000010', '1 Lake View', null, tests.supplier_code(1), null, 5, 2)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'store')); set role authenticated;
insert into tests.ctx select 'sacc', (public.create_customer_account('Raja Stores', 'store')).id;
insert into tests.ctx select 's1', (public.connect_to_supplier('Raja', '9400000011', '2 Market Rd', null, tests.supplier_code(1), null, 5, 2,
  'shop', 3, (select v from tests.ctx where k = 'sacc'), 'Main')).id;
reset role;
select tests.login((select v from tests.ctx where k = 'co1')); set role authenticated;
insert into tests.ctx select 'c1acc', (public.create_customer_account('Small Co', 'company')).id;
insert into tests.ctx select 'c1', (public.connect_to_supplier('Small', '9400000012', '3 IT Park', null, tests.supplier_code(1), null, 5, 2,
  'office', 10, (select v from tests.ctx where k = 'c1acc'), 'Office')).id;
reset role;
select tests.login((select v from tests.ctx where k = 'co')); set role authenticated;
insert into tests.ctx select 'cacc', (public.create_customer_account('Big Co', 'company')).id;
insert into tests.ctx select 'b1', (public.connect_to_supplier('Big', '9400000013', '4 Head Office', null, tests.supplier_code(1), null, 5, 2,
  'office', 50, (select v from tests.ctx where k = 'cacc'), 'Head office')).id;
insert into tests.ctx select 'b2', (public.connect_to_supplier('Big', '9400000014', '5 Branch Two', null, tests.supplier_code(1), null, 5, 2,
  'office', 20, (select v from tests.ctx where k = 'cacc'), 'Branch 2')).id;
insert into tests.ctx select 'b3', (public.connect_to_supplier('Big', '9400000015', '6 Branch Three', null, tests.supplier_code(1), null, 5, 2,
  'office', 20, (select v from tests.ctx where k = 'cacc'), 'Branch 3')).id;
reset role;
select tests.login((select v from tests.ctx where k = 'newbie')); set role authenticated;
insert into tests.ctx select 'n', (public.connect_to_supplier('New', '9400000016', '7 New St', null, tests.supplier_code(1), null, 5, 2)).id;
reset role;

-- Everyone except "newbie" joined two months ago (so last month is billable).
update public.customer_accounts set created_at = now() - interval '62 days'
  where owner_id <> (select v from tests.ctx where k = 'newbie');
update public.customers set created_at = created_at - interval '62 days'
  where id <> (select v from tests.ctx where k = 'n');
update public.suppliers set created_at = now() - interval '62 days';
create temp table _m as select (date_trunc('month', current_date) - interval '1 month')::date as lm, date_trunc('month', current_date)::date as tm;
grant select on _m to authenticated;

-- Fee per branch
select tests.eq(public.branch_platform_fee((select v from tests.ctx where k = 'h'), (select lm from _m)), 59::numeric, 'home ₹59');
select tests.eq(public.branch_platform_fee((select v from tests.ctx where k = 's1'), (select lm from _m)), 99::numeric, 'store branch ₹99');
select tests.eq(public.branch_platform_fee((select v from tests.ctx where k = 'c1'), (select lm from _m)), 99::numeric, 'single-branch company ₹99');
select tests.eq(public.branch_platform_fee((select v from tests.ctx where k = 'b1'), (select lm from _m)), 149::numeric, 'company head branch ₹149');
select tests.eq(public.branch_platform_fee((select v from tests.ctx where k = 'b2'), (select lm from _m)), 99::numeric, 'company extra branch ₹99');
select tests.eq(public.branch_platform_fee((select v from tests.ctx where k = 'n'), (select tm from _m)), 0::numeric, 'first calendar month free');
select tests.eq(public.branch_platform_fee((select v from tests.ctx where k = 'h'), (select lm from _m) - 31), 0::numeric, 'month of joining is free');

-- Bills for last month: deliveries + service fee lines
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
insert into tests.ctx select 'd', (public.record_delivery((select v from tests.ctx where k = 'h'), 3, 3, (select lm from _m) + 5)).id;
reset role;
select tests.login((select v from tests.ctx where k = 'home')); set role authenticated;
select public.confirm_delivery((select v from tests.ctx where k = 'd'), 3);
reset role;
select public.generate_invoice_for_customer(c.id, (select lm from _m),
  ((select tm from _m) - 1), current_date) from public.customers c;
select tests.eq((select platform_fee from public.invoices where customer_id = (select v from tests.ctx where k = 'h')), 59::numeric, 'home bill carries ₹59 fee');
select tests.eq((select current_charges from public.invoices where customer_id = (select v from tests.ctx where k = 'h')), 179::numeric, 'home bill = 3×₹40 + ₹59');
select tests.eq((select total_quantity from public.invoices where customer_id = (select v from tests.ctx where k = 'h')), 3, 'fee line does not count as cans');
select tests.eq((select platform_fee from public.invoices where customer_id = (select v from tests.ctx where k = 'b1')), 347::numeric, 'company 3 branches: 149 + 99 + 99 on the combined bill');
select tests.eq((select count(*)::int from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
                  where i.customer_id = (select v from tests.ctx where k = 'b1') and ii.fee_month is not null), 3, 'one fee line per branch');
select tests.eq((select count(*)::int from public.invoices where customer_id = (select v from tests.ctx where k = 'n')), 0, 'new customer: nothing billed');
select tests.eq((select public.customer_balance((select v from tests.ctx where k = 'h'))), 179::numeric, 'fee is part of what the customer owes');
-- Re-running billing for the same month never charges the fee twice
select public.generate_invoice_for_customer((select v from tests.ctx where k = 'h'), (select lm from _m) + 1,
  ((select tm from _m) - 1), current_date);
select tests.eq((select count(*)::int from public.invoice_items where fee_customer_id = (select v from tests.ctx where k = 'h')), 1, 'fee billed once per month');

-- Supplier Waterdrop bill (bills issued this month count toward this month's bill)
select tests.eq((select total from public.generate_platform_invoice((select v from tests.ctx where k = 'sid'), (select tm from _m))),
  (359 + 29 + 59 + 99 + 99 + 347)::numeric, 'supplier bill = ₹359 + 1 co-worker ₹29 + customer fees');
select tests.login((select v from tests.ctx where k = 'sup')); set role authenticated;
select tests.eq((select coworkers from public.platform_invoices), 1, 'owner sees own Waterdrop bill');
select tests.eq((select (public.my_platform_summary() ->> 'coworkers')::int), 1, 'summary counts co-workers');
select tests.throws($q$select public.admin_set_platform_invoice_status((select id from public.platform_invoices limit 1), 'paid')$q$, 'admin', 'supplier cannot mark own bill paid');
reset role;
select tests.login((select v from tests.ctx where k = 'drv')); set role authenticated;
select tests.eq((select count(*)::int from public.platform_invoices), 0, 'delivery staff cannot see the Waterdrop bill');
reset role;
select tests.login((select v from tests.ctx where k = 'home')); set role authenticated;
select tests.eq((select count(*)::int from public.platform_invoices), 0, 'customers cannot see supplier bills');
select tests.throws($q$select public.admin_update_pricing('{"home_fee": 1}')$q$, 'admin', 'customers cannot change prices');
reset role;

-- Admin
select tests.login((select v from tests.ctx where k = 'admin')); set role authenticated;
select tests.eq((select count(*)::int from public.admin_platform_earnings(null)), 1, 'admin sees supplier bills');
select public.admin_update_pricing('{"home_fee": 69, "owner_upi_id": "owner@okaxis", "owner_payee_name": "Waterdrop"}');
select tests.eq((select home_fee from public.platform_pricing), 69::numeric, 'admin changed the home price');
select public.admin_set_platform_invoice_status((select invoice_id from public.admin_platform_earnings(null) limit 1), 'paid', 'UPI 1234');
select tests.eq((select status from public.platform_invoices limit 1), 'paid', 'admin marked the bill paid');
reset role;
select tests.eq((select total from public.generate_platform_invoice((select v from tests.ctx where k = 'sid'), (select tm from _m))),
  (359 + 29 + 59 + 99 + 99 + 347)::numeric, 'a paid bill is never recalculated');
select tests.eq(public.branch_platform_fee((select v from tests.ctx where k = 'h'), (select tm from _m)), 69::numeric, 'new price applies from now on');
-- Kill switch
update public.platform_pricing set fees_enabled = false;
select tests.eq(public.branch_platform_fee((select v from tests.ctx where k = 'h'), (select tm from _m)), 0::numeric, 'fees can be switched off');
