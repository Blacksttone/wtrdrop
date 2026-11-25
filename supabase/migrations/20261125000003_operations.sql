-- =====================================================================
-- Waterdrop — business operations (all privileged writes live here)
-- Onboarding, deliveries + confirmation, consumption, prediction, orders.
-- Every function validates the caller with auth.uid().
-- =====================================================================

-- ---------------------------------------------------------------------
-- Small guards
-- ---------------------------------------------------------------------
create or replace function public.require_auth() returns uuid
language plpgsql stable as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  return v;
end $$;

-- Returns the caller's supplier id, ensuring it is active.
create or replace function public.require_active_supplier() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid;
  v_status public.supplier_status;
begin
  perform public.require_auth();
  select id, status into v_id, v_status from public.suppliers where owner_id = auth.uid();
  if v_id is null then
    raise exception 'Supplier account required' using errcode = '42501';
  end if;
  if v_status <> 'active' then
    raise exception 'Supplier account is suspended. Contact Waterdrop support.' using errcode = '42501';
  end if;
  return v_id;
end $$;

-- Loads a customer row the caller may act on as the customer (or supplier/admin when allowed).
create or replace function public.customer_for_actor(p_customer_id uuid, p_allow_supplier boolean default false)
returns public.customers
language plpgsql stable security definer set search_path = public as $$
declare
  c public.customers;
begin
  perform public.require_auth();
  select * into c from public.customers where id = p_customer_id;
  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if c.user_id = auth.uid() then
    return c;
  end if;
  if p_allow_supplier and (c.supplier_id = public.my_supplier_id() or public.is_admin()) then
    return c;
  end if;
  raise exception 'Not allowed for this customer' using errcode = '42501';
end $$;

create or replace function public.customer_local_date(p_customer_id uuid, p_at timestamptz default now())
returns date
language sql stable security definer set search_path = public as $$
  select (p_at at time zone coalesce((select timezone from public.customers where id = p_customer_id), 'Asia/Kolkata'))::date;
$$;

create or replace function public.effective_can_price(p_customer_id uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(c.can_price, s.default_can_price)
  from public.customers c join public.supplier_settings s on s.supplier_id = c.supplier_id
  where c.id = p_customer_id;
$$;

create or replace function public.generate_business_code() returns text
language plpgsql volatile as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  i int;
begin
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.suppliers where business_code = v_code);
  end loop;
  return v_code;
end $$;

-- ---------------------------------------------------------------------
-- Supplier onboarding
-- ---------------------------------------------------------------------
create or replace function public.register_supplier(
  p_business_name text,
  p_owner_name text,
  p_phone text,
  p_email text,
  p_address text,
  p_delivery_area text,
  p_default_can_price numeric,
  p_billing_info jsonb default '{}'::jsonb,
  p_logo_url text default null,
  p_delivery_lead_days integer default 1
) returns public.suppliers
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_auth();
  v_role public.app_role;
  v_plan uuid;
  s public.suppliers;
begin
  select role into v_role from public.profiles where id = v_uid;
  if v_role is distinct from 'supplier' then
    raise exception 'This account was not registered as a water supplier' using errcode = '42501';
  end if;
  if exists (select 1 from public.suppliers where owner_id = v_uid) then
    raise exception 'Supplier business already registered for this account' using errcode = '23505';
  end if;
  if p_default_can_price is null or p_default_can_price < 0 then
    raise exception 'Default can price must be zero or more' using errcode = '22023';
  end if;
  if p_billing_info is not null and jsonb_typeof(p_billing_info) <> 'object' then
    raise exception 'billing_info must be an object' using errcode = '22023';
  end if;

  select id into v_plan from public.subscription_plans where is_active order by price_monthly asc, created_at limit 1;

  insert into public.suppliers (owner_id, business_name, business_code, owner_name, phone, email, address,
                                delivery_area, logo_url, billing_info, plan_id)
  values (v_uid, trim(p_business_name), public.generate_business_code(), trim(p_owner_name), trim(p_phone),
          nullif(trim(coalesce(p_email, '')), ''), trim(p_address), nullif(trim(coalesce(p_delivery_area, '')), ''),
          p_logo_url, coalesce(p_billing_info, '{}'::jsonb), v_plan)
  returning * into s;

  insert into public.supplier_settings (supplier_id, default_can_price, delivery_lead_days)
  values (s.id, round(p_default_can_price, 2), coalesce(p_delivery_lead_days, 1));

  update public.profiles set full_name = coalesce(nullif(full_name, ''), trim(p_owner_name)),
                             phone = coalesce(phone, nullif(trim(p_phone), ''))
   where id = v_uid;

  perform public.write_audit('supplier.registered', 'supplier', s.id, s.id,
                             jsonb_build_object('business_name', s.business_name));
  return s;
end $$;

create or replace function public.create_supplier_invite(p_label text default null, p_max_uses integer default null,
                                                         p_expires_in_days integer default 30)
returns public.supplier_invites
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  i public.supplier_invites;
begin
  insert into public.supplier_invites (supplier_id, label, max_uses, expires_at, created_by)
  values (v_sid, p_label, p_max_uses,
          case when p_expires_in_days is null then null else now() + make_interval(days => p_expires_in_days) end,
          auth.uid())
  returning * into i;
  return i;
end $$;

