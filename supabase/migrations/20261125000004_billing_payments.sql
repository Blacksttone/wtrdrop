-- =====================================================================
-- Waterdrop — monthly billing, payments, credit notes.
--
-- Bills are built ONLY from confirmed deliveries (+ delivery adjustments),
-- never from consumption. Invoices chain balances:
--   amount_due = previous_balance + current_charges − payments_received − credits
-- where payments/credits are those received since the previous invoice.
-- Idempotency: unique (customer, period) + every delivery billable once.
-- =====================================================================

create or replace function public.customer_balance(p_customer_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select round(
      coalesce((select opening_balance from public.customers where id = p_customer_id), 0)
    + coalesce((select sum(current_charges) from public.invoices where customer_id = p_customer_id), 0)
    - coalesce((select sum(amount) from public.payments where customer_id = p_customer_id and status = 'succeeded'), 0)
    - coalesce((select sum(amount) from public.credit_notes where customer_id = p_customer_id), 0), 2);
$$;

-- Confirmed but not-yet-invoiced delivery value.
create or replace function public.customer_unbilled(p_customer_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with d as (
    select dl.confirmed_quantity as qty, dl.confirmed_quantity * dl.unit_price as amount
    from public.deliveries dl
    where dl.customer_id = p_customer_id and dl.status = 'confirmed'
      and not exists (select 1 from public.invoice_items ii where ii.delivery_id = dl.id)
    union all
    select a.delta, a.delta * a.unit_price
    from public.delivery_adjustments a
    where a.customer_id = p_customer_id
      and not exists (select 1 from public.invoice_items ii where ii.delivery_adjustment_id = a.id)
  )
  select jsonb_build_object('quantity', coalesce(sum(qty), 0), 'amount', round(coalesce(sum(amount), 0), 2)) from d;
$$;

-- Billing period that most recently completed as of p_as_of.
create or replace function public.billing_period_for(p_billing_day integer, p_as_of date)
returns table (period_start date, period_end date)
language sql immutable as $$
  with b as (
    select case
      when extract(day from p_as_of)::int >= p_billing_day
        then make_date(extract(year from p_as_of)::int, extract(month from p_as_of)::int, p_billing_day)
      else (make_date(extract(year from p_as_of)::int, extract(month from p_as_of)::int, p_billing_day) - interval '1 month')::date
    end as bill_date
  )
  select (bill_date - interval '1 month')::date, bill_date - 1 from b;
$$;

create or replace function public.refresh_invoice_status(p_invoice_id uuid, p_today date default current_date) returns public.invoices
language plpgsql security definer set search_path = public as $$
declare
  i public.invoices;
  v_next timestamptz;
  v_paid numeric;
  v_status public.invoice_status;
begin
  select * into i from public.invoices where id = p_invoice_id;
  if i.id is null then
    return null;
  end if;
  select generated_at into v_next from public.invoices where id = i.superseded_by;
  -- Settled amount = payments + credits received after this invoice (until superseded)
  select coalesce((select sum(amount) from public.payments
                    where customer_id = i.customer_id and status = 'succeeded'
                      and received_at > i.generated_at and (v_next is null or received_at <= v_next)), 0)
       + coalesce((select sum(amount) from public.credit_notes
                    where customer_id = i.customer_id
                      and created_at > i.generated_at and (v_next is null or created_at <= v_next)), 0)
    into v_paid;

  v_status := case
    when i.amount_due <= 0 or v_paid >= i.amount_due then 'paid'
    when i.due_date < p_today then 'overdue'
    when v_paid > 0 then 'partially_paid'
    else 'unpaid'
  end;
  update public.invoices set amount_paid = round(v_paid, 2), status = v_status
   where id = i.id and (amount_paid is distinct from round(v_paid, 2) or status is distinct from v_status)
  returning * into i;
  if i.id is null then
    select * into i from public.invoices where id = p_invoice_id;
  end if;
  return i;
end $$;

create or replace function public.generate_invoice_for_customer(
  p_customer_id uuid, p_period_start date, p_period_end date, p_invoice_date date default current_date
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c public.customers;
  sup public.suppliers;
  st public.supplier_settings;
  prev public.invoices;
  v_existing uuid;
  v_inv uuid;
  v_number text;
  v_seq integer;
  v_qty integer;
  v_subtotal numeric;
  v_tax numeric;
  v_payments numeric;
  v_credits numeric;
  v_prev_balance numeric;
  v_due numeric;
  v_items integer;
  v_now timestamptz;
begin
  if p_period_end < p_period_start then
    raise exception 'Invalid billing period' using errcode = '22023';
  end if;
  -- Lock the customer: serializes billing with payments/credits for this account.
  select * into c from public.customers where id = p_customer_id for update;
  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;

  select id into v_existing from public.invoices
   where customer_id = c.id and billing_period_start = p_period_start and billing_period_end = p_period_end;
  if v_existing is not null then
    return v_existing;   -- idempotent re-run
  end if;

  select * into sup from public.suppliers where id = c.supplier_id;
  select * into st from public.supplier_settings where supplier_id = c.supplier_id for update;
  select * into prev from public.invoices where customer_id = c.id order by generated_at desc limit 1;

  create temporary table if not exists _wd_items (
    delivery_id uuid, adjustment_id uuid, item_date date, description text, quantity integer, unit_price numeric, amount numeric
  ) on commit drop;
  truncate _wd_items;

  insert into _wd_items
  select d.id, null, d.delivery_date,
         format('Water cans delivered (confirmed %s of %s expected)', d.confirmed_quantity, d.expected_quantity),
         d.confirmed_quantity, d.unit_price, round(d.confirmed_quantity * d.unit_price, 2)
  from public.deliveries d
  where d.customer_id = c.id and d.status = 'confirmed' and d.delivery_date <= p_period_end
    and not exists (select 1 from public.invoice_items ii where ii.delivery_id = d.id);

  insert into _wd_items
  select null, a.id, (a.created_at at time zone c.timezone)::date,
         format('Delivery correction: %s', a.reason), a.delta, a.unit_price, round(a.delta * a.unit_price, 2)
  from public.delivery_adjustments a
  where a.customer_id = c.id and (a.created_at at time zone c.timezone)::date <= p_period_end
    and not exists (select 1 from public.invoice_items ii where ii.delivery_adjustment_id = a.id);

  select count(*), coalesce(sum(quantity), 0), coalesce(sum(amount), 0) into v_items, v_qty, v_subtotal from _wd_items;

  v_now := clock_timestamp();
  v_prev_balance := coalesce(prev.amount_due, c.opening_balance, 0);
  select coalesce(sum(amount), 0) into v_payments from public.payments
   where customer_id = c.id and status = 'succeeded'
     and (prev.id is null or received_at > prev.generated_at) and received_at <= v_now;
  select coalesce(sum(amount), 0) into v_credits from public.credit_notes
   where customer_id = c.id and (prev.id is null or created_at > prev.generated_at) and created_at <= v_now;

  -- Nothing to bill and nothing carried: skip (safe to re-run later).
  if v_items = 0 and v_prev_balance = 0 and v_payments = 0 and v_credits = 0 then
    return null;
  end if;

  v_tax := round(v_subtotal * st.tax_rate / 100, 2);
  v_due := round(v_prev_balance + v_subtotal + v_tax - v_payments - v_credits, 2);

  perform set_config('waterdrop.billing_engine', 'on', true);
  update public.supplier_settings set invoice_seq = invoice_seq + 1 where id = st.id returning invoice_seq into v_seq;
  perform set_config('waterdrop.billing_engine', 'off', true);
  v_number := st.invoice_prefix || '-' || sup.business_code || '-' || to_char(p_invoice_date, 'YYYYMM') || '-' || lpad(v_seq::text, 4, '0');

  insert into public.invoices (supplier_id, customer_id, invoice_number, invoice_date, billing_period_start,
    billing_period_end, total_quantity, subtotal, tax_rate, tax_amount, current_charges, previous_balance,
    payments_received, credits, amount_due, due_date, status, supplier_snapshot, customer_snapshot, generated_at)
  values (c.supplier_id, c.id, v_number, p_invoice_date, p_period_start, p_period_end, v_qty, v_subtotal,
    st.tax_rate, v_tax, v_subtotal + v_tax, v_prev_balance, v_payments, v_credits, v_due,
    p_invoice_date + st.billing_due_days,
    case when v_due <= 0 then 'paid'::public.invoice_status else 'unpaid'::public.invoice_status end,
    jsonb_build_object('business_name', sup.business_name, 'owner_name', sup.owner_name, 'address', sup.address,
                       'phone', sup.phone, 'email', sup.email, 'logo_url', sup.logo_url, 'billing_info', sup.billing_info,
                       'business_code', sup.business_code, 'tax_label', st.tax_label),
    jsonb_build_object('customer_name', c.customer_name, 'address', c.address, 'phone', c.phone),
    v_now)
  returning id into v_inv;

  insert into public.invoice_items (invoice_id, delivery_id, delivery_adjustment_id, item_date, description, quantity, unit_price, amount)
  select v_inv, delivery_id, adjustment_id, item_date, description, quantity, unit_price, amount
  from _wd_items order by item_date, description;

  if prev.id is not null then
    update public.invoices set superseded_by = v_inv where id = prev.id;
    perform public.refresh_invoice_status(prev.id);
  end if;

  perform public.notify(c.user_id, 'bill_generated', 'info', 'Your monthly water bill is ready',
    format('Bill %s for %s – %s: %s cans. Amount due ₹%s by %s.', v_number, to_char(p_period_start, 'DD Mon'),
           to_char(p_period_end, 'DD Mon YYYY'), v_qty, to_char(v_due, 'FM999999990.00'),
           to_char(p_invoice_date + st.billing_due_days, 'DD Mon')),
    '/app/bills', jsonb_build_object('invoice_id', v_inv), 'bill:' || v_inv);
  update public.invoices set notified_at = now() where id = v_inv;
  perform public.write_audit('invoice.generated', 'invoice', v_inv, c.supplier_id,
    jsonb_build_object('number', v_number, 'amount_due', v_due, 'quantity', v_qty));
  return v_inv;
end $$;
revoke execute on function public.generate_invoice_for_customer(uuid, date, date, date) from public, anon, authenticated;

-- Generate the just-completed period's invoices for one/all suppliers. Safe to re-run.
create or replace function public.generate_invoices(p_supplier_id uuid default null, p_as_of date default current_date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s record;
  cust record;
  v_start date;
  v_end date;
  v_inv uuid;
  v_created integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_before integer;
begin
  for s in
    select sp.id, st.billing_day from public.suppliers sp join public.supplier_settings st on st.supplier_id = sp.id
    where sp.status = 'active' and (p_supplier_id is null or sp.id = p_supplier_id)
  loop
    -- Prevent two concurrent runs for the same supplier.
    if not pg_try_advisory_xact_lock(hashtext('wd_billing:' || s.id::text)) then
      continue;
    end if;
    select period_start, period_end into v_start, v_end from public.billing_period_for(s.billing_day, p_as_of);
    for cust in select id from public.customers where supplier_id = s.id loop
      begin
        select count(*) into v_before from public.invoices
         where customer_id = cust.id and billing_period_start = v_start and billing_period_end = v_end;
        v_inv := public.generate_invoice_for_customer(cust.id, v_start, v_end, p_as_of);
        if v_inv is not null and v_before = 0 then
          v_created := v_created + 1;
        else
          v_skipped := v_skipped + 1;
        end if;
      exception when others then
        v_failed := v_failed + 1;
        v_errors := v_errors || jsonb_build_object('customer_id', cust.id, 'error', sqlerrm);
      end;
    end loop;
  end loop;
  return jsonb_build_object('created', v_created, 'skipped', v_skipped, 'failed', v_failed, 'errors', v_errors);
end $$;
revoke execute on function public.generate_invoices(uuid, date) from public, anon, authenticated;

-- Supplier-triggered billing (current completed period, or a custom period).
create or replace function public.run_my_billing(p_period_start date default null, p_period_end date default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  cust record;
  v_created integer := 0;
  v_inv uuid;
  v_before integer;
begin
  if p_period_start is null or p_period_end is null then
    return public.generate_invoices(v_sid, current_date);
  end if;
  if p_period_end >= current_date then
    raise exception 'Billing period must have ended before today' using errcode = '22023';
  end if;
  if p_period_end - p_period_start > 62 then
    raise exception 'Billing period cannot exceed 2 months' using errcode = '22023';
  end if;
  for cust in select id from public.customers where supplier_id = v_sid loop
    select count(*) into v_before from public.invoices
     where customer_id = cust.id and billing_period_start = p_period_start and billing_period_end = p_period_end;
    v_inv := public.generate_invoice_for_customer(cust.id, p_period_start, p_period_end, current_date);
    if v_inv is not null and v_before = 0 then
      v_created := v_created + 1;
    end if;
  end loop;
  return jsonb_build_object('created', v_created);
end $$;

-- ---------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------
create or replace function public.finalize_payment(p_payment_id uuid, p_verified_by uuid) returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  p public.payments;
  c public.customers;
  v_inv uuid;
begin
  select * into p from public.payments where id = p_payment_id;
  -- Same lock as billing so payment windows never straddle an invoice boundary.
  select * into c from public.customers where id = p.customer_id for update;
  select * into p from public.payments where id = p_payment_id for update;
  if p.status = 'succeeded' then
    return p;  -- idempotent
  end if;
  if p.status not in ('pending') then
    raise exception 'Payment is %', p.status using errcode = '22023';
  end if;
  v_inv := coalesce(p.invoice_id,
    (select id from public.invoices where customer_id = p.customer_id and superseded_by is null
      order by generated_at desc limit 1));

  update public.payments set status = 'succeeded', received_at = clock_timestamp(), verified_by = p_verified_by,
         verified_at = now(), invoice_id = v_inv
   where id = p.id returning * into p;

  if v_inv is not null then
    insert into public.payment_allocations (payment_id, invoice_id, amount) values (p.id, v_inv, p.amount)
    on conflict do nothing;
    perform public.refresh_invoice_status(v_inv);
  end if;

  perform public.notify(c.user_id, 'payment_received', 'success', 'Payment received',
    format('₹%s received via %s. Thank you!', to_char(p.amount, 'FM999999990.00'), replace(p.payment_method::text, '_', ' ')),
    '/app/payments', jsonb_build_object('payment_id', p.id), 'payment_received:' || p.id);
  perform public.write_audit('payment.succeeded', 'payment', p.id, p.supplier_id,
    jsonb_build_object('amount', p.amount, 'method', p.payment_method, 'invoice_id', v_inv));
  return p;
end $$;
revoke execute on function public.finalize_payment(uuid, uuid) from public, anon, authenticated;

-- Supplier records cash / UPI / bank transfer received.
create or replace function public.record_payment(
  p_customer_id uuid, p_amount numeric, p_method public.payment_method, p_reference text default null,
  p_payment_date date default current_date, p_invoice_id uuid default null, p_notes text default null
) returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  c public.customers;
  p public.payments;
begin
  select * into c from public.customers where id = p_customer_id and supplier_id = v_sid;
  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if p_method = 'online' then
    raise exception 'Online payments are confirmed automatically by the payment gateway' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero' using errcode = '22023';
  end if;
  if p_invoice_id is not null and not exists (select 1 from public.invoices where id = p_invoice_id and customer_id = c.id) then
    raise exception 'Invoice does not belong to this customer' using errcode = '22023';
  end if;
  if p_payment_date > current_date then
    raise exception 'Payment date cannot be in the future' using errcode = '22023';
  end if;
  insert into public.payments (supplier_id, customer_id, invoice_id, amount, payment_method, reference_number,
                               payment_date, status, recorded_by, notes)
  values (v_sid, c.id, p_invoice_id, round(p_amount, 2), p_method, nullif(trim(coalesce(p_reference, '')), ''),
          coalesce(p_payment_date, current_date), 'pending', auth.uid(), p_notes)
  returning * into p;
  return public.finalize_payment(p.id, auth.uid());
end $$;

-- Customer reports a payment they made (pending until supplier verifies).
create or replace function public.submit_payment(
  p_customer_id uuid, p_amount numeric, p_method public.payment_method, p_reference text default null,
  p_payment_date date default current_date, p_invoice_id uuid default null, p_notes text default null
) returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  c public.customers := public.customer_for_actor(p_customer_id, false);
  p public.payments;
  v_owner uuid;
begin
  if p_method = 'online' then
    raise exception 'Use "Pay online" for gateway payments' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero' using errcode = '22023';
  end if;
  if p_method in ('upi', 'bank_transfer') and (p_reference is null or char_length(trim(p_reference)) < 4) then
    raise exception 'Please enter the UPI / bank transaction reference' using errcode = '22023';
  end if;
  if p_invoice_id is not null and not exists (select 1 from public.invoices where id = p_invoice_id and customer_id = c.id) then
    raise exception 'Invoice does not belong to you' using errcode = '22023';
  end if;
  insert into public.payments (supplier_id, customer_id, invoice_id, amount, payment_method, reference_number,
                               payment_date, status, submitted_by_customer, recorded_by, notes)
  values (c.supplier_id, c.id, p_invoice_id, round(p_amount, 2), p_method, nullif(trim(coalesce(p_reference, '')), ''),
          coalesce(p_payment_date, current_date), 'pending', true, auth.uid(), p_notes)
  returning * into p;
  select owner_id into v_owner from public.suppliers where id = c.supplier_id;
  perform public.notify(v_owner, 'payment_submitted', 'info', 'Payment needs verification',
    format('%s reported paying ₹%s via %s (ref %s).', c.customer_name, to_char(p.amount, 'FM999999990.00'),
           replace(p.payment_method::text, '_', ' '), coalesce(p.reference_number, '—')),
    '/supplier/payments', jsonb_build_object('payment_id', p.id));
  return p;
end $$;

create or replace function public.verify_payment(p_payment_id uuid, p_approve boolean, p_note text default null)
returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  p public.payments;
  c public.customers;
begin
  select * into p from public.payments where id = p_payment_id and supplier_id = v_sid;
  if p.id is null then
    raise exception 'Payment not found' using errcode = 'P0002';
  end if;
  if p.status <> 'pending' then
    raise exception 'Payment already %', p.status using errcode = '23505';
  end if;
  if p.payment_method = 'online' then
    raise exception 'Online payments are verified by the gateway webhook only' using errcode = '42501';
  end if;
  if p_approve then
    return public.finalize_payment(p.id, auth.uid());
  end if;
  update public.payments set status = 'failed', verified_by = auth.uid(), verified_at = now(),
         notes = coalesce(p_note, notes) where id = p.id returning * into p;
  select * into c from public.customers where id = p.customer_id;
  perform public.notify(c.user_id, 'payment_received', 'warning', 'Payment could not be verified',
    format('Your payment of ₹%s (ref %s) was not verified by your supplier.%s',
           to_char(p.amount, 'FM999999990.00'), coalesce(p.reference_number, '—'), coalesce(' ' || p_note, '')),
    '/app/payments', jsonb_build_object('payment_id', p.id));
  perform public.write_audit('payment.rejected', 'payment', p.id, v_sid, jsonb_build_object('note', p_note));
  return p;
end $$;

-- Gateway flow (service role only — called by Edge Functions).
create or replace function public.create_gateway_payment(
  p_customer_id uuid, p_amount numeric, p_gateway text, p_gateway_order_id text, p_actor uuid
) returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  c public.customers;
  p public.payments;
begin
  select * into c from public.customers where id = p_customer_id;
  if c.id is null or c.user_id is distinct from p_actor then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.payments (supplier_id, customer_id, amount, payment_method, payment_date, status,
                               submitted_by_customer, gateway, gateway_order_id, recorded_by,
                               invoice_id)
  values (c.supplier_id, c.id, round(p_amount, 2), 'online', current_date, 'pending', true, p_gateway,
          p_gateway_order_id, p_actor,
          (select id from public.invoices where customer_id = c.id and superseded_by is null order by generated_at desc limit 1))
  returning * into p;
  return p;
end $$;
revoke execute on function public.create_gateway_payment(uuid, numeric, text, text, uuid) from public, anon, authenticated;

create or replace function public.confirm_gateway_payment(
  p_gateway_order_id text, p_gateway_payment_id text, p_amount numeric
) returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  p public.payments;
begin
  select * into p from public.payments where gateway_order_id = p_gateway_order_id;
  if p.id is null then
    raise exception 'Unknown gateway order %', p_gateway_order_id using errcode = 'P0002';
  end if;
  if p.status = 'succeeded' then
    return p;   -- webhook retries are harmless
  end if;
  if round(p_amount, 2) <> p.amount then
    raise exception 'Amount mismatch for order % (expected %, got %)', p_gateway_order_id, p.amount, p_amount;
  end if;
  update public.payments set gateway_payment_id = p_gateway_payment_id, reference_number = p_gateway_payment_id
   where id = p.id;
  return public.finalize_payment(p.id, null);
end $$;
revoke execute on function public.confirm_gateway_payment(text, text, numeric) from public, anon, authenticated;

create or replace function public.fail_gateway_payment(p_gateway_order_id text, p_reason text) returns void
language sql security definer set search_path = public as $$
  update public.payments set status = 'failed', notes = left(p_reason, 500)
   where gateway_order_id = p_gateway_order_id and status = 'pending';
$$;
revoke execute on function public.fail_gateway_payment(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Credit notes (never edit a finalized invoice)
-- ---------------------------------------------------------------------
create or replace function public.issue_credit_note(
  p_customer_id uuid, p_amount numeric, p_reason text, p_invoice_id uuid default null
) returns public.credit_notes
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  c public.customers;
  cn public.credit_notes;
  v_latest uuid;
  v_code text;
begin
  select * into c from public.customers where id = p_customer_id and supplier_id = v_sid for update;
  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  if p_invoice_id is not null and not exists (select 1 from public.invoices where id = p_invoice_id and customer_id = c.id) then
    raise exception 'Invoice does not belong to this customer' using errcode = '22023';
  end if;
  select business_code into v_code from public.suppliers where id = v_sid;
  insert into public.credit_notes (supplier_id, customer_id, invoice_id, credit_number, amount, reason, created_by)
  values (v_sid, c.id, p_invoice_id,
          'CN-' || v_code || '-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
          round(p_amount, 2), trim(p_reason), auth.uid())
  returning * into cn;
  select id into v_latest from public.invoices where customer_id = c.id and superseded_by is null order by generated_at desc limit 1;
  if v_latest is not null then
    perform public.refresh_invoice_status(v_latest);
  end if;
  perform public.notify(c.user_id, 'payment_received', 'success', 'Credit applied to your account',
    format('A credit of ₹%s was applied: %s', to_char(cn.amount, 'FM999999990.00'), cn.reason),
    '/app/bills', jsonb_build_object('credit_note_id', cn.id));
  perform public.write_audit('credit_note.issued', 'credit_note', cn.id, v_sid,
    jsonb_build_object('amount', cn.amount, 'reason', cn.reason));
  return cn;
end $$;
