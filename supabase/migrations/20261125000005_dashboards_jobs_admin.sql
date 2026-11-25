-- =====================================================================
-- Waterdrop — dashboards, reports, admin tools, scheduled jobs and the
-- notification outbox used by Edge Functions.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Customer home: "How many cans? When do they run out? Order now?"
-- ---------------------------------------------------------------------
create or replace function public.get_customer_summary(p_customer_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c public.customers := public.customer_for_actor(p_customer_id, true);
  v_pred jsonb := public.compute_prediction(p_customer_id);
  v_latest_order jsonb;
  v_next_delivery date;
  v_pending_conf integer;
  v_latest_invoice jsonb;
begin
  select to_jsonb(o) into v_latest_order from (
    select id, quantity, status, requested_delivery_date, scheduled_date, is_bulk, created_at
    from public.orders where customer_id = c.id order by created_at desc limit 1) o;

  select min(coalesce(scheduled_date, requested_delivery_date)) into v_next_delivery
  from public.orders where customer_id = c.id and status in ('pending', 'accepted', 'preparing', 'out_for_delivery');

  select count(*) into v_pending_conf from public.deliveries where customer_id = c.id and status = 'awaiting_confirmation';

  select to_jsonb(i) into v_latest_invoice from (
    select id, invoice_number, amount_due, amount_paid, due_date, status, billing_period_start, billing_period_end
    from public.invoices where customer_id = c.id order by generated_at desc limit 1) i;

  return jsonb_build_object(
    'customer_id', c.id,
    'customer_name', c.customer_name,
    'supplier_id', c.supplier_id,
    'thresholds', jsonb_build_object('low', c.low_stock_threshold, 'critical', c.critical_threshold),
    'prediction', v_pred,
    'latest_order', v_latest_order,
    'next_delivery_date', v_next_delivery,
    'pending_confirmations', v_pending_conf,
    'latest_invoice', v_latest_invoice,
    'outstanding_balance', public.customer_balance(c.id),
    'unbilled', public.customer_unbilled(c.id)
  );
end $$;

-- ---------------------------------------------------------------------
-- Supplier home
-- ---------------------------------------------------------------------
create or replace function public.get_supplier_dashboard() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_sid uuid := public.my_supplier_id();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_month_start date := date_trunc('month', v_today)::date;
begin
  if v_sid is null then
    raise exception 'Supplier account required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'today', v_today,
    'total_customers', (select count(*) from public.customers where supplier_id = v_sid and status = 'active'),
    'todays_orders', (select count(*) from public.orders where supplier_id = v_sid
                       and (created_at at time zone 'Asia/Kolkata')::date = v_today),
    'pending_orders', (select count(*) from public.orders where supplier_id = v_sid and status = 'pending'),
    'pending_deliveries', (select count(*) from public.orders where supplier_id = v_sid
                            and status in ('accepted', 'preparing', 'out_for_delivery')),
    'awaiting_confirmation', (select count(*) from public.deliveries where supplier_id = v_sid and status = 'awaiting_confirmation'),
    'delivered_today', (select coalesce(sum(confirmed_quantity + adjusted_quantity), 0) from public.deliveries
                         where supplier_id = v_sid and status = 'confirmed' and delivery_date = v_today),
    'delivered_this_month', (select coalesce(sum(confirmed_quantity + adjusted_quantity), 0) from public.deliveries
                              where supplier_id = v_sid and status = 'confirmed' and delivery_date >= v_month_start),
    'revenue_this_month', (select coalesce(round(sum((confirmed_quantity + adjusted_quantity) * unit_price), 2), 0)
                            from public.deliveries
                            where supplier_id = v_sid and status = 'confirmed' and delivery_date >= v_month_start),
    'collected_this_month', (select coalesce(sum(amount), 0) from public.payments
                              where supplier_id = v_sid and status = 'succeeded' and payment_date >= v_month_start),
    'outstanding_total', (select coalesce(sum(greatest(public.customer_balance(id), 0)), 0)
                           from public.customers where supplier_id = v_sid),
    'pending_payment_verifications', (select count(*) from public.payments where supplier_id = v_sid
                                       and status = 'pending' and payment_method <> 'online'),
    'needs_delivery_today', coalesce((select jsonb_agg(x order by x->>'date') from (
        select jsonb_build_object('order_id', o.id, 'customer_id', c.id, 'customer_name', c.customer_name,
                                  'address', c.address, 'quantity', o.quantity, 'status', o.status,
                                  'date', coalesce(o.scheduled_date, o.requested_delivery_date)) as x
        from public.orders o join public.customers c on c.id = o.customer_id
        where o.supplier_id = v_sid and o.status in ('pending', 'accepted', 'preparing', 'out_for_delivery')
          and coalesce(o.scheduled_date, o.requested_delivery_date, v_today) <= v_today
        limit 50) t), '[]'::jsonb),
    'low_stock_customers', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('customer_id', c.id, 'customer_name', c.customer_name, 'stock', s.current_stock,
                                  'level', public.stock_level_for(s.current_stock, c.low_stock_threshold, c.critical_threshold),
                                  'predicted_empty_date', s.predicted_empty_date,
                                  'has_open_order', exists (select 1 from public.orders o where o.customer_id = c.id
                                     and o.status in ('pending','accepted','preparing','out_for_delivery'))) as x
        from public.customers c join public.customer_stock s on s.customer_id = c.id
        where c.supplier_id = v_sid and c.status = 'active' and s.has_opening_stock
          and (s.current_stock <= c.low_stock_threshold or s.order_recommended)
        order by s.current_stock asc limit 50) t), '[]'::jsonb),
    'discrepancy_customers', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('customer_id', c.id, 'customer_name', c.customer_name,
                                  'deliveries', count(*), 'total_shortage', sum(-d.discrepancy)) as x
        from public.deliveries d join public.customers c on c.id = d.customer_id
        where d.supplier_id = v_sid and d.status = 'confirmed' and d.discrepancy < 0
          and d.delivery_date >= v_today - 30
        group by c.id, c.customer_name order by sum(-d.discrepancy) desc limit 20) t), '[]'::jsonb),
    'outstanding_customers', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('customer_id', c.id, 'customer_name', c.customer_name,
                                  'balance', public.customer_balance(c.id)) as x
        from public.customers c where c.supplier_id = v_sid and public.customer_balance(c.id) > 0
        order by public.customer_balance(c.id) desc limit 20) t), '[]'::jsonb)
  );