-- Public-ish lookup so a customer can see who they are connecting to.
create or replace function public.lookup_supplier(p_code text default null, p_invite_token text default null)
returns table (supplier_id uuid, business_name text, delivery_area text, logo_url text, address text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_auth();
  return query
  select s.id, s.business_name, s.delivery_area, s.logo_url, s.address
  from public.suppliers s
  where s.status = 'active'
    and (
      (p_code is not null and s.business_code = upper(trim(p_code)))
      or (p_invite_token is not null and s.id = (
            select si.supplier_id from public.supplier_invites si
            where si.token = p_invite_token and si.revoked_at is null
              and (si.expires_at is null or si.expires_at > now())
              and (si.max_uses is null or si.uses < si.max_uses)))
    );
end $$;

-- ---------------------------------------------------------------------
-- Customer onboarding: connect only through a code or a valid invite
-- ---------------------------------------------------------------------
create or replace function public.connect_to_supplier(
  p_customer_name text,
  p_phone text,
  p_address text,
  p_delivery_instructions text default null,
  p_business_code text default null,
  p_invite_token text default null,
  p_opening_stock integer default null,
  p_daily_consumption integer default 0
) returns public.customers
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_auth();
  v_role public.app_role;
  v_supplier public.suppliers;
  v_settings public.supplier_settings;
  v_invite public.supplier_invites;
  c public.customers;
begin
  select role into v_role from public.profiles where id = v_uid;
  if v_role <> 'customer' then
    raise exception 'Only customer accounts can connect to a supplier' using errcode = '42501';
  end if;

  if p_invite_token is not null then
    select * into v_invite from public.supplier_invites where token = p_invite_token for update;
    if v_invite.id is null or v_invite.revoked_at is not null
       or (v_invite.expires_at is not null and v_invite.expires_at <= now())
       or (v_invite.max_uses is not null and v_invite.uses >= v_invite.max_uses) then
      raise exception 'This invitation link is invalid or has expired' using errcode = '22023';
    end if;
    select * into v_supplier from public.suppliers where id = v_invite.supplier_id;
  elsif p_business_code is not null then
    select * into v_supplier from public.suppliers where business_code = upper(trim(p_business_code));
  else
    raise exception 'A supplier code or invitation link is required' using errcode = '22023';
  end if;

  if v_supplier.id is null or v_supplier.status <> 'active' then
    raise exception 'Supplier not found or not accepting customers' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.customers where user_id = v_uid and supplier_id = v_supplier.id) then
    raise exception 'You are already connected to this supplier' using errcode = '23505';
  end if;
  if p_opening_stock is not null and (p_opening_stock < 0 or p_opening_stock > 1000) then
    raise exception 'Opening stock must be between 0 and 1000 cans' using errcode = '22023';
  end if;

  select * into v_settings from public.supplier_settings where supplier_id = v_supplier.id;

  insert into public.customers (user_id, supplier_id, customer_name, phone, address, delivery_instructions,
                                daily_consumption, low_stock_threshold, critical_threshold, safety_stock)
  values (v_uid, v_supplier.id, trim(p_customer_name), nullif(trim(coalesce(p_phone, '')), ''), trim(p_address),
          nullif(trim(coalesce(p_delivery_instructions, '')), ''), coalesce(p_daily_consumption, 0),
          greatest(v_settings.default_low_stock_threshold, v_settings.default_critical_threshold),
          v_settings.default_critical_threshold, v_settings.default_safety_stock)
  returning * into c;

  insert into public.customer_stock (customer_id, supplier_id) values (c.id, c.supplier_id);

  if p_opening_stock is not null then
    insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity, reference_type,
                                               transaction_date, idempotency_key, created_by, notes)
    values (c.supplier_id, c.id, 'opening_stock', p_opening_stock, 'manual', public.customer_local_date(c.id),
            'opening:' || c.id, v_uid, 'Opening stock entered at registration');
  end if;

  if v_invite.id is not null then
    update public.supplier_invites set uses = uses + 1 where id = v_invite.id;
  end if;

  update public.profiles set full_name = coalesce(nullif(full_name, ''), trim(p_customer_name)),
                             phone = coalesce(phone, nullif(trim(coalesce(p_phone, '')), ''))
   where id = v_uid;

  perform public.notify(v_supplier.owner_id, 'account', 'info', 'New customer connected',
                        format('%s joined your delivery list.', c.customer_name),
                        '/supplier/customers/' || c.id, jsonb_build_object('customer_id', c.id));
  perform public.write_audit('customer.connected', 'customer', c.id, c.supplier_id,
                             jsonb_build_object('via', case when v_invite.id is not null then 'invite' else 'code' end));
  return c;
end $$;

-- Supplier adds an "offline" customer (no app account). Deliveries for these are
-- confirmed by the supplier on the customer's behalf and flagged as such.
create or replace function public.supplier_add_customer(
  p_customer_name text,
  p_phone text,
  p_address text,
  p_delivery_instructions text default null,
  p_can_price numeric default null,
  p_daily_consumption integer default 0,
  p_opening_stock integer default null,
  p_opening_balance numeric default 0
) returns public.customers
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  v_settings public.supplier_settings;
  c public.customers;
begin
  select * into v_settings from public.supplier_settings where supplier_id = v_sid;
  insert into public.customers (supplier_id, customer_name, phone, address, delivery_instructions, can_price,
                                daily_consumption, low_stock_threshold, critical_threshold, safety_stock, opening_balance)
  values (v_sid, trim(p_customer_name), nullif(trim(coalesce(p_phone, '')), ''), trim(p_address),
          nullif(trim(coalesce(p_delivery_instructions, '')), ''), p_can_price, coalesce(p_daily_consumption, 0),
          greatest(v_settings.default_low_stock_threshold, v_settings.default_critical_threshold),
          v_settings.default_critical_threshold, v_settings.default_safety_stock, coalesce(p_opening_balance, 0))
  returning * into c;
  insert into public.customer_stock (customer_id, supplier_id) values (c.id, c.supplier_id);
  if p_opening_stock is not null then
    insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity, reference_type,
                                               transaction_date, idempotency_key, created_by, notes)
    values (v_sid, c.id, 'opening_stock', p_opening_stock, 'manual', public.customer_local_date(c.id),
            'opening:' || c.id, auth.uid(), 'Opening stock entered by supplier');
  end if;
  perform public.write_audit('customer.created', 'customer', c.id, v_sid, '{}'::jsonb);
  return c;
end $$;

