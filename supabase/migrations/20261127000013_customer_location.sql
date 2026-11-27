-- =====================================================================
-- Waterdrop — delivery location (GPS) for customers / branches.
-- The supplier (any co-worker, e.g. delivery staff at the door) or the
-- customer (owner, admin or member with access to the branch) saves the
-- phone's current location; suppliers get one-tap directions.
-- =====================================================================

alter table public.customers
  add column latitude double precision check (latitude between -90 and 90),
  add column longitude double precision check (longitude between -180 and 180),
  add column location_accuracy_m integer check (location_accuracy_m between 0 and 100000),
  add column location_updated_at timestamptz,
  add column location_updated_by uuid references public.profiles (id) on delete set null,
  add constraint customers_location_pair check ((latitude is null) = (longitude is null));

alter table public.supplier_connection_requests
  add column latitude double precision check (latitude between -90 and 90),
  add column longitude double precision check (longitude between -180 and 180),
  add column location_accuracy_m integer check (location_accuracy_m between 0 and 100000),
  add constraint requests_location_pair check ((latitude is null) = (longitude is null));

-- Save (or clear, with nulls) the delivery location of a branch.
create or replace function public.set_customer_location(
  p_customer_id uuid, p_latitude double precision, p_longitude double precision, p_accuracy_m integer default null
) returns public.customers
language plpgsql security definer set search_path = public as $$
declare
  c public.customers;
begin
  perform public.require_auth();
  select * into c from public.customers where id = p_customer_id;
  if c.id is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if not coalesce(c.id in (select public.my_customer_ids()) or c.supplier_id = public.my_supplier_id() or public.is_admin(), false) then
    raise exception 'Not allowed for this customer' using errcode = '42501';
  end if;
  if (p_latitude is null) <> (p_longitude is null)
     or coalesce(p_latitude not between -90 and 90 or p_longitude not between -180 and 180, false) then
    raise exception 'Invalid location' using errcode = '22023';
  end if;
  update public.customers set
    latitude = p_latitude, longitude = p_longitude,
    location_accuracy_m = case when p_latitude is null then null else least(greatest(round(p_accuracy_m), 0), 100000) end,
    location_updated_at = case when p_latitude is null then null else now() end,
    location_updated_by = case when p_latitude is null then null else auth.uid() end
  where id = c.id returning * into c;
  perform public.write_audit(case when p_latitude is null then 'customer.location_cleared' else 'customer.location_saved' end,
                             'customer', c.id, c.supplier_id, jsonb_build_object('accuracy_m', c.location_accuracy_m));
  return c;
end $$;

-- Location sent with a supplier request (before the branch exists).
create or replace function public.set_request_location(
  p_request_id uuid, p_latitude double precision, p_longitude double precision, p_accuracy_m integer default null
) returns void
language plpgsql security definer set search_path = public as $$
declare r public.supplier_connection_requests;
begin
  select * into r from public.supplier_connection_requests where id = p_request_id;
  if r.id is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  perform public.require_account_admin(r.account_id);
  if r.status <> 'pending' then
    raise exception 'Request already %', r.status using errcode = '22023';
  end if;
  if p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'Invalid location' using errcode = '22023';
  end if;
  update public.supplier_connection_requests set latitude = p_latitude, longitude = p_longitude,
    location_accuracy_m = least(greatest(round(p_accuracy_m), 0), 100000)
  where id = r.id;
end $$;

-- When a request is approved, its location moves onto the new branch.
create or replace function public.tg_request_location_to_branch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and new.customer_id is not null and new.latitude is not null
     and (old.status is distinct from 'approved') then
    update public.customers set latitude = new.latitude, longitude = new.longitude,
      location_accuracy_m = new.location_accuracy_m, location_updated_at = now(), location_updated_by = new.requested_by
    where id = new.customer_id and latitude is null;
  end if;
  return new;
end $$;
create trigger supplier_connection_requests_location after update on public.supplier_connection_requests
  for each row execute function public.tg_request_location_to_branch();

-- Security fix: for callers without a supplier the old check evaluated to NULL
-- and let them through, so a customer could change a confirmed delivery.
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
  if not coalesce(d.supplier_id = public.my_supplier_id() or public.is_admin(), false) then
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
  perform public.notify_customer(c.id, 'all', 'delivery_confirmed', 'info', 'Delivery corrected',
    format('Your %s delivery was corrected from %s to %s cans. Reason: %s',
           to_char(d.delivery_date, 'DD Mon'), v_prev, p_new_quantity, a.reason),
    '/app/deliveries', jsonb_build_object('delivery_id', d.id, 'adjustment_id', a.id));
  perform public.write_audit('delivery.adjusted', 'delivery', d.id, d.supplier_id,
    jsonb_build_object('from', v_prev, 'to', p_new_quantity, 'reason', a.reason));
  perform public.refresh_prediction(d.customer_id);
  return a;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.set_customer_location(uuid, double precision, double precision, integer)',
    'public.set_request_location(uuid, double precision, double precision, integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  execute 'revoke execute on function public.tg_request_location_to_branch() from public, anon, authenticated';
end $$;
