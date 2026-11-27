-- For the customer app (and the supplier): cans of the supplier at this branch.
create or replace function public.cans_with_customer(p_customer_id uuid) returns integer
language plpgsql stable security definer set search_path = public as $$
declare v_sid uuid;
begin
  perform public.require_auth();
  select supplier_id into v_sid from public.customers where id = p_customer_id;
  if v_sid is null then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if not coalesce(p_customer_id in (select public.my_customer_ids()) or v_sid = public.my_supplier_id() or public.is_admin(), false) then
    raise exception 'Not allowed for this customer' using errcode = '42501';
  end if;
  return public.cans_out(p_customer_id);
end $$;

-- Fix the empty-can count of a recorded delivery (any co-worker; works after confirmation too).
create or replace function public.set_delivery_empty_cans(p_delivery_id uuid, p_empty_cans integer)
returns public.deliveries
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_supplier_member();
  d public.deliveries;
  v_old integer;
begin
  select * into d from public.deliveries where id = p_delivery_id and supplier_id = v_sid for update;
  if d.id is null then
    raise exception 'Delivery not found' using errcode = 'P0002';
  end if;
  if d.status = 'cancelled' then
    raise exception 'This delivery was cancelled' using errcode = '22023';
  end if;
  if p_empty_cans is null or p_empty_cans not between 0 and 1000 then
    raise exception 'Empty cans must be between 0 and 1000' using errcode = '22023';
  end if;
  v_old := d.empty_cans_collected;
  update public.deliveries set empty_cans_collected = p_empty_cans where id = d.id returning * into d;
  perform public.write_audit('delivery.empty_cans_changed', 'delivery', d.id, v_sid, jsonb_build_object('from', v_old, 'to', p_empty_cans));
  return d;
end $$;

-- Set how many cans the customer has right now (e.g. cans given before Waterdrop). Owner / manager.
create or replace function public.set_cans_with_customer(p_customer_id uuid, p_count integer, p_reason text default null)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  v_now integer;
begin
  if not exists (select 1 from public.customers where id = p_customer_id and supplier_id = v_sid) then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if p_count is null or p_count not between 0 and 10000 then
    raise exception 'Cans must be between 0 and 10000' using errcode = '22023';
  end if;
  v_now := public.cans_out(p_customer_id);
  update public.customers set cans_out_correction = cans_out_correction + (p_count - v_now) where id = p_customer_id;
  perform public.write_audit('customer.cans_out_set', 'customer', p_customer_id, v_sid,
    jsonb_build_object('from', v_now, 'to', p_count, 'reason', nullif(trim(coalesce(p_reason, '')), '')));
  return p_count;
end $$;

-- Daily can movement for the supplier: full cans given, empty cans taken back, per co-worker.
create or replace function public.supplier_can_report(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_sid uuid := public.require_supplier_member();
  v_date date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);
begin
  return jsonb_build_object(
    'date', v_date,
    'deliveries', (select count(*) from public.deliveries where supplier_id = v_sid and delivery_date = v_date and status <> 'cancelled'),
    'full_cans', (select coalesce(sum(actual_quantity), 0) from public.deliveries
                  where supplier_id = v_sid and delivery_date = v_date and status <> 'cancelled'),
    'empty_cans', (select coalesce(sum(empty_cans_collected), 0) from public.deliveries
                   where supplier_id = v_sid and delivery_date = v_date and status <> 'cancelled'),
    'cans_with_customers', (select coalesce(sum(greatest(public.cans_out(id), 0)), 0) from public.customers where supplier_id = v_sid),
    'by_person', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object(
                 'name', coalesce(st.staff_name, case when d.created_by = s.owner_id then s.owner_name end, p.full_name, 'Unknown'),
                 'deliveries', count(*), 'full_cans', sum(d.actual_quantity), 'empty_cans', sum(d.empty_cans_collected)) as x
        from public.deliveries d
        join public.suppliers s on s.id = d.supplier_id
        left join public.supplier_staff st on st.supplier_id = d.supplier_id and st.user_id = d.created_by
        left join public.profiles p on p.id = d.created_by
        where d.supplier_id = v_sid and d.delivery_date = v_date and d.status <> 'cancelled'
        group by st.staff_name, s.owner_id, s.owner_name, p.full_name, d.created_by) t), '[]'::jsonb)
  );
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.record_delivery(uuid, integer, integer, date, uuid, text, integer)',
    'public.list_supplier_customers()',
    'public.cans_with_customer(uuid)',
    'public.set_delivery_empty_cans(uuid, integer)',
    'public.set_cans_with_customer(uuid, integer, text)',
    'public.supplier_can_report(date)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  execute 'revoke execute on function public.cans_out(uuid) from public, anon, authenticated';
  execute 'grant execute on function public.cans_out(uuid) to service_role';
end $$;