-- Customer self-service settings
create or replace function public.update_my_customer_settings(
  p_customer_id uuid,
  p_daily_consumption integer default null,
  p_auto_consumption_enabled boolean default null,
  p_auto_consumption_time time default null,
  p_timezone text default null,
  p_low_stock_threshold integer default null,
  p_critical_threshold integer default null,
  p_safety_stock integer default null,
  p_delivery_instructions text default null,
  p_address text default null,
  p_phone text default null
) returns public.customers
language plpgsql security definer set search_path = public as $$
declare
  c public.customers := public.customer_for_actor(p_customer_id, false);
begin
  if p_timezone is not null and not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Unknown timezone %', p_timezone using errcode = '22023';
  end if;
  update public.customers set
    daily_consumption = coalesce(p_daily_consumption, daily_consumption),
    auto_consumption_enabled = coalesce(p_auto_consumption_enabled, auto_consumption_enabled),
    auto_consumption_since = case
      when coalesce(p_auto_consumption_enabled, auto_consumption_enabled) and not auto_consumption_enabled
        then public.customer_local_date(id)
      when not coalesce(p_auto_consumption_enabled, auto_consumption_enabled) then null
      else auto_consumption_since end,
    auto_consumption_time = coalesce(p_auto_consumption_time, auto_consumption_time),
    timezone = coalesce(p_timezone, timezone),
    low_stock_threshold = coalesce(p_low_stock_threshold, low_stock_threshold),
    critical_threshold = coalesce(p_critical_threshold, critical_threshold),
    safety_stock = coalesce(p_safety_stock, safety_stock),
    delivery_instructions = coalesce(nullif(trim(p_delivery_instructions), ''), delivery_instructions),
    address = coalesce(nullif(trim(p_address), ''), address),
    phone = coalesce(nullif(trim(p_phone), ''), phone)
  where id = c.id
  returning * into c;
  perform public.evaluate_stock_alert(c.id);
  perform public.refresh_prediction(c.id);
  return c;
end $$;

-- Opening stock may be set exactly once (by customer or supplier).
create or replace function public.set_opening_stock(p_customer_id uuid, p_quantity integer)
returns public.inventory_transactions
language plpgsql security definer set search_path = public as $$
declare
  c public.customers := public.customer_for_actor(p_customer_id, true);
  t public.inventory_transactions;
begin
  if p_quantity is null or p_quantity < 0 or p_quantity > 1000 then
    raise exception 'Opening stock must be between 0 and 1000' using errcode = '22023';
  end if;
  if exists (select 1 from public.inventory_transactions where customer_id = c.id) then
    raise exception 'Opening stock already recorded. Use a stock adjustment instead.' using errcode = '23505';
  end if;
  insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity, reference_type,
                                             transaction_date, idempotency_key, created_by, notes)
  values (c.supplier_id, c.id, 'opening_stock', p_quantity, 'manual', public.customer_local_date(c.id),
          'opening:' || c.id, auth.uid(), 'Opening stock')
  returning * into t;
  perform public.refresh_prediction(c.id);
  return t;
end $$;

-- Supplier-recorded stock movements: returns, damage, manual adjustment.
create or replace function public.record_stock_movement(
  p_customer_id uuid, p_type public.inventory_txn_type, p_quantity integer, p_reason text
) returns public.inventory_transactions
language plpgsql security definer set search_path = public as $$
declare
  c public.customers;
  v_sid uuid := public.require_active_supplier();
  v_qty integer;
  t public.inventory_transactions;
begin
  select * into c from public.customers where id = p_customer_id and supplier_id = v_sid;
  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if p_type not in ('return', 'damage', 'adjustment') then
    raise exception 'Only return, damage or adjustment movements can be recorded manually' using errcode = '22023';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity = 0 or abs(p_quantity) > 1000 then
    raise exception 'Quantity must be a non-zero number of cans' using errcode = '22023';
  end if;
  v_qty := case when p_type in ('return', 'damage') then -abs(p_quantity) else p_quantity end;

  insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity, reference_type,
                                             transaction_date, created_by, notes)
  values (v_sid, c.id, p_type, v_qty, 'manual', public.customer_local_date(c.id), auth.uid(), trim(p_reason))
  returning * into t;
  perform public.write_audit('stock.' || p_type::text, 'customer', c.id, v_sid,
                             jsonb_build_object('quantity', v_qty, 'reason', p_reason));
  perform public.refresh_prediction(c.id);
  return t;
end $$;

-- ---------------------------------------------------------------------
-- Deliveries
-- ---------------------------------------------------------------------
create or replace function public.apply_delivery_confirmation(
  p_delivery_id uuid, p_quantity integer, p_note text, p_by_supplier boolean
) returns public.deliveries
language plpgsql security definer set search_path = public as $$
declare
  d public.deliveries;
  c public.customers;
  v_owner uuid;
