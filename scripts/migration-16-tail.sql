-- Builds (or refreshes, while unpaid) a supplier's Waterdrop bill for a month.
create or replace function public.generate_platform_invoice(p_supplier_id uuid, p_month date) returns public.platform_invoices
language plpgsql security definer set search_path = public as $$
declare
  s public.suppliers;
  pr public.platform_pricing;
  pi public.platform_invoices;
  v_month date := date_trunc('month', p_month)::date;
  v_sub numeric := 0;
  v_staff integer := 0;
  v_cust numeric;
  v_online numeric;
  v_total numeric;
begin
  select * into s from public.suppliers where id = p_supplier_id;
  select * into pr from public.platform_pricing;
  if s.id is null then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  select * into pi from public.platform_invoices where supplier_id = s.id and month = v_month;
  if pi.status in ('paid', 'waived') then
    return pi;  -- settled bills are never changed
  end if;
  if coalesce(pr.fees_enabled, false) and date_trunc('month', s.created_at at time zone 'Asia/Kolkata')::date < v_month then
    v_sub := pr.supplier_fee;
    select count(*) into v_staff from public.supplier_staff where supplier_id = s.id and status = 'active';
  end if;
  -- Service fees on this supplier's customer bills issued in the month.
  select coalesce(sum(platform_fee), 0) into v_cust from public.invoices
  where supplier_id = s.id and date_trunc('month', invoice_date)::date = v_month;
  v_online := 0;  -- Cashfree split payments (phase 2) will settle part of this automatically
  v_total := round(v_sub + v_staff * coalesce(pr.coworker_fee, 0) + v_cust - v_online, 2);

  insert into public.platform_invoices (supplier_id, invoice_number, month, subscription_fee, coworkers, coworker_fee,
                                        customer_fees, customer_fees_settled_online, total, status, due_date)
  values (s.id, 'WDP-' || s.business_code || '-' || to_char(v_month, 'YYYYMM'), v_month, v_sub, v_staff,
          v_staff * coalesce(pr.coworker_fee, 0), v_cust, v_online, v_total,
          case when v_total <= 0 then 'waived' else 'unpaid' end, (v_month + interval '1 month')::date + 9)
  on conflict (supplier_id, month) do update set
    subscription_fee = excluded.subscription_fee, coworkers = excluded.coworkers, coworker_fee = excluded.coworker_fee,
    customer_fees = excluded.customer_fees, customer_fees_settled_online = excluded.customer_fees_settled_online,
    total = excluded.total, status = excluded.status, generated_at = now()
  returning * into pi;
  return pi;
end $$;

-- Monthly job (1st of the month, India time): bills every supplier for the previous month.
create or replace function public.run_platform_billing(p_as_of date default null) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_month date := (date_trunc('month', coalesce(p_as_of, (now() at time zone 'Asia/Kolkata')::date)) - interval '1 month')::date;
  s record;
  pi public.platform_invoices;
  n integer := 0;