end $$;

-- Customer list with stock & balance (supplier)
create or replace function public.list_supplier_customers()
returns table (
  id uuid, customer_name text, phone text, address text, status public.customer_status, has_app boolean,
  current_stock integer, stock_confirmed boolean, level text, predicted_empty_date date,
  daily_consumption integer, can_price numeric, balance numeric, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select c.id, c.customer_name, c.phone, c.address, c.status, c.user_id is not null,
         coalesce(s.current_stock, 0), coalesce(s.has_opening_stock, false),
         case when not coalesce(s.has_opening_stock, false) then 'unknown'
              else case public.stock_level_for(s.current_stock, c.low_stock_threshold, c.critical_threshold)
                     when 'critical' then 'critical' when 'low' then 'low' else 'ok' end end,
         s.predicted_empty_date, c.daily_consumption, public.effective_can_price(c.id),
         public.customer_balance(c.id), c.created_at
  from public.customers c left join public.customer_stock s on s.customer_id = c.id
  where c.supplier_id = public.my_supplier_id()
  order by c.customer_name;
$$;

-- ---------------------------------------------------------------------
-- Reports (supplier-scoped; admins may pass a supplier id)
-- ---------------------------------------------------------------------
create or replace function public.report_scope(p_supplier_id uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if public.is_admin() and p_supplier_id is not null then
    return p_supplier_id;
  end if;
  if public.my_supplier_id() is null then
    raise exception 'Supplier account required' using errcode = '42501';
  end if;
  return public.my_supplier_id();
end $$;

create or replace function public.report_deliveries(p_start date, p_end date, p_supplier_id uuid default null)
returns table (delivery_date date, customer_name text, expected integer, actual integer, confirmed integer,
               adjusted integer, discrepancy integer, status public.delivery_status, unit_price numeric, amount numeric)
language sql stable security definer set search_path = public as $$
  select d.delivery_date, c.customer_name, d.expected_quantity, d.actual_quantity, d.confirmed_quantity,
         d.adjusted_quantity, d.discrepancy, d.status, d.unit_price,
         round(coalesce(d.confirmed_quantity + d.adjusted_quantity, 0) * d.unit_price, 2)
  from public.deliveries d join public.customers c on c.id = d.customer_id
  where d.supplier_id = public.report_scope(p_supplier_id) and d.delivery_date between p_start and p_end
  order by d.delivery_date, c.customer_name;
$$;

create or replace function public.report_customer_consumption(p_start date, p_end date, p_supplier_id uuid default null)
returns table (customer_name text, days_recorded bigint, total_consumed bigint, unmet bigint, avg_per_day numeric,
               cans_received bigint, current_stock integer)
language sql stable security definer set search_path = public as $$
  select c.customer_name,
         (select count(*) from public.consumption_records r where r.customer_id = c.id and r.consumption_date between p_start and p_end),
         (select coalesce(sum(quantity), 0) from public.consumption_records r where r.customer_id = c.id and r.consumption_date between p_start and p_end),
         (select coalesce(sum(unmet_quantity), 0) from public.consumption_records r where r.customer_id = c.id and r.consumption_date between p_start and p_end),
         round((select coalesce(sum(quantity + unmet_quantity), 0) from public.consumption_records r
                 where r.customer_id = c.id and r.consumption_date between p_start and p_end)::numeric
               / greatest(p_end - p_start + 1, 1), 2),
         (select coalesce(sum(confirmed_quantity + adjusted_quantity), 0) from public.deliveries d
           where d.customer_id = c.id and d.status = 'confirmed' and d.delivery_date between p_start and p_end),
         coalesce(s.current_stock, 0)
  from public.customers c left join public.customer_stock s on s.customer_id = c.id
  where c.supplier_id = public.report_scope(p_supplier_id)
  order by c.customer_name;
$$;

create or replace function public.report_delivery_accuracy(p_start date, p_end date, p_supplier_id uuid default null)
returns table (customer_name text, deliveries bigint, expected bigint, claimed bigint, confirmed bigint,
               shortage bigint, excess bigint, accuracy_pct numeric, supplier_confirmed bigint)
language sql stable security definer set search_path = public as $$
  select c.customer_name, count(*), sum(d.expected_quantity), sum(d.actual_quantity), sum(d.confirmed_quantity),
         sum(greatest(-d.discrepancy, 0)), sum(greatest(d.discrepancy, 0)),
         round(100.0 * count(*) filter (where d.confirmed_quantity = d.expected_quantity) / nullif(count(*), 0), 1),
         count(*) filter (where d.confirmed_by_supplier)
  from public.deliveries d join public.customers c on c.id = d.customer_id
  where d.supplier_id = public.report_scope(p_supplier_id) and d.status = 'confirmed'
    and d.delivery_date between p_start and p_end
  group by c.customer_name order by c.customer_name;
$$;

create or replace function public.report_billing(p_start date, p_end date, p_supplier_id uuid default null)
returns table (invoice_number text, invoice_date date, customer_name text, period text, cans integer,
               current_charges numeric, previous_balance numeric, payments_received numeric, credits numeric,
               amount_due numeric, amount_paid numeric, due_date date, status public.invoice_status)
language sql stable security definer set search_path = public as $$
  select i.invoice_number, i.invoice_date, c.customer_name,
         to_char(i.billing_period_start, 'DD Mon') || ' – ' || to_char(i.billing_period_end, 'DD Mon YYYY'),
         i.total_quantity, i.current_charges, i.previous_balance, i.payments_received, i.credits,
         i.amount_due, i.amount_paid, i.due_date, i.status
  from public.invoices i join public.customers c on c.id = i.customer_id
  where i.supplier_id = public.report_scope(p_supplier_id) and i.invoice_date between p_start and p_end
  order by i.invoice_date, c.customer_name;
$$;

create or replace function public.report_outstanding(p_supplier_id uuid default null)
returns table (customer_name text, phone text, balance numeric, last_invoice text, last_due_date date,
               last_payment_date date, overdue boolean)
language sql stable security definer set search_path = public as $$
  select c.customer_name, c.phone, public.customer_balance(c.id),
         li.invoice_number, li.due_date,
         (select max(payment_date) from public.payments p where p.customer_id = c.id and p.status = 'succeeded'),
         coalesce(li.status = 'overdue', false)
  from public.customers c
  left join lateral (select invoice_number, due_date, status from public.invoices i
                     where i.customer_id = c.id order by generated_at desc limit 1) li on true
  where c.supplier_id = public.report_scope(p_supplier_id) and public.customer_balance(c.id) <> 0
  order by public.customer_balance(c.id) desc;
$$;

create or replace function public.report_revenue(p_start date, p_end date, p_supplier_id uuid default null)
returns table (month date, cans_delivered bigint, billed numeric, collected numeric)
language sql stable security definer set search_path = public as $$
  with months as (
    select generate_series(date_trunc('month', p_start), date_trunc('month', p_end), interval '1 month')::date as m
  ), scope as (select public.report_scope(p_supplier_id) as sid)
  select m.m,
         (select coalesce(sum(confirmed_quantity + adjusted_quantity), 0) from public.deliveries d, scope
           where d.supplier_id = scope.sid and d.status = 'confirmed' and date_trunc('month', d.delivery_date) = m.m),
         (select coalesce(sum(current_charges), 0) from public.invoices i, scope
           where i.supplier_id = scope.sid and date_trunc('month', i.invoice_date) = m.m),
         (select coalesce(sum(amount), 0) from public.payments p, scope
           where p.supplier_id = scope.sid and p.status = 'succeeded' and date_trunc('month', p.payment_date) = m.m)
  from months m order by m.m;
$$;

-- ---------------------------------------------------------------------
-- Platform admin
-- ---------------------------------------------------------------------
create or replace function public.require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;
end $$;

create or replace function public.admin_platform_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return jsonb_build_object(
    'suppliers', (select count(*) from public.suppliers),
    'active_suppliers', (select count(*) from public.suppliers where status = 'active'),
    'suspended_suppliers', (select count(*) from public.suppliers where status = 'suspended'),
    'customers', (select count(*) from public.customers),
    'users', (select count(*) from public.profiles),
    'orders_30d', (select count(*) from public.orders where created_at > now() - interval '30 days'),
    'cans_delivered_30d', (select coalesce(sum(confirmed_quantity), 0) from public.deliveries
                            where status = 'confirmed' and delivery_date > current_date - 30),
    'billed_30d', (select coalesce(sum(current_charges), 0) from public.invoices where invoice_date > current_date - 30),
    'collected_30d', (select coalesce(sum(amount), 0) from public.payments where status = 'succeeded' and payment_date > current_date - 30),
    'failed_jobs_7d', (select count(*) from public.job_runs where status = 'failed' and started_at > now() - interval '7 days'),
    'failed_notifications_7d', (select count(*) from public.notifications
                                 where (email_status = 'failed' or whatsapp_status = 'failed') and created_at > now() - interval '7 days')
  );
end $$;

create or replace function public.admin_list_suppliers()
returns table (id uuid, business_name text, business_code text, owner_name text, phone text, email text,
               status public.supplier_status, plan_name text, customers bigint, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.business_name, s.business_code, s.owner_name, s.phone, s.email, s.status, p.name,
         (select count(*) from public.customers c where c.supplier_id = s.id), s.created_at
  from public.suppliers s left join public.subscription_plans p on p.id = s.plan_id
  where public.is_admin()
  order by s.created_at desc;
$$;

create or replace function public.admin_set_supplier_status(p_supplier_id uuid, p_status public.supplier_status, p_reason text)
returns public.suppliers
language plpgsql security definer set search_path = public as $$
declare
  s public.suppliers;
begin
  perform public.require_admin();
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  update public.suppliers set status = p_status where id = p_supplier_id returning * into s;
  if s.id is null then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  perform public.notify(s.owner_id, 'account', case when p_status = 'suspended' then 'critical' else 'success' end,
    case when p_status = 'suspended' then 'Your Waterdrop account was suspended' else 'Your Waterdrop account is active' end,
    coalesce(p_reason, ''), '/supplier', jsonb_build_object('status', p_status));
  perform public.write_audit('admin.supplier_' || p_status::text, 'supplier', s.id, s.id, jsonb_build_object('reason', p_reason));
  return s;
end $$;

create or replace function public.admin_set_supplier_plan(p_supplier_id uuid, p_plan_id uuid) returns public.suppliers
language plpgsql security definer set search_path = public as $$
declare s public.suppliers;
begin
  perform public.require_admin();
  update public.suppliers set plan_id = p_plan_id where id = p_supplier_id returning * into s;
  perform public.write_audit('admin.supplier_plan', 'supplier', s.id, s.id, jsonb_build_object('plan_id', p_plan_id));
  return s;
end $$;

create or replace function public.admin_set_user_disabled(p_user_id uuid, p_disabled boolean, p_reason text)
returns public.profiles
language plpgsql security definer set search_path = public as $$
declare pr public.profiles;
begin
  perform public.require_admin();
  if p_user_id = auth.uid() then
    raise exception 'You cannot disable your own admin account' using errcode = '22023';
  end if;
  update public.profiles set is_disabled = p_disabled where id = p_user_id returning * into pr;
  perform public.write_audit(case when p_disabled then 'admin.user_disabled' else 'admin.user_enabled' end,
                             'profile', p_user_id, null, jsonb_build_object('reason', p_reason));
  return pr;
end $$;

create or replace function public.admin_list_customers(p_search text default null)
returns table (id uuid, customer_name text, phone text, supplier_name text, has_app boolean, user_id uuid,
               user_disabled boolean, status public.customer_status, current_stock integer, balance numeric, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id, c.customer_name, c.phone, s.business_name, c.user_id is not null, c.user_id,
         coalesce(pr.is_disabled, false), c.status, coalesce(cs.current_stock, 0), public.customer_balance(c.id), c.created_at
  from public.customers c
  join public.suppliers s on s.id = c.supplier_id
  left join public.profiles pr on pr.id = c.user_id
  left join public.customer_stock cs on cs.customer_id = c.id
  where public.is_admin()
    and (p_search is null or c.customer_name ilike '%' || p_search || '%' or c.phone ilike '%' || p_search || '%')
  order by c.created_at desc
  limit 500;
$$;

-- ---------------------------------------------------------------------
-- Scheduled jobs (service role / pg_cron only). Each is idempotent.
-- ---------------------------------------------------------------------
create or replace function public.start_job(p_job text, p_key text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  insert into public.job_runs (job_name, run_key) values (p_job, p_key)
  on conflict (job_name, run_key) do update set status = 'running', started_at = now(), error = null
    where public.job_runs.status = 'failed'
  returning id into v_id;
  return v_id;  -- null => already ran/running for this key
end $$;

create or replace function public.finish_job(p_id bigint, p_details jsonb, p_error text default null) returns void
language sql security definer set search_path = public as $$
  update public.job_runs set status = case when p_error is null then 'succeeded' else 'failed' end,
         details = coalesce(p_details, '{}'::jsonb), error = p_error, finished_at = now()
  where id = p_id;
$$;

-- Hourly: creates the expected daily consumption once the customer's local
-- consumption time has passed. Unique (customer, date) prevents duplicates.
create or replace function public.process_auto_consumption(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c record;
  v_local timestamp;
  v_day date;
  v_from date;
  v_created integer := 0;
  v_failed integer := 0;
  v_job bigint;
  v_before integer;
begin
  v_job := public.start_job('auto_consumption', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24'));
  for c in
    select * from public.customers
    where status = 'active' and auto_consumption_enabled and daily_consumption > 0
  loop
    begin
      v_local := p_now at time zone c.timezone;
      -- Catch up at most 2 missed days, never before auto mode was enabled.
      v_from := greatest(coalesce(c.auto_consumption_since, v_local::date), v_local::date - 2);
      v_day := v_from;
      while v_day <= v_local::date loop
        if v_day < v_local::date or v_local::time >= c.auto_consumption_time then
          select count(*) into v_before from public.consumption_records where customer_id = c.id and consumption_date = v_day;
          if v_before = 0 then
            perform public.apply_consumption(c.id, v_day, c.daily_consumption, 'auto', null);
            v_created := v_created + 1;
          end if;
        end if;
        v_day := v_day + 1;
      end loop;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'auto consumption failed for %: %', c.id, sqlerrm;
    end;
  end loop;
  if v_job is not null then
    perform public.finish_job(v_job, jsonb_build_object('created', v_created, 'failed', v_failed));
  end if;
  return jsonb_build_object('created', v_created, 'failed', v_failed);
end $$;

-- Daily: refresh predictions for everyone & re-evaluate alerts.
create or replace function public.refresh_all_predictions() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_n integer := 0;
  v_job bigint := public.start_job('refresh_predictions', to_char(now(), 'YYYY-MM-DD"T"HH24'));
begin
  for r in select customer_id from public.customer_stock s join public.customers c on c.id = s.customer_id
           where c.status = 'active' loop
    perform public.evaluate_stock_alert(r.customer_id);
    perform public.refresh_prediction(r.customer_id);
    v_n := v_n + 1;
  end loop;
  if v_job is not null then
    perform public.finish_job(v_job, jsonb_build_object('customers', v_n));
  end if;
  return jsonb_build_object('customers', v_n);
end $$;

-- Daily: invoice generation for every supplier whose period just closed.
create or replace function public.run_monthly_billing(p_as_of date default current_date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_job bigint := public.start_job('monthly_billing', p_as_of::text);
  v_res jsonb;
begin
  v_res := public.generate_invoices(null, p_as_of);
  if v_job is not null then
    perform public.finish_job(v_job, v_res, case when (v_res ->> 'failed')::int > 0 then 'some invoices failed' end);
  end if;
  return v_res;
end $$;

-- Daily: overdue status + due/overdue reminders (deduplicated per invoice/week).
create or replace function public.process_payment_reminders(p_today date default current_date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  i record;
  v_due integer := 0;
  v_overdue integer := 0;
  v_job bigint := public.start_job('payment_reminders', p_today::text);
  v_inv public.invoices;
begin
  for i in select inv.id from public.invoices inv where inv.superseded_by is null and inv.status <> 'paid' loop
    v_inv := public.refresh_invoice_status(i.id, p_today);
    if v_inv.status = 'paid' then
      continue;
    end if;
    if v_inv.due_date between p_today and p_today + 3 then
      if public.notify((select user_id from public.customers where id = v_inv.customer_id), 'payment_due', 'warning',
           'Water bill due soon',
           format('Bill %s: ₹%s due on %s.', v_inv.invoice_number,
                  to_char(v_inv.amount_due - v_inv.amount_paid, 'FM999999990.00'), to_char(v_inv.due_date, 'DD Mon')),
           '/app/bills', jsonb_build_object('invoice_id', v_inv.id), 'due:' || v_inv.id) is not null then
        v_due := v_due + 1;
      end if;
    elsif v_inv.status = 'overdue' then
      if public.notify((select user_id from public.customers where id = v_inv.customer_id), 'payment_overdue', 'critical',
           'Water bill overdue',
           format('Bill %s is overdue. Outstanding ₹%s (due %s).', v_inv.invoice_number,
                  to_char(v_inv.amount_due - v_inv.amount_paid, 'FM999999990.00'), to_char(v_inv.due_date, 'DD Mon')),
           '/app/bills', jsonb_build_object('invoice_id', v_inv.id),
           'overdue:' || v_inv.id || ':' || to_char(p_today, 'IYYY-IW')) is not null then
        v_overdue := v_overdue + 1;
      end if;
    end if;
  end loop;
  if v_job is not null then
    perform public.finish_job(v_job, jsonb_build_object('due', v_due, 'overdue', v_overdue));
  end if;
  return jsonb_build_object('due_reminders', v_due, 'overdue_reminders', v_overdue);
end $$;

-- Notification outbox claim for the dispatch Edge Function (SKIP LOCKED = safe concurrency).
create or replace function public.claim_notification_batch(p_limit integer default 50)
returns table (id uuid, channel text, user_id uuid, email text, phone text, full_name text, title text,
               message text, link text, severity text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with picked as (
    select n.id from public.notifications n
    where (n.email_status = 'pending' or n.whatsapp_status = 'pending')
      and n.delivery_attempts < 5 and n.created_at > now() - interval '3 days'
    order by n.created_at
    limit p_limit
    for update skip locked
  ), upd as (
    update public.notifications n set
      email_status = case when n.email_status = 'pending' then 'sending' else n.email_status end,
      whatsapp_status = case when n.whatsapp_status = 'pending' then 'sending' else n.whatsapp_status end,
      delivery_attempts = n.delivery_attempts + 1
    from picked where n.id = picked.id
    returning n.id, n.user_id, n.title, n.message, n.link, n.severity, n.email_status, n.whatsapp_status
  )
  select u.id, ch.channel, u.user_id, p.email, p.phone, p.full_name, u.title, u.message, u.link, u.severity
  from upd u join public.profiles p on p.id = u.user_id
  cross join lateral (values ('email', u.email_status), ('whatsapp', u.whatsapp_status)) as ch(channel, st)
  where ch.st = 'sending';
end $$;

create or replace function public.complete_notification_delivery(p_id uuid, p_channel text, p_ok boolean, p_error text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_channel = 'email' then
    update public.notifications set
      email_status = case when p_ok then 'sent' when delivery_attempts >= 5 then 'failed' else 'pending' end,
      last_delivery_error = case when p_ok then last_delivery_error else left(p_error, 500) end
    where id = p_id;
  elsif p_channel = 'whatsapp' then
    update public.notifications set
      whatsapp_status = case when p_ok then 'sent' when delivery_attempts >= 5 then 'failed' else 'pending' end,
      last_delivery_error = case when p_ok then last_delivery_error else left(p_error, 500) end
    where id = p_id;
  end if;
end $$;

-- Lock down job & outbox functions to the service role / database owner.
do $$
declare f text;
begin
  foreach f in array array[
    'public.start_job(text, text)', 'public.finish_job(bigint, jsonb, text)',
    'public.process_auto_consumption(timestamptz)', 'public.refresh_all_predictions()',
    'public.run_monthly_billing(date)', 'public.process_payment_reminders(date)',
    'public.claim_notification_batch(integer)', 'public.complete_notification_delivery(uuid, text, boolean, text)',
    'public.refresh_invoice_status(uuid, date)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Realtime: let clients subscribe to their own notifications/stock.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.notifications, public.customer_stock, public.orders, public.deliveries';
  end if;
end $$;

-- Seed default subscription plans
insert into public.subscription_plans (name, price_monthly, max_customers, features) values
  ('Starter', 0, 50, '["Up to 50 customers", "Delivery confirmation", "Monthly billing"]'),
  ('Growth', 499, 500, '["Up to 500 customers", "Reports & exports", "Email alerts"]'),
  ('Business', 1499, null, '["Unlimited customers", "WhatsApp alerts", "Priority support"]')
on conflict (name) do nothing;
