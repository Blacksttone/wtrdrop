-- =====================================================================
-- Waterdrop — suppliers pay their monthly Waterdrop bill online (Cashfree).
-- The cashfree-platform Edge Function creates the order; the bill turns
-- "paid" only after Cashfree confirms the order is PAID (webhook or a
-- server-side status check), never on the browser's word.
-- =====================================================================

create table public.platform_payments (
  id uuid primary key default gen_random_uuid(),
  platform_invoice_id uuid not null references public.platform_invoices (id) on delete restrict,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  order_id text not null unique check (order_id ~ '^[A-Za-z0-9_-]{6,45}$'),
  gateway text not null default 'cashfree',
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  gateway_payment_id text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index platform_payments_invoice_idx on public.platform_payments (platform_invoice_id);
alter table public.platform_payments enable row level security;
create policy platform_payments_select on public.platform_payments for select to authenticated using (
  supplier_id = public.my_manager_supplier_id() or public.is_admin()
);
revoke insert, update, delete on public.platform_payments from authenticated;
revoke all on public.platform_payments from anon;

-- Called by the supplier (through the Edge Function, as the user): checks the bill and
-- returns what the gateway order needs. The order row is created by the service role.
create or replace function public.start_platform_payment(p_invoice_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_sid uuid := public.my_manager_supplier_id();
  pi public.platform_invoices;
  s public.suppliers;
  p public.profiles;
begin
  if v_sid is null then
    raise exception 'Only the owner or a manager can pay the Waterdrop bill' using errcode = '42501';
  end if;
  select * into pi from public.platform_invoices where id = p_invoice_id and supplier_id = v_sid;
  if pi.id is null then
    raise exception 'Bill not found' using errcode = 'P0002';
  end if;
  if pi.status <> 'unpaid' or pi.total <= 0 then
    raise exception 'This bill is already settled' using errcode = '22023';
  end if;
  select * into s from public.suppliers where id = v_sid;
  select * into p from public.profiles where id = auth.uid();
  return jsonb_build_object('invoice_id', pi.id, 'invoice_number', pi.invoice_number, 'amount', pi.total,
    'supplier_id', s.id, 'business_name', s.business_name, 'phone', s.phone,
    'email', coalesce(s.email, p.email), 'user_id', auth.uid());
end $$;

create or replace function public.record_platform_order(p_invoice_id uuid, p_order_id text, p_amount numeric, p_user uuid)
returns public.platform_payments
language plpgsql security definer set search_path = public as $$
declare pp public.platform_payments; pi public.platform_invoices;
begin
  select * into pi from public.platform_invoices where id = p_invoice_id;
  insert into public.platform_payments (platform_invoice_id, supplier_id, order_id, amount, created_by)
  values (pi.id, pi.supplier_id, p_order_id, round(p_amount, 2), p_user) returning * into pp;
  return pp;
end $$;

-- Gateway confirmed the order is paid: settle the bill (idempotent).
create or replace function public.finalize_platform_payment(p_order_id text, p_paid_amount numeric, p_gateway_payment_id text default null)
returns public.platform_payments
language plpgsql security definer set search_path = public as $$
declare
  pp public.platform_payments;
  pi public.platform_invoices;
  s public.suppliers;
  a record;
begin
  select * into pp from public.platform_payments where order_id = p_order_id for update;
  if pp.id is null then
    raise exception 'Unknown order' using errcode = 'P0002';
  end if;
  if pp.status = 'paid' then
    return pp;
  end if;
  if round(p_paid_amount, 2) < pp.amount then
    raise exception 'Paid amount % is less than the bill %', p_paid_amount, pp.amount using errcode = '22023';
  end if;
  update public.platform_payments set status = 'paid', paid_at = now(), gateway_payment_id = p_gateway_payment_id
  where id = pp.id returning * into pp;
  update public.platform_invoices set status = 'paid', paid_at = now(),
    payment_reference = left('Cashfree ' || coalesce(p_gateway_payment_id, p_order_id), 120)
  where id = pp.platform_invoice_id and status = 'unpaid' returning * into pi;
  select * into s from public.suppliers where id = pp.supplier_id;
  perform public.notify(s.owner_id, 'payment_received', 'success', 'Waterdrop bill paid',
    format('Thank you! ₹%s received for your Waterdrop bill.', to_char(pp.amount, 'FM999999990.00')),
    '/supplier/waterdrop-bill', jsonb_build_object('platform_payment_id', pp.id), 'platform-paid:' || pp.id);
  for a in select id from public.profiles where role = 'admin' loop
    perform public.notify(a.id, 'payment_received', 'success', 'Supplier paid the Waterdrop bill',
      format('%s paid ₹%s (Cashfree).', s.business_name, to_char(pp.amount, 'FM999999990.00')),
      '/admin/earnings', jsonb_build_object('platform_payment_id', pp.id), 'platform-paid-admin:' || pp.id || ':' || a.id);
  end loop;
  perform public.write_audit('platform.payment_received', 'platform_payment', pp.id, pp.supplier_id,
    jsonb_build_object('amount', pp.amount, 'order_id', pp.order_id, 'gateway_payment_id', p_gateway_payment_id));
  return pp;
end $$;

create or replace function public.fail_platform_payment(p_order_id text) returns void
language sql security definer set search_path = public as $$
  update public.platform_payments set status = 'failed' where order_id = p_order_id and status = 'pending';
$$;

do $$
declare f text;
begin
  execute 'revoke execute on function public.start_platform_payment(uuid) from public, anon';
  execute 'grant execute on function public.start_platform_payment(uuid) to authenticated, service_role';
  foreach f in array array[
    'public.record_platform_order(uuid, text, numeric, uuid)', 'public.finalize_platform_payment(text, numeric, text)',
    'public.fail_platform_payment(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