begin
  for s in select id, owner_id from public.suppliers where status = 'active' loop
    pi := public.generate_platform_invoice(s.id, v_month);
    if pi.status = 'unpaid' and pi.total > 0 then
      perform public.notify(s.owner_id, 'payment_due', 'warning', 'Your Waterdrop bill is ready',
        format('Waterdrop bill for %s: ₹%s, due %s.', to_char(v_month, 'Mon YYYY'), to_char(pi.total, 'FM999999990.00'),
               to_char(pi.due_date, 'DD Mon')),
        '/supplier/waterdrop-bill', jsonb_build_object('platform_invoice_id', pi.id), 'platform-bill:' || pi.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Supplier: current month so far (an estimate) + past bills.
create or replace function public.my_platform_summary() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_sid uuid := public.my_manager_supplier_id();
  pr public.platform_pricing;
  s public.suppliers;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  v_staff integer;
  v_cust numeric;
  v_free boolean;
begin
  if v_sid is null then
    raise exception 'Only the owner or a manager can see the Waterdrop bill' using errcode = '42501';
  end if;
  select * into pr from public.platform_pricing;
  select * into s from public.suppliers where id = v_sid;
  v_free := date_trunc('month', s.created_at at time zone 'Asia/Kolkata')::date >= v_month or not pr.fees_enabled;
  select count(*) into v_staff from public.supplier_staff where supplier_id = v_sid and status = 'active';
  select coalesce(sum(platform_fee), 0) into v_cust from public.invoices
  where supplier_id = v_sid and date_trunc('month', invoice_date)::date = v_month;
  return jsonb_build_object(
    'month', v_month,
    'free_month', v_free,
    'subscription_fee', case when v_free then 0 else pr.supplier_fee end,
    'coworkers', v_staff,
    'coworker_fee', case when v_free then 0 else v_staff * pr.coworker_fee end,
    'customer_fees_so_far', v_cust,
    'estimate', case when v_free then 0 else pr.supplier_fee + v_staff * pr.coworker_fee end + v_cust,
    'prices', jsonb_build_object('supplier', pr.supplier_fee, 'coworker', pr.coworker_fee, 'home', pr.home_fee,
                                 'store_branch', pr.store_branch_fee, 'company_single', pr.company_single_fee,
                                 'company_head', pr.company_head_fee, 'company_extra_branch', pr.company_extra_branch_fee),
    'pay_to', jsonb_build_object('upi_id', pr.owner_upi_id, 'name', pr.owner_payee_name),
    'unpaid_total', (select coalesce(sum(total), 0) from public.platform_invoices where supplier_id = v_sid and status = 'unpaid')
  );
end $$;

-- Admin: prices.
create or replace function public.admin_update_pricing(p jsonb) returns public.platform_pricing
language plpgsql security definer set search_path = public as $$
declare r public.platform_pricing;
begin
  perform public.require_admin();
  update public.platform_pricing set
    home_fee = coalesce((p ->> 'home_fee')::numeric, home_fee),
    store_branch_fee = coalesce((p ->> 'store_branch_fee')::numeric, store_branch_fee),
    company_single_fee = coalesce((p ->> 'company_single_fee')::numeric, company_single_fee),
    company_head_fee = coalesce((p ->> 'company_head_fee')::numeric, company_head_fee),
    company_extra_branch_fee = coalesce((p ->> 'company_extra_branch_fee')::numeric, company_extra_branch_fee),
    supplier_fee = coalesce((p ->> 'supplier_fee')::numeric, supplier_fee),
    coworker_fee = coalesce((p ->> 'coworker_fee')::numeric, coworker_fee),
    fees_enabled = coalesce((p ->> 'fees_enabled')::boolean, fees_enabled),
    owner_upi_id = case when p ? 'owner_upi_id' then nullif(trim(p ->> 'owner_upi_id'), '') else owner_upi_id end,
    owner_payee_name = case when p ? 'owner_payee_name' then nullif(trim(p ->> 'owner_payee_name'), '') else owner_payee_name end,
    updated_at = now(), updated_by = auth.uid()
  where id  -- single settings row (Supabase rejects UPDATE without WHERE)
  returning * into r;
  perform public.write_audit('platform.pricing_updated', 'platform_pricing', null, null, p);
  return r;
end $$;

-- Admin: earnings overview + mark a supplier bill paid / waived.
create or replace function public.admin_platform_earnings(p_month date default null)
returns table (invoice_id uuid, supplier_id uuid, business_name text, month date, subscription_fee numeric, coworkers integer,
               coworker_fee numeric, customer_fees numeric, total numeric, status text, due_date date, paid_at timestamptz,
               payment_reference text)
language sql stable security definer set search_path = public as $$
  select pi.id, s.id, s.business_name, pi.month, pi.subscription_fee, pi.coworkers, pi.coworker_fee, pi.customer_fees,
         pi.total, pi.status, pi.due_date, pi.paid_at, pi.payment_reference
  from public.platform_invoices pi join public.suppliers s on s.id = pi.supplier_id
  where public.is_admin() and (p_month is null or pi.month = date_trunc('month', p_month)::date)
  order by pi.month desc, s.business_name;
$$;

create or replace function public.admin_set_platform_invoice_status(p_invoice_id uuid, p_status text, p_reference text default null)
returns public.platform_invoices
language plpgsql security definer set search_path = public as $$
declare pi public.platform_invoices;
begin
  perform public.require_admin();
  if p_status not in ('paid', 'unpaid', 'waived') then
    raise exception 'Status must be paid, unpaid or waived' using errcode = '22023';
  end if;
  update public.platform_invoices set status = p_status,
    paid_at = case when p_status = 'paid' then now() else null end,
    payment_reference = case when p_status = 'paid' then nullif(trim(coalesce(p_reference, '')), '') else null end,
    marked_by = auth.uid()
  where id = p_invoice_id returning * into pi;
  if pi.id is null then
    raise exception 'Bill not found' using errcode = 'P0002';
  end if;
  perform public.write_audit('platform.invoice_' || p_status, 'platform_invoice', pi.id, pi.supplier_id,
                             jsonb_build_object('total', pi.total, 'reference', pi.payment_reference));
  return pi;
end $$;

-- Admin: create / refresh bills now (e.g. to check this month's numbers).
create or replace function public.admin_generate_platform_invoices(p_month date) returns integer
language plpgsql security definer set search_path = public as $$
declare s record; n integer := 0;
begin
  perform public.require_admin();
  for s in select id from public.suppliers where status = 'active' loop
    perform public.generate_platform_invoice(s.id, p_month);
    n := n + 1;
  end loop;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.my_platform_summary()', 'public.admin_update_pricing(jsonb)', 'public.admin_platform_earnings(date)',
    'public.admin_set_platform_invoice_status(uuid, text, text)', 'public.admin_generate_platform_invoices(date)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.branch_platform_fee(uuid, date)', 'public.generate_platform_invoice(uuid, date)', 'public.run_platform_billing(date)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- 1st of every month, 06:05 India time (00:35 UTC): supplier Waterdrop bills for the previous month.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('wd-platform-billing', '35 0 1 * *', $c$ select public.run_platform_billing(); $c$);
  end if;
end $$;
