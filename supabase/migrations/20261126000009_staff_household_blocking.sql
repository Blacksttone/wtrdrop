-- =====================================================================
-- Waterdrop — household details, supplier co-workers, block / unblock.
--
-- Roles inside a supplier business:
--   owner    : everything (the account that registered the business)
--   manager  : everything except co-workers and business settings
--   delivery : customers, orders, deliveries and stock only (no money)
-- Owners and managers can block / unblock customers; owners can block /
-- unblock co-workers. Blocked users lose access immediately.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Household details (customers)
-- ---------------------------------------------------------------------
alter table public.customers
  add column household_type text check (household_type in ('single', 'couple', 'family', 'shared_room', 'office', 'shop', 'other')),
  add column members_count integer check (members_count between 1 and 500),
  add column blocked_at timestamptz,
  add column block_reason text check (block_reason is null or char_length(block_reason) <= 300),
  add column blocked_by uuid references public.profiles (id);

-- ---------------------------------------------------------------------
-- Co-workers
-- ---------------------------------------------------------------------
create type public.staff_role as enum ('manager', 'delivery');

create table public.supplier_staff (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  user_id uuid not null unique references public.profiles (id) on delete cascade,  -- one business per co-worker
  role public.staff_role not null default 'delivery',
  staff_name text not null check (char_length(staff_name) between 1 and 120),
  phone text,
  status text not null default 'active' check (status in ('active', 'blocked')),
  blocked_at timestamptz,
  added_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index supplier_staff_supplier_idx on public.supplier_staff (supplier_id);

create table public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  code text not null unique check (code ~ '^[A-Z0-9]{8}$'),
  role public.staff_role not null,
  label text check (label is null or char_length(label) <= 80),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references public.profiles (id),
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index staff_invites_supplier_idx on public.staff_invites (supplier_id);

-- ---------------------------------------------------------------------
-- Identity helpers now understand co-workers
-- ---------------------------------------------------------------------
create or replace function public.my_supplier_id() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.suppliers where owner_id = auth.uid()),
    (select supplier_id from public.supplier_staff where user_id = auth.uid() and status = 'active')
  );
$$;

create or replace function public.my_supplier_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.suppliers where owner_id = auth.uid()) then 'owner'
    else (select role::text from public.supplier_staff where user_id = auth.uid() and status = 'active')
  end;
$$;

-- Supplier id when the caller may see money / edit customers (owner or manager).
create or replace function public.my_manager_supplier_id() returns uuid
language sql stable security definer set search_path = public as $$
  select case when public.my_supplier_role() in ('owner', 'manager') then public.my_supplier_id() end;
$$;

-- Any active member of an active supplier business (owner, manager or delivery).
create or replace function public.require_supplier_member() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid;
  v_status public.supplier_status;
begin
  perform public.require_auth();
  v_id := public.my_supplier_id();
  if v_id is null then
    if exists (select 1 from public.supplier_staff where user_id = auth.uid() and status = 'blocked') then
      raise exception 'Your access to this business has been blocked by the owner' using errcode = '42501';
    end if;
    raise exception 'Supplier account required' using errcode = '42501';
  end if;
  select status into v_status from public.suppliers where id = v_id;
  if v_status <> 'active' then
    raise exception 'Supplier account is suspended. Contact Waterdrop support.' using errcode = '42501';
  end if;
  return v_id;
end $$;

-- Owner or manager (billing, payments, adjustments, customer management …).
create or replace function public.require_active_supplier() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid := public.require_supplier_member();
begin
  if public.my_supplier_role() not in ('owner', 'manager') then
    raise exception 'Only the owner or a manager can do this' using errcode = '42501';
  end if;
  return v_id;
end $$;

create or replace function public.require_supplier_owner() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid := public.require_supplier_member();
begin
  if public.my_supplier_role() <> 'owner' then
    raise exception 'Only the business owner can do this' using errcode = '42501';
  end if;
  return v_id;
end $$;

-- Blocked customers cannot act on their account (viewing data is via RLS only).
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
    if c.blocked_at is not null then
      raise exception 'This account has been blocked by your supplier. Please contact them.' using errcode = '42501';
    end if;
    return c;
  end if;
  if p_allow_supplier and (c.supplier_id = public.my_supplier_id() or public.is_admin()) then
    return c;
  end if;
  raise exception 'Not allowed for this customer' using errcode = '42501';
end $$;

-- ---------------------------------------------------------------------
-- Co-worker management
-- ---------------------------------------------------------------------
create or replace function public.create_staff_invite(p_role public.staff_role, p_label text default null)
returns public.staff_invites
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_supplier_owner();
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  i int;
  r public.staff_invites;