begin
  -- Row lock serializes concurrent confirmations; status check rejects duplicates.
  select * into d from public.deliveries where id = p_delivery_id for update;
  if d.status = 'confirmed' then
    raise exception 'This delivery has already been confirmed' using errcode = '23505';
  end if;
  if d.status <> 'awaiting_confirmation' then
    raise exception 'This delivery cannot be confirmed (status: %)', d.status using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 0 or p_quantity > 1000 then
    raise exception 'Received quantity must be between 0 and 1000' using errcode = '22023';
  end if;

  update public.deliveries set
    status = 'confirmed', confirmed_quantity = p_quantity, confirmed_at = now(), confirmed_by = auth.uid(),
    confirmed_by_supplier = p_by_supplier, customer_note = nullif(trim(coalesce(p_note, '')), '')
  where id = d.id
  returning * into d;

  select * into c from public.customers where id = d.customer_id;

  -- Only the confirmed quantity moves stock. Idempotency key makes a double-post impossible.
  insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity, reference_type,
                                             reference_id, transaction_date, idempotency_key, created_by, notes)
  values (d.supplier_id, d.customer_id, 'delivery_received', p_quantity, 'delivery', d.id,
          d.delivery_date, 'delivery:' || d.id, auth.uid(),
          format('Expected %s, supplier delivered %s, confirmed %s', d.expected_quantity, d.actual_quantity, p_quantity));

  if d.order_id is not null then
    update public.orders set status = 'delivered' where id = d.order_id and status <> 'delivered';
  end if;

  select owner_id into v_owner from public.suppliers where id = d.supplier_id;
  if p_quantity < d.expected_quantity or p_quantity < d.actual_quantity then
    perform public.notify(v_owner, 'delivery_shortage', 'warning',
      format('Delivery shortage: %s', c.customer_name),
      format('%s confirmed %s of %s expected cans (you recorded %s delivered).',
             c.customer_name, p_quantity, d.expected_quantity, d.actual_quantity),
      '/supplier/deliveries', jsonb_build_object('delivery_id', d.id, 'shortage', d.expected_quantity - p_quantity));
  elsif not p_by_supplier then
    perform public.notify(v_owner, 'delivery_confirmed', 'success',
      format('%s confirmed delivery', c.customer_name),
      format('%s cans confirmed received.', p_quantity), '/supplier/deliveries',
      jsonb_build_object('delivery_id', d.id), 'delivery_confirmed:' || d.id);
  end if;

  perform public.write_audit('delivery.confirmed', 'delivery', d.id, d.supplier_id,
    jsonb_build_object('expected', d.expected_quantity, 'actual', d.actual_quantity, 'confirmed', p_quantity,
                       'by_supplier', p_by_supplier));
  perform public.refresh_prediction(d.customer_id);
  return d;
end $$;

create or replace function public.record_delivery(
  p_customer_id uuid,
  p_expected_quantity integer,
  p_actual_quantity integer,
  p_delivery_date date default null,
  p_order_id uuid default null,
  p_notes text default null
) returns public.deliveries
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  c public.customers;
  o public.orders;
  d public.deliveries;
  v_date date;
begin
  select * into c from public.customers where id = p_customer_id and supplier_id = v_sid;
  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if p_expected_quantity is null or p_actual_quantity is null
     or p_expected_quantity < 0 or p_actual_quantity < 0
     or p_expected_quantity > 1000 or p_actual_quantity > 1000 then
    raise exception 'Quantities must be between 0 and 1000' using errcode = '22023';
  end if;
  v_date := coalesce(p_delivery_date, public.customer_local_date(c.id));
  if v_date > public.customer_local_date(c.id) + 1 then
    raise exception 'Delivery date cannot be in the future' using errcode = '22023';
  end if;

  if p_order_id is not null then
    select * into o from public.orders where id = p_order_id for update;
    if o.id is null or o.customer_id <> c.id or o.supplier_id <> v_sid then
      raise exception 'Order does not belong to this customer' using errcode = '22023';
    end if;
    if o.status not in ('accepted', 'preparing', 'out_for_delivery') then
      raise exception 'Order must be accepted before it can be delivered (status: %)', o.status using errcode = '22023';
    end if;
    if exists (select 1 from public.deliveries where order_id = o.id and status <> 'cancelled') then
      raise exception 'A delivery is already recorded for this order' using errcode = '23505';
    end if;
  end if;

  insert into public.deliveries (supplier_id, customer_id, order_id, expected_quantity, actual_quantity, unit_price,
                                 delivery_date, notes, created_by)
  values (v_sid, c.id, p_order_id, p_expected_quantity, p_actual_quantity, public.effective_can_price(c.id),
          v_date, nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
  returning * into d;

  if o.id is not null then
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, reason)
    values (o.id, o.status, 'delivered', auth.uid(), 'Delivery recorded; awaiting customer confirmation');
    update public.orders set status = 'delivered' where id = o.id;
  end if;

  perform public.write_audit('delivery.recorded', 'delivery', d.id, v_sid,
    jsonb_build_object('expected', p_expected_quantity, 'actual', p_actual_quantity));

  if c.user_id is null then
    -- Offline customer: supplier confirms on their behalf (flagged for reporting).
    d := public.apply_delivery_confirmation(d.id, p_actual_quantity, 'Confirmed by supplier (offline customer)', true);
  else
    perform public.notify(c.user_id, 'delivery_confirmation_required', 'warning',
      'Please confirm your water delivery',
      format('Your supplier recorded %s can%s delivered on %s. Confirm how many you actually received.',
             p_actual_quantity, case when p_actual_quantity = 1 then '' else 's' end, to_char(v_date, 'DD Mon')),
      '/app/deliveries', jsonb_build_object('delivery_id', d.id), 'confirm_delivery:' || d.id);
  end if;
  return d;
end $$;

create or replace function public.confirm_delivery(p_delivery_id uuid, p_received_quantity integer, p_note text default null)
returns public.deliveries
language plpgsql security definer set search_path = public as $$
declare
  d public.deliveries;
begin
  perform public.require_auth();
  select * into d from public.deliveries where id = p_delivery_id;
  if d.id is null then
    raise exception 'Delivery not found' using errcode = 'P0002';
  end if;
  -- Only the customer who owns the account confirms what they received.
  perform public.customer_for_actor(d.customer_id, false);
  return public.apply_delivery_confirmation(p_delivery_id, p_received_quantity, p_note, false);
end $$;

create or replace function public.cancel_delivery(p_delivery_id uuid, p_reason text)
returns public.deliveries
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery_id and supplier_id = v_sid for update;
  if d.id is null then
    raise exception 'Delivery not found' using errcode = 'P0002';
  end if;
  if d.status <> 'awaiting_confirmation' then
    raise exception 'Only unconfirmed deliveries can be cancelled; use an adjustment' using errcode = '22023';
  end if;
  update public.deliveries set status = 'cancelled', notes = coalesce(notes || E'\n', '') || 'Cancelled: ' || coalesce(p_reason, '')
  where id = d.id returning * into d;
  if d.order_id is not null then
    update public.orders set status = 'out_for_delivery' where id = d.order_id and status = 'delivered';
  end if;
  perform public.write_audit('delivery.cancelled', 'delivery', d.id, v_sid, jsonb_build_object('reason', p_reason));
  return d;