begin
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.staff_invites where code = v_code);
  end loop;
  insert into public.staff_invites (supplier_id, code, role, label, created_by)
  values (v_sid, v_code, p_role, nullif(trim(coalesce(p_label, '')), ''), auth.uid())
  returning * into r;
  perform public.write_audit('staff.invite_created', 'staff_invite', r.id, v_sid, jsonb_build_object('role', p_role));
  return r;
end $$;

create or replace function public.join_supplier_as_staff(p_code text)
returns public.supplier_staff
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_auth();
  v_profile public.profiles;
  v_inv public.staff_invites;
  v_owner uuid;
  st public.supplier_staff;
begin
  select * into v_profile from public.profiles where id = v_uid;
  if v_profile.role <> 'supplier' then
    raise exception 'Co-worker codes are for accounts registered as "I supply water"' using errcode = '42501';
  end if;
  if exists (select 1 from public.suppliers where owner_id = v_uid) then
    raise exception 'This account already owns a business' using errcode = '23505';
  end if;
  if exists (select 1 from public.supplier_staff where user_id = v_uid) then
    raise exception 'This account is already a co-worker of a business' using errcode = '23505';
  end if;
  select * into v_inv from public.staff_invites where code = upper(trim(p_code)) for update;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.used_at is not null or v_inv.expires_at <= now() then
    raise exception 'This co-worker code is invalid, used or expired. Ask the owner for a new one.' using errcode = '22023';
  end if;
  if (select status from public.suppliers where id = v_inv.supplier_id) <> 'active' then
    raise exception 'This business is not active' using errcode = '42501';
  end if;
  insert into public.supplier_staff (supplier_id, user_id, role, staff_name, phone, added_by)
  values (v_inv.supplier_id, v_uid, v_inv.role, coalesce(nullif(v_profile.full_name, ''), v_profile.email, 'Co-worker'),
          v_profile.phone, v_inv.created_by)
  returning * into st;
  update public.staff_invites set used_by = v_uid, used_at = now() where id = v_inv.id;
  select owner_id into v_owner from public.suppliers where id = v_inv.supplier_id;
  perform public.notify(v_owner, 'account', 'info', 'Co-worker joined',
    format('%s joined as %s.', st.staff_name, st.role), '/supplier/team', jsonb_build_object('staff_id', st.id));
  perform public.write_audit('staff.joined', 'supplier_staff', st.id, st.supplier_id, jsonb_build_object('role', st.role));
  return st;
end $$;