end $$;

-- Correct a confirmed delivery without touching the original record.
create or replace function public.adjust_delivery(p_delivery_id uuid, p_new_quantity integer, p_reason text)
returns public.delivery_adjustments
language plpgsql security definer set search_path = public as $$
declare
  d public.deliveries;
  c public.customers;
  a public.delivery_adjustments;
  v_prev integer;
begin
  perform public.require_auth();
  select * into d from public.deliveries where id = p_delivery_id for update;
  if d.id is null then
    raise exception 'Delivery not found' using errcode = 'P0002';
  end if;
  if not (d.supplier_id = public.my_supplier_id() or public.is_admin()) then
    raise exception 'Only the supplier can adjust a delivery' using errcode = '42501';
  end if;
  if d.supplier_id = public.my_supplier_id() then
    perform public.require_active_supplier();
  end if;
  if d.status <> 'confirmed' then
    raise exception 'Only confirmed deliveries can be adjusted' using errcode = '22023';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'A reason is required for every adjustment' using errcode = '22023';
  end if;
  v_prev := d.confirmed_quantity + d.adjusted_quantity;
  if p_new_quantity = v_prev then
    raise exception 'New quantity equals the current quantity' using errcode = '22023';
  end if;

  insert into public.delivery_adjustments (delivery_id, supplier_id, customer_id, previous_quantity, new_quantity,
                                           unit_price, reason, adjusted_by)
  values (d.id, d.supplier_id, d.customer_id, v_prev, p_new_quantity, d.unit_price, trim(p_reason), auth.uid())
  returning * into a;

  insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity, reference_type,
                                             reference_id, transaction_date, idempotency_key, created_by, notes)
  values (d.supplier_id, d.customer_id, 'adjustment', a.delta, 'delivery_adjustment', a.id,
          public.customer_local_date(d.customer_id), 'delivery_adj:' || a.id, auth.uid(),
          format('Delivery %s corrected %s → %s: %s', to_char(d.delivery_date, 'DD Mon'), v_prev, p_new_quantity, a.reason));

  update public.deliveries set adjusted_quantity = adjusted_quantity + a.delta where id = d.id;

  select * into c from public.customers where id = d.customer_id;
  perform public.notify(c.user_id, 'delivery_confirmed', 'info', 'Delivery corrected',
    format('Your %s delivery was corrected from %s to %s cans. Reason: %s',
           to_char(d.delivery_date, 'DD Mon'), v_prev, p_new_quantity, a.reason),
    '/app/deliveries', jsonb_build_object('delivery_id', d.id, 'adjustment_id', a.id));
  perform public.write_audit('delivery.adjusted', 'delivery', d.id, d.supplier_id,
    jsonb_build_object('from', v_prev, 'to', p_new_quantity, 'reason', a.reason));
  perform public.refresh_prediction(d.customer_id);
  return a;
end $$;

-- ---------------------------------------------------------------------
-- Daily consumption
-- ---------------------------------------------------------------------
-- Sets the total consumption for one local day; posts only the delta to the
-- ledger. Consumption beyond available stock is recorded as a stockout event
-- instead of allowing negative stock.
create or replace function public.apply_consumption(
  p_customer_id uuid, p_date date, p_quantity integer, p_source public.consumption_source, p_actor uuid
) returns public.consumption_records
language plpgsql security definer set search_path = public as $$
declare
  c public.customers;
  r public.consumption_records;
  v_stock integer;
  v_old integer := 0;
  v_take integer;
  v_unmet integer := 0;
  v_delta integer;
begin
  if p_quantity is null or p_quantity < 0 or p_quantity > 1000 then
    raise exception 'Consumption must be between 0 and 1000 cans' using errcode = '22023';
  end if;
  select * into c from public.customers where id = p_customer_id;

  insert into public.customer_stock (customer_id, supplier_id) values (c.id, c.supplier_id)
  on conflict (customer_id) do nothing;
  -- Per-customer lock: serializes manual entries, auto job and corrections.
  select current_stock into v_stock from public.customer_stock where customer_id = c.id for update;

  select * into r from public.consumption_records where customer_id = c.id and consumption_date = p_date for update;
  if r.id is not null then
    if p_source = 'auto' then
      return r;  -- never duplicate or override an existing day
    end if;
    v_old := r.quantity;
  end if;

  -- Compare against the previously *requested* total (consumed + unmet).
  v_delta := p_quantity - (v_old + coalesce(r.unmet_quantity, 0));
  if v_delta > 0 then
    v_take := least(v_delta, v_stock);              -- cans actually available
    v_unmet := v_delta - v_take;                    -- demand that could not be met
  elsif v_delta < 0 then
    -- Lower the unmet demand first, then return real cans to stock.
    v_unmet := -least(coalesce(r.unmet_quantity, 0), -v_delta);
    v_take := v_delta - v_unmet;                    -- <= 0
  else
    v_take := 0;
  end if;

  if r.id is null then
    insert into public.consumption_records (customer_id, supplier_id, consumption_date, quantity, unmet_quantity, source, created_by)
    values (c.id, c.supplier_id, p_date, v_take, v_unmet, p_source, p_actor)
    returning * into r;
  else
    update public.consumption_records
       set quantity = quantity + v_take,
           unmet_quantity = unmet_quantity + v_unmet,
           source = case when p_source = 'manual' and r.source <> 'manual' then 'correction' else p_source end,
           created_by = coalesce(p_actor, created_by)
     where id = r.id
    returning * into r;
  end if;

  if v_take > 0 then
    insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity, reference_type,
                                               reference_id, transaction_date, created_by, notes)
    values (c.supplier_id, c.id, 'consumption', -v_take, 'consumption', r.id, p_date, p_actor,
            case p_source when 'auto' then 'Automatic daily consumption' else 'Daily consumption' end);
  elsif v_take < 0 then
    insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity, reference_type,
                                               reference_id, transaction_date, created_by, notes)
    values (c.supplier_id, c.id, 'adjustment', -v_take, 'consumption', r.id, p_date, p_actor,
            format('Consumption for %s corrected from %s to %s', to_char(p_date, 'DD Mon'), v_old, p_quantity));
  end if;

  if v_delta > 0 and v_unmet > 0 then
    insert into public.inventory_transactions (supplier_id, customer_id, transaction_type, quantity, reference_type,
                                               reference_id, transaction_date, created_by, notes)
    values (c.supplier_id, c.id, 'stockout', 0, 'consumption', r.id, p_date, p_actor,
            format('Stockout: %s can%s needed but not available', v_unmet, case when v_unmet = 1 then '' else 's' end));
  end if;

  perform public.refresh_prediction(c.id);
  return r;