create or replace function public.list_staff()
returns table (id uuid, user_id uuid, staff_name text, phone text, email text, role public.staff_role,
               status text, blocked_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.user_id, s.staff_name, coalesce(s.phone, p.phone), p.email, s.role, s.status, s.blocked_at, s.created_at
  from public.supplier_staff s join public.profiles p on p.id = s.user_id
  where s.supplier_id = public.my_manager_supplier_id()
  order by s.created_at;
$$;

create or replace function public.update_staff(p_staff_id uuid, p_role public.staff_role default null, p_status text default null)
returns public.supplier_staff
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_supplier_owner();
  st public.supplier_staff;
begin
  if p_status is not null and p_status not in ('active', 'blocked') then
    raise exception 'Status must be active or blocked' using errcode = '22023';
  end if;
  update public.supplier_staff set
    role = coalesce(p_role, role),
    status = coalesce(p_status, status),
    blocked_at = case when p_status = 'blocked' then now() when p_status = 'active' then null else blocked_at end
  where id = p_staff_id and supplier_id = v_sid
  returning * into st;
  if st.id is null then
    raise exception 'Co-worker not found' using errcode = 'P0002';
  end if;
  if p_status is not null then
    perform public.notify(st.user_id, 'account', case when p_status = 'blocked' then 'critical' else 'success' end,
      case when p_status = 'blocked' then 'Your access was blocked' else 'Your access was restored' end,
      case when p_status = 'blocked' then 'The business owner blocked your co-worker access.'
           else 'You can use the business account again.' end, '/home', '{}'::jsonb);
  end if;
  perform public.write_audit('staff.updated', 'supplier_staff', st.id, v_sid,
                             jsonb_build_object('role', st.role, 'status', st.status));
  return st;
end $$;

create or replace function public.remove_staff(p_staff_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_supplier_owner();
  st public.supplier_staff;
begin
  delete from public.supplier_staff where id = p_staff_id and supplier_id = v_sid returning * into st;
  if st.id is null then
    raise exception 'Co-worker not found' using errcode = 'P0002';
  end if;
  perform public.write_audit('staff.removed', 'supplier_staff', st.id, v_sid, jsonb_build_object('user_id', st.user_id));
end $$;

create or replace function public.revoke_staff_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_supplier_owner();
begin
  update public.staff_invites set revoked_at = now() where id = p_invite_id and supplier_id = v_sid and used_at is null;
end $$;

-- ---------------------------------------------------------------------
-- Block / unblock customers (owner or manager)
-- ---------------------------------------------------------------------
create or replace function public.set_customer_blocked(p_customer_id uuid, p_blocked boolean, p_reason text default null)
returns public.customers
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  c public.customers;
begin
  if p_blocked and (p_reason is null or char_length(trim(p_reason)) < 3) then
    raise exception 'Please give a reason for blocking' using errcode = '22023';
  end if;
  perform set_config('waterdrop.block_change', 'on', true);
  update public.customers set
    blocked_at = case when p_blocked then now() else null end,
    block_reason = case when p_blocked then trim(p_reason) else null end,
    blocked_by = case when p_blocked then auth.uid() else null end
  where id = p_customer_id and supplier_id = v_sid
  returning * into c;
  perform set_config('waterdrop.block_change', 'off', true);
  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  perform public.notify(c.user_id, 'account', case when p_blocked then 'critical' else 'success' end,
    case when p_blocked then 'Account blocked by your supplier' else 'Account unblocked' end,
    case when p_blocked then format('Your supplier blocked this account: %s', c.block_reason)
         else 'You can order water again.' end, '/app', '{}'::jsonb);
  perform public.write_audit(case when p_blocked then 'customer.blocked' else 'customer.unblocked' end,
                             'customer', c.id, v_sid, jsonb_build_object('reason', p_reason));
  return c;
end $$;

-- Customers cannot change their own block fields; suppliers use set_customer_blocked().
create or replace function public.tg_guard_customer_block() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.blocked_at is distinct from old.blocked_at or new.block_reason is distinct from old.block_reason
      or new.blocked_by is distinct from old.blocked_by)
     and not public.is_trusted_backend() and not public.is_admin()
     and coalesce(current_setting('waterdrop.block_change', true), '') <> 'on' then
    raise exception 'Use block / unblock to change this' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger customers_block_guard before update on public.customers
  for each row execute function public.tg_guard_customer_block();

-- ---------------------------------------------------------------------
-- Functions recreated for staff roles / household fields
-- ---------------------------------------------------------------------
drop function public.connect_to_supplier(text, text, text, text, text, text, integer, integer);
drop function public.update_my_customer_settings(uuid, integer, boolean, time, text, integer, integer, integer, text, text, text);
drop function public.list_supplier_customers();

create or replace function public.connect_to_supplier(
  p_customer_name text,
  p_phone text,
  p_address text,
  p_delivery_instructions text default null,
  p_business_code text default null,
  p_invite_token text default null,
  p_opening_stock integer default null,
  p_daily_consumption integer default 0,
  p_household_type text default null,
  p_members_count integer default null
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
                                daily_consumption, low_stock_threshold, critical_threshold, safety_stock,
                                household_type, members_count)
  values (v_uid, v_supplier.id, trim(p_customer_name), nullif(trim(coalesce(p_phone, '')), ''), trim(p_address),
          nullif(trim(coalesce(p_delivery_instructions, '')), ''), coalesce(p_daily_consumption, 0),
          greatest(v_settings.default_low_stock_threshold, v_settings.default_critical_threshold),
          v_settings.default_critical_threshold, v_settings.default_safety_stock,
          p_household_type, p_members_count)
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
  p_phone text default null,
  p_household_type text default null,
  p_members_count integer default null
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
    phone = coalesce(nullif(trim(p_phone), ''), phone),
    household_type = coalesce(p_household_type, household_type),
    members_count = coalesce(p_members_count, members_count)
  where id = c.id
  returning * into c;
  perform public.evaluate_stock_alert(c.id);
  perform public.refresh_prediction(c.id);
  return c;
end $$;

create or replace function public.list_supplier_customers()
returns table (
  id uuid, customer_name text, phone text, address text, status public.customer_status, has_app boolean,
  current_stock integer, stock_confirmed boolean, level text, predicted_empty_date date,
  daily_consumption integer, can_price numeric, balance numeric, created_at timestamptz,
  household_type text, members_count integer, blocked boolean
)
language sql stable security definer set search_path = public as $$
  select c.id, c.customer_name, c.phone, c.address, c.status, c.user_id is not null,
         coalesce(s.current_stock, 0), coalesce(s.has_opening_stock, false),
         case when not coalesce(s.has_opening_stock, false) then 'unknown'
              else case public.stock_level_for(s.current_stock, c.low_stock_threshold, c.critical_threshold)
                     when 'critical' then 'critical' when 'low' then 'low' else 'ok' end end,
         s.predicted_empty_date, c.daily_consumption, public.effective_can_price(c.id),
         public.customer_balance(c.id), c.created_at,
         c.household_type, c.members_count, c.blocked_at is not null
  from public.customers c left join public.customer_stock s on s.customer_id = c.id
  where c.supplier_id = public.my_supplier_id()
  order by c.customer_name;
$$;

create or replace function public.report_scope(p_supplier_id uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if public.is_admin() and p_supplier_id is not null then
    return p_supplier_id;
  end if;
  if public.my_supplier_id() is null then
    raise exception 'Supplier account required' using errcode = '42501';
  end if;
  if public.my_supplier_role() not in ('owner', 'manager') then
    raise exception 'Only the owner or a manager can view reports' using errcode = '42501';
  end if;
  return public.my_supplier_id();
end $$;

-- Delivery co-workers may record deliveries and update orders.
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
  v_sid uuid := public.require_supplier_member();
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

create or replace function public.update_order_status(
  p_order_id uuid, p_status public.order_status, p_scheduled_date date default null, p_reason text default null
) returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_supplier_member();
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

create or replace function public.cancel_delivery(p_delivery_id uuid, p_reason text)
returns public.deliveries
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_supplier_member();
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

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.supplier_staff enable row level security;
alter table public.staff_invites enable row level security;

create policy staff_select on public.supplier_staff for select to authenticated using (
  user_id = auth.uid() or supplier_id = public.my_manager_supplier_id() or public.is_admin()
);
create policy staff_invites_select on public.staff_invites for select to authenticated using (
  supplier_id in (select id from public.suppliers where owner_id = auth.uid()) or public.is_admin()
);
revoke insert, update, delete on public.supplier_staff, public.staff_invites from authenticated;
revoke all on public.supplier_staff, public.staff_invites from anon;

-- Co-workers can read their business profile.
drop policy suppliers_select on public.suppliers;
create policy suppliers_select on public.suppliers for select to authenticated using (
  owner_id = auth.uid()
  or id = public.my_supplier_id()
  or public.is_admin()
  or id in (select supplier_id from public.customers where user_id = auth.uid())
);

-- Business settings: owner only.
drop policy supplier_settings_update on public.supplier_settings;
create policy supplier_settings_update on public.supplier_settings for update to authenticated
  using (supplier_id in (select id from public.suppliers where owner_id = auth.uid()) or public.is_admin())
  with check (supplier_id in (select id from public.suppliers where owner_id = auth.uid()) or public.is_admin());

-- Customer edits (price, thresholds): owner or manager.
drop policy customers_update_supplier on public.customers;
create policy customers_update_supplier on public.customers for update to authenticated
  using (supplier_id = public.my_manager_supplier_id() or public.is_admin())
  with check (supplier_id = public.my_manager_supplier_id() or public.is_admin());

-- Money: owner or manager (delivery co-workers do not see bills or payments).
do $$
declare t text;
begin
  foreach t in array array['invoices', 'credit_notes', 'payments'] loop
    execute format('drop policy %1$s_select on public.%1$I', t);
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated using (
        supplier_id = public.my_manager_supplier_id()
        or customer_id in (select public.my_customer_ids())
        or public.is_admin()
      )$f$, t);
  end loop;
end $$;

drop policy audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select to authenticated
  using (public.is_admin() or (supplier_id is not null and supplier_id = public.my_manager_supplier_id()));

-- Owners/managers see their co-workers' profiles.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid()
  or public.is_admin()
  or id in (select user_id from public.customers where supplier_id = public.my_supplier_id())
  or id in (select user_id from public.supplier_staff where supplier_id = public.my_manager_supplier_id())
  or id in (select s.owner_id from public.suppliers s join public.customers c on c.supplier_id = s.id where c.user_id = auth.uid())
);

-- ---------------------------------------------------------------------
-- Function privileges (anon gets nothing; internal helpers stay private)
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.my_supplier_role()', 'public.my_manager_supplier_id()',
    'public.connect_to_supplier(text, text, text, text, text, text, integer, integer, text, integer)',
    'public.update_my_customer_settings(uuid, integer, boolean, time, text, integer, integer, integer, text, text, text, text, integer)',
    'public.list_supplier_customers()', 'public.create_staff_invite(public.staff_role, text)',
    'public.join_supplier_as_staff(text)', 'public.list_staff()',
    'public.update_staff(uuid, public.staff_role, text)', 'public.remove_staff(uuid)',
    'public.revoke_staff_invite(uuid)', 'public.set_customer_blocked(uuid, boolean, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.require_supplier_member()', 'public.require_supplier_owner()', 'public.tg_guard_customer_block()',
    'public.require_active_supplier()', 'public.customer_for_actor(uuid, boolean)', 'public.report_scope(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