end $$;
revoke execute on function public.apply_consumption(uuid, date, integer, public.consumption_source, uuid) from public, anon, authenticated;

create or replace function public.record_consumption(p_customer_id uuid, p_quantity integer, p_date date default null)
returns public.consumption_records
language plpgsql security definer set search_path = public as $$
declare
  c public.customers := public.customer_for_actor(p_customer_id, true);
  v_today date := public.customer_local_date(p_customer_id);
  v_date date := coalesce(p_date, v_today);
begin
  if c.user_id is not null and c.user_id <> auth.uid() then
    raise exception 'Only the customer records consumption for app users' using errcode = '42501';
  end if;
  if v_date > v_today then
    raise exception 'Cannot record consumption for a future date' using errcode = '22023';
  end if;
  if v_date < v_today - 7 then
    raise exception 'Entries older than 7 days need a correction request to your supplier' using errcode = '22023';
  end if;
  return public.apply_consumption(c.id, v_date, p_quantity, 'manual', auth.uid());
end $$;

create or replace function public.request_consumption_correction(
  p_customer_id uuid, p_date date, p_requested_quantity integer, p_reason text
) returns public.stock_correction_requests
language plpgsql security definer set search_path = public as $$
declare
  c public.customers := public.customer_for_actor(p_customer_id, false);
  r public.stock_correction_requests;
  v_owner uuid;
begin
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'Please describe why the entry is wrong' using errcode = '22023';
  end if;
  if p_date > public.customer_local_date(c.id) then
    raise exception 'Cannot correct a future date' using errcode = '22023';
  end if;
  insert into public.stock_correction_requests (customer_id, supplier_id, consumption_date, current_quantity,
                                                requested_quantity, reason, requested_by)
  values (c.id, c.supplier_id, p_date,
          coalesce((select quantity from public.consumption_records where customer_id = c.id and consumption_date = p_date), 0),
          p_requested_quantity, trim(p_reason), auth.uid())
  returning * into r;
  select owner_id into v_owner from public.suppliers where id = c.supplier_id;
  perform public.notify(v_owner, 'correction_request', 'info', 'Consumption correction requested',
    format('%s asked to change %s consumption from %s to %s cans.', c.customer_name, to_char(p_date, 'DD Mon'),
           r.current_quantity, p_requested_quantity),
    '/supplier/inventory', jsonb_build_object('request_id', r.id));
  return r;
end $$;

create or replace function public.resolve_correction_request(p_request_id uuid, p_approve boolean)
returns public.stock_correction_requests
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  r public.stock_correction_requests;
  c public.customers;
begin
  select * into r from public.stock_correction_requests where id = p_request_id and supplier_id = v_sid for update;
  if r.id is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception 'Request already resolved' using errcode = '23505';
  end if;
  if p_approve then
    perform public.apply_consumption(r.customer_id, r.consumption_date, r.requested_quantity, 'correction', auth.uid());
  end if;
  update public.stock_correction_requests
     set status = case when p_approve then 'approved'::public.correction_status else 'rejected'::public.correction_status end,
         resolved_by = auth.uid(), resolved_at = now()
   where id = r.id returning * into r;
  select * into c from public.customers where id = r.customer_id;
  perform public.notify(c.user_id, 'correction_request', 'info',
    case when p_approve then 'Correction approved' else 'Correction declined' end,
    format('Your correction for %s was %s.', to_char(r.consumption_date, 'DD Mon'),
           case when p_approve then 'approved and your stock was updated' else 'declined by your supplier' end),
    '/app/consumption', jsonb_build_object('request_id', r.id));
  perform public.write_audit('consumption.correction_' || r.status::text, 'stock_correction_request', r.id, v_sid,
                             jsonb_build_object('date', r.consumption_date, 'requested', r.requested_quantity));
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Stock prediction (single source of truth, used by UI and jobs)
-- ---------------------------------------------------------------------
create or replace function public.compute_prediction(p_customer_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c public.customers;
  s public.customer_stock;
  v_lead integer;
  v_today date;
  v_total numeric;
  v_days integer;
  v_first date;
  v_last date;
  v_span integer;
  v_avg numeric;
  v_basis text;
  v_days_left numeric;
  v_empty date;
  v_rec integer;
  v_order_now boolean;
  v_level text;
begin
  select * into c from public.customers where id = p_customer_id;
  select * into s from public.customer_stock where customer_id = p_customer_id;
  select delivery_lead_days into v_lead from public.supplier_settings where supplier_id = c.supplier_id;
  v_today := public.customer_local_date(p_customer_id);

  select sum(quantity + unmet_quantity), count(*), min(consumption_date), max(consumption_date)
    into v_total, v_days, v_first, v_last
  from public.consumption_records
  where customer_id = p_customer_id and consumption_date between v_today - 6 and v_today;

  if coalesce(v_days, 0) >= 3 then
    v_span := (v_last - v_first) + 1;
    v_avg := round(v_total / greatest(v_span, 1), 2);
    v_basis := 'history';
  elsif c.daily_consumption > 0 then
    v_avg := c.daily_consumption;
    v_basis := 'configured';
  end if;

  if s.customer_id is null or not s.has_opening_stock then
    v_level := 'unknown';
  else
    v_level := case public.stock_level_for(s.current_stock, c.low_stock_threshold, c.critical_threshold)
                 when 'critical' then 'critical' when 'low' then 'low' else 'ok' end;
  end if;

  if v_avg is not null and v_avg > 0 and v_level <> 'unknown' then
    v_days_left := round(s.current_stock / v_avg, 1);
    v_empty := v_today + floor(v_days_left)::int;
    -- Expected consumption during lead time + safety stock − current stock
    v_rec := greatest(ceil(v_avg * greatest(v_lead, 1)) + c.safety_stock - s.current_stock, 0)::int;
    v_order_now := v_days_left <= (v_lead + 1) or s.current_stock <= c.low_stock_threshold;
  elsif v_level in ('low', 'critical') then
    v_order_now := true;
    v_rec := greatest(c.safety_stock + c.low_stock_threshold - coalesce(s.current_stock, 0) + 1, 1);
  else
    v_order_now := false;
  end if;
  if v_order_now and coalesce(v_rec, 0) < 1 then
    v_rec := 1;
  end if;

  return jsonb_build_object(
    'current_stock', coalesce(s.current_stock, 0),
    'stock_confirmed', coalesce(s.has_opening_stock, false),
    'level', v_level,
    'avg_daily_consumption', v_avg,
    'basis', v_basis,
    'days_with_data', coalesce(v_days, 0),
    'days_remaining', v_days_left,
    'predicted_empty_date', v_empty,
    'delivery_lead_days', v_lead,
    'safety_stock', c.safety_stock,
    'recommended_order_quantity', case when v_order_now then v_rec else coalesce(v_rec, 0) end,
    'order_now', v_order_now,
    'today', v_today
  );
end $$;

create or replace function public.refresh_prediction(p_customer_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p jsonb := public.compute_prediction(p_customer_id);
  s public.customer_stock;
  c public.customers;
  v_open boolean;
begin
  select * into s from public.customer_stock where customer_id = p_customer_id;
  if s.customer_id is null then
    return p;
  end if;
  select * into c from public.customers where id = p_customer_id;
  select exists (select 1 from public.orders where customer_id = p_customer_id
                 and status in ('pending', 'accepted', 'preparing', 'out_for_delivery')) into v_open;

  update public.customer_stock set
    avg_daily_consumption = (p ->> 'avg_daily_consumption')::numeric,
    predicted_empty_date = (p ->> 'predicted_empty_date')::date,
    order_recommended = (p ->> 'order_now')::boolean,
    order_alert_sent = case when (p ->> 'order_now')::boolean then order_alert_sent else false end,
    prediction_refreshed_at = now()
  where customer_id = p_customer_id;

  -- One "order soon" reminder per low episode, skipped if an order is already open.
  if (p ->> 'order_now')::boolean and not s.order_alert_sent and not v_open and c.status = 'active'
     and (p ->> 'level') = 'ok' and (p ->> 'days_remaining') is not null then
    perform public.notify(c.user_id, 'order_recommended', 'warning', 'Time to order water',
      format('Your water will last about %s day%s. Your supplier needs %s day%s to deliver. We recommend ordering %s cans now.',
             p ->> 'days_remaining', case when (p ->> 'days_remaining')::numeric = 1 then '' else 's' end,
             p ->> 'delivery_lead_days', case when (p ->> 'delivery_lead_days')::int = 1 then '' else 's' end,
             p ->> 'recommended_order_quantity'),
      '/app/order', p);
    update public.customer_stock set order_alert_sent = true where customer_id = p_customer_id;
  end if;
  return p;
end $$;
revoke execute on function public.refresh_prediction(uuid) from public, anon, authenticated;

-- Client-facing: prediction for a customer the caller can see.
create or replace function public.get_stock_prediction(p_customer_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.customer_for_actor(p_customer_id, true);
  return public.compute_prediction(p_customer_id);
end $$;

-- ---------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------
create or replace function public.place_order(
  p_customer_id uuid,
  p_quantity integer,
  p_requested_delivery_date date default null,
  p_delivery_instructions text default null,
  p_is_bulk boolean default false
) returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  c public.customers := public.customer_for_actor(p_customer_id, false);
  v_status public.supplier_status;
  v_owner uuid;
  v_bulk_threshold integer;
  v_today date := public.customer_local_date(p_customer_id);
  o public.orders;
begin
  if c.status <> 'active' then
    raise exception 'Your customer account is inactive' using errcode = '42501';
  end if;
  select status, owner_id into v_status, v_owner from public.suppliers where id = c.supplier_id;
  if v_status <> 'active' then
    raise exception 'Your supplier is not accepting orders right now' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 1000 then
    raise exception 'Order between 1 and 1000 cans' using errcode = '22023';
  end if;
  if p_requested_delivery_date is not null
     and (p_requested_delivery_date < v_today or p_requested_delivery_date > v_today + 60) then
    raise exception 'Preferred delivery date must be within the next 60 days' using errcode = '22023';
  end if;
  if (select count(*) from public.orders where customer_id = c.id and status = 'pending') >= 5 then
    raise exception 'You already have 5 pending orders. Wait for your supplier to respond.' using errcode = '22023';
  end if;
  select bulk_order_threshold into v_bulk_threshold from public.supplier_settings where supplier_id = c.supplier_id;

  insert into public.orders (supplier_id, customer_id, quantity, is_bulk, requested_delivery_date,
                             delivery_instructions, created_by)
  values (c.supplier_id, c.id, p_quantity, coalesce(p_is_bulk, false) or p_quantity >= v_bulk_threshold,
          p_requested_delivery_date,
          coalesce(nullif(trim(coalesce(p_delivery_instructions, '')), ''), c.delivery_instructions), auth.uid())
  returning * into o;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by)
  values (o.id, null, 'pending', auth.uid());

  perform public.notify(v_owner, 'new_order', 'info',
    format('New %sorder: %s cans', case when o.is_bulk then 'bulk ' else '' end, o.quantity),
    format('%s ordered %s cans%s.', c.customer_name, o.quantity,
           coalesce(' for ' || to_char(o.requested_delivery_date, 'DD Mon'), '')),
    '/supplier/orders', jsonb_build_object('order_id', o.id));
  perform public.refresh_prediction(c.id);
  return o;
end $$;

create or replace function public.cancel_order(p_order_id uuid, p_reason text default null)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  o public.orders;
  v_owner uuid;
begin
  perform public.require_auth();
  select * into o from public.orders where id = p_order_id for update;
  if o.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  perform public.customer_for_actor(o.customer_id, false);
  if o.status <> 'pending' then
    raise exception 'Orders can only be cancelled before the supplier accepts them. Please contact your supplier.'
      using errcode = '22023';
  end if;
  update public.orders set status = 'cancelled', status_reason = p_reason where id = o.id returning * into o;
  insert into public.order_status_history (order_id, from_status, to_status, changed_by, reason)
  values (o.id, 'pending', 'cancelled', auth.uid(), p_reason);
  select owner_id into v_owner from public.suppliers where id = o.supplier_id;
  perform public.notify(v_owner, 'order_status', 'info', 'Order cancelled by customer',
    format('An order for %s cans was cancelled.', o.quantity), '/supplier/orders', jsonb_build_object('order_id', o.id));
  return o;
end $$;

create or replace function public.order_transition_allowed(p_from public.order_status, p_to public.order_status)
returns boolean language sql immutable as $$
  select case p_from
    when 'pending' then p_to in ('accepted', 'rejected', 'cancelled')
    when 'accepted' then p_to in ('preparing', 'out_for_delivery', 'cancelled')
    when 'preparing' then p_to in ('out_for_delivery', 'cancelled')
    when 'out_for_delivery' then p_to in ('cancelled')
    else false
  end;
$$;

create or replace function public.update_order_status(
  p_order_id uuid, p_status public.order_status, p_scheduled_date date default null, p_reason text default null
) returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  o public.orders;
  c public.customers;
  v_from public.order_status;
  v_sched_changed boolean;
begin
  select * into o from public.orders where id = p_order_id and supplier_id = v_sid for update;
  if o.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if p_status = 'delivered' then
    raise exception 'Record a delivery to complete an order (customer confirmation required)' using errcode = '22023';
  end if;
  v_from := o.status;
  if p_status <> v_from and not public.order_transition_allowed(v_from, p_status) then
    raise exception 'Cannot move order from % to %', v_from, p_status using errcode = '22023';
  end if;
  if p_status = 'rejected' and (p_reason is null or char_length(trim(p_reason)) < 3) then
    raise exception 'Please give a reason when rejecting an order' using errcode = '22023';
  end if;
  v_sched_changed := p_scheduled_date is not null and p_scheduled_date is distinct from o.scheduled_date;

  update public.orders set status = p_status,
    scheduled_date = coalesce(p_scheduled_date, scheduled_date),
    status_reason = coalesce(p_reason, status_reason)
  where id = o.id returning * into o;

  if p_status <> v_from then
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, reason)
    values (o.id, v_from, p_status, auth.uid(), p_reason);
  end if;

  select * into c from public.customers where id = o.customer_id;
  if p_status <> v_from then
    perform public.notify(c.user_id,
      case when p_status = 'accepted' then 'order_accepted' else 'order_status' end,
      case when p_status in ('rejected', 'cancelled') then 'warning' else 'info' end,
      case p_status
        when 'accepted' then 'Order accepted'
        when 'preparing' then 'Your order is being prepared'
        when 'out_for_delivery' then 'Water is on the way!'
        when 'rejected' then 'Order could not be accepted'
        when 'cancelled' then 'Order cancelled by supplier'
        else 'Order updated' end,
      format('Your order for %s cans is now %s.%s', o.quantity, replace(p_status::text, '_', ' '),
             coalesce(' ' || p_reason, '')),
      '/app/orders', jsonb_build_object('order_id', o.id, 'status', p_status));
  end if;
  if v_sched_changed then
    perform public.notify(c.user_id, 'delivery_scheduled', 'info', 'Delivery scheduled',
      format('Your %s-can delivery is scheduled for %s.', o.quantity, to_char(o.scheduled_date, 'Dy, DD Mon')),
      '/app/orders', jsonb_build_object('order_id', o.id, 'scheduled_date', o.scheduled_date));
  end if;
  perform public.write_audit('order.' || p_status::text, 'order', o.id, v_sid,
                             jsonb_build_object('from', v_from, 'scheduled_date', o.scheduled_date));
  perform public.refresh_prediction(c.id);
  return o;
end $$;

-- Re-evaluate alerts/prediction when a supplier edits thresholds or usage settings.
create or replace function public.tg_customer_settings_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.low_stock_threshold is distinct from old.low_stock_threshold
     or new.critical_threshold is distinct from old.critical_threshold
     or new.daily_consumption is distinct from old.daily_consumption
     or new.safety_stock is distinct from old.safety_stock then
    perform public.evaluate_stock_alert(new.id);
    perform public.refresh_prediction(new.id);
  end if;
  return null;
end $$;
create trigger customers_settings_changed after update on public.customers
  for each row execute function public.tg_customer_settings_changed();
