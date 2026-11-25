-- =====================================================================
-- Waterdrop — auth helpers, ledger engine, stock alerts, notifications,
-- immutability guards and Row Level Security.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Identity helpers (SECURITY DEFINER so they can be used inside policies
-- without recursive RLS evaluation)
-- ---------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and not is_disabled
  );
$$;

create or replace function public.my_supplier_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.suppliers where owner_id = auth.uid();
$$;

create or replace function public.my_customer_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.customers where user_id = auth.uid();
$$;

-- True when running as a trusted backend (service role, cron, migrations)
create or replace function public.is_trusted_backend() returns boolean
language sql stable as $$
  -- No end-user identity and not an anon/authenticated API request.
  select auth.uid() is null
     and coalesce(
           nullif(current_setting('request.jwt.claim.role', true), ''),
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
           ''
         ) not in ('anon', 'authenticated')
     and session_user not in ('anon', 'authenticated');
$$;

-- Audit helper
create or replace function public.write_audit(
  p_action text, p_entity_type text, p_entity_id uuid, p_supplier_id uuid, p_details jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_logs (actor_id, supplier_id, action, entity_type, entity_id, details)
  values (auth.uid(), p_supplier_id, p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------
-- Auth: create a profile for every new auth user.
-- Self-service signups may only become 'customer' or 'supplier'.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role public.app_role := 'customer';
  v_phone text := nullif(regexp_replace(coalesce(new.raw_user_meta_data ->> 'phone', ''), '[^0-9+ ]', '', 'g'), '');
begin
  if (new.raw_user_meta_data ->> 'role') = 'supplier' then
    v_role := 'supplier';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ]{7,16}$' then
    v_phone := null;
  end if;
  insert into public.profiles (id, full_name, phone, email, role)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    v_phone,
    new.email,
    v_role
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users cannot escalate their own role or re-enable themselves.
create or replace function public.tg_guard_profile_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_trusted_backend() or public.is_admin() then
    return new;
  end if;
  if new.role is distinct from old.role or new.is_disabled is distinct from old.is_disabled then
    raise exception 'Not allowed to change role or account status' using errcode = '42501';
  end if;
  if new.id is distinct from old.id then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.tg_guard_profile_update();

-- Supplier owners cannot change their own status, plan, code or owner.
create or replace function public.tg_guard_supplier_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_trusted_backend() or public.is_admin() then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.plan_id is distinct from old.plan_id
     or new.business_code is distinct from old.business_code
     or new.owner_id is distinct from old.owner_id then
    raise exception 'Only platform admins can change status, plan, business code or owner' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger suppliers_guard before update on public.suppliers
  for each row execute function public.tg_guard_supplier_update();

create or replace function public.tg_guard_supplier_settings_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_trusted_backend() or current_setting('waterdrop.billing_engine', true) = 'on' then
    return new;
  end if;
  -- invoice numbering is owned by the billing engine
  if new.invoice_seq is distinct from old.invoice_seq or new.supplier_id is distinct from old.supplier_id then
    raise exception 'invoice_seq and supplier_id are system managed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger supplier_settings_guard before update on public.supplier_settings
  for each row execute function public.tg_guard_supplier_settings_update();

create or replace function public.tg_guard_customer_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_trusted_backend() or public.is_admin() then
    return new;
  end if;
  if new.supplier_id is distinct from old.supplier_id or new.user_id is distinct from old.user_id then
    raise exception 'Customer account ownership cannot be changed' using errcode = '42501';
  end if;
  if new.opening_balance is distinct from old.opening_balance
     and exists (select 1 from public.invoices where customer_id = old.id) then
    raise exception 'Opening balance is locked after the first invoice; use a credit note' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger customers_guard before update on public.customers
  for each row execute function public.tg_guard_customer_update();

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
create or replace function public.notify(
  p_user_id uuid,
  p_type text,
  p_severity text,
  p_title text,
  p_message text,
  p_link text default null,
  p_data jsonb default '{}'::jsonb,
  p_dedupe_key text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_prefs jsonb;
  v_email text;
  v_phone text;
  v_disabled boolean;
  v_id uuid;
  v_noncritical_ok boolean;
begin
  if p_user_id is null then
    return null;
  end if;
  select notification_preferences, email, phone, is_disabled
    into v_prefs, v_email, v_phone, v_disabled
  from public.profiles where id = p_user_id;
  if not found or v_disabled then
    return null;
  end if;

  v_noncritical_ok := coalesce((v_prefs ->> 'noncritical')::boolean, true);
  -- Customers may silence non-critical alerts; critical ones always land in-app.
  if p_type in ('low_stock', 'order_recommended', 'payment_due') and not v_noncritical_ok then
    return null;
  end if;

  insert into public.notifications (
    user_id, notification_type, severity, title, message, link, data, dedupe_key, email_status, whatsapp_status
  ) values (
    p_user_id, p_type, coalesce(p_severity, 'info'), left(p_title, 160), left(p_message, 1000), p_link,
    coalesce(p_data, '{}'::jsonb), p_dedupe_key,
    case when v_email is not null and coalesce((v_prefs ->> 'email')::boolean, true) then 'pending' else 'skipped' end,
    case when v_phone is not null and coalesce((v_prefs ->> 'whatsapp')::boolean, false)
              and p_severity in ('critical', 'warning') then 'pending' else 'skipped' end
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  update public.notifications
     set read_at = now()
   where user_id = auth.uid()
     and read_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- Stock level evaluation & low-stock alerts (one alert per episode)
-- ---------------------------------------------------------------------
create or replace function public.stock_level_for(p_stock integer, p_low integer, p_critical integer)
returns public.stock_alert_level
language sql immutable as $$
  select case
    when p_stock <= p_critical then 'critical'::public.stock_alert_level
    when p_stock <= p_low then 'low'::public.stock_alert_level
    else 'none'::public.stock_alert_level
  end;
$$;

create or replace function public.evaluate_stock_alert(p_customer_id uuid) returns public.stock_alert_level
language plpgsql security definer set search_path = public as $$
declare
  c record;
  s record;
  v_new public.stock_alert_level;
  v_rank_old int;
  v_rank_new int;
  v_owner uuid;
  v_notify_supplier boolean;
  v_msg text;
begin
  select * into c from public.customers where id = p_customer_id;
  select * into s from public.customer_stock where customer_id = p_customer_id for update;
  if c is null or s is null then
    return null;
  end if;

  -- Stock is "unconfirmed" until an opening stock or confirmed delivery exists.
  if not s.has_opening_stock then
    return 'none';
  end if;

  v_new := public.stock_level_for(s.current_stock, c.low_stock_threshold, c.critical_threshold);
  v_rank_old := array_position(array['none','low','critical']::text[], s.alert_level::text);
  v_rank_new := array_position(array['none','low','critical']::text[], v_new::text);

  if v_rank_new > v_rank_old and c.status = 'active' then
    if v_new = 'critical' then
      v_msg := case when s.current_stock = 0
        then 'You have run out of water cans. Order now to get water delivered.'
        else format('Water stock is critically low. You have %s can%s remaining. Order now to avoid running out of water.',
                    s.current_stock, case when s.current_stock = 1 then '' else 's' end)
      end;
      perform public.notify(c.user_id, 'critical_stock', 'critical', 'Critical: water stock almost empty',
                            v_msg, '/app/order', jsonb_build_object('customer_id', c.id, 'stock', s.current_stock));
      select owner_id into v_owner from public.suppliers where id = c.supplier_id;
      select coalesce((notification_settings ->> 'notify_critical_customers')::boolean, true)
        into v_notify_supplier from public.supplier_settings where supplier_id = c.supplier_id;
      if coalesce(v_notify_supplier, true) then
        perform public.notify(v_owner, 'critical_stock', 'warning',
          format('%s is running out of water', c.customer_name),
          format('%s has %s can%s left.', c.customer_name, s.current_stock, case when s.current_stock = 1 then '' else 's' end),
          '/supplier/customers/' || c.id, jsonb_build_object('customer_id', c.id, 'stock', s.current_stock));
      end if;
    else
      perform public.notify(c.user_id, 'low_stock', 'warning', 'Water stock is running low',
        format('You have %s cans remaining. Consider ordering soon.', s.current_stock),
        '/app/order', jsonb_build_object('customer_id', c.id, 'stock', s.current_stock));
    end if;
    update public.customer_stock set alert_level = v_new, last_alert_at = now() where customer_id = p_customer_id;
  elsif v_rank_new < v_rank_old then
    -- Stock went back up: reset alert state so the next drop alerts again.
    update public.customer_stock set alert_level = v_new where customer_id = p_customer_id;
  end if;
  return v_new;
end $$;

-- ---------------------------------------------------------------------
-- Inventory ledger engine
-- ---------------------------------------------------------------------
create or replace function public.tg_inventory_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_balance integer;
  v_supplier uuid;
begin
  select supplier_id into v_supplier from public.customers where id = new.customer_id;
  if v_supplier is null then
    raise exception 'Unknown customer %', new.customer_id;
  end if;
  if v_supplier <> new.supplier_id then
    raise exception 'Ledger supplier mismatch for customer %', new.customer_id;
  end if;

  insert into public.customer_stock (customer_id, supplier_id)
  values (new.customer_id, new.supplier_id)
  on conflict (customer_id) do nothing;

  select current_stock into v_balance from public.customer_stock
   where customer_id = new.customer_id for update;

  if v_balance + new.quantity < 0 then
    raise exception 'Stock cannot become negative (current %, change %). Record a stockout or correction instead.',
      v_balance, new.quantity using errcode = 'P0001';
  end if;

  new.balance_after := v_balance + new.quantity;

  update public.customer_stock
     set current_stock = new.balance_after,
         has_opening_stock = has_opening_stock or new.transaction_type in ('opening_stock', 'delivery_received'),
         updated_at = now()
   where customer_id = new.customer_id;
  return new;
end $$;

create trigger inventory_before_insert before insert on public.inventory_transactions
  for each row execute function public.tg_inventory_before_insert();

create or replace function public.tg_inventory_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.evaluate_stock_alert(new.customer_id);
  return null;
end $$;

create trigger inventory_after_insert after insert on public.inventory_transactions
  for each row execute function public.tg_inventory_after_insert();

-- Append-only ledgers: no edits, no deletes — corrections are new rows.
create or replace function public.tg_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; record an adjustment instead', tg_table_name using errcode = '42501';
end $$;

create trigger inventory_no_update before update or delete on public.inventory_transactions
  for each row execute function public.tg_append_only();
create trigger delivery_adjustments_no_update before update or delete on public.delivery_adjustments
  for each row execute function public.tg_append_only();
create trigger invoice_items_no_update before update or delete on public.invoice_items
  for each row execute function public.tg_append_only();
create trigger credit_notes_no_update before update or delete on public.credit_notes
  for each row execute function public.tg_append_only();
create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function public.tg_append_only();

-- Confirmed deliveries are frozen (quantity corrections go to delivery_adjustments).
create or replace function public.tg_guard_delivery_update() returns trigger
language plpgsql as $$
begin
  if old.status = 'confirmed' then
    if new.confirmed_quantity is distinct from old.confirmed_quantity
       or new.expected_quantity is distinct from old.expected_quantity
       or new.actual_quantity is distinct from old.actual_quantity
       or new.unit_price is distinct from old.unit_price
       or new.customer_id is distinct from old.customer_id
       or new.delivery_date is distinct from old.delivery_date
       or new.status is distinct from old.status then
      raise exception 'Confirmed deliveries cannot be edited; create a delivery adjustment' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger deliveries_guard before update on public.deliveries
  for each row execute function public.tg_guard_delivery_update();

-- Finalized invoices: money columns are immutable.
create or replace function public.tg_guard_invoice_update() returns trigger
language plpgsql as $$
begin
  if new.invoice_number is distinct from old.invoice_number
     or new.customer_id is distinct from old.customer_id
     or new.supplier_id is distinct from old.supplier_id
     or new.billing_period_start is distinct from old.billing_period_start
     or new.billing_period_end is distinct from old.billing_period_end
     or new.total_quantity is distinct from old.total_quantity
     or new.subtotal is distinct from old.subtotal
     or new.tax_amount is distinct from old.tax_amount
     or new.current_charges is distinct from old.current_charges
     or new.previous_balance is distinct from old.previous_balance
     or new.payments_received is distinct from old.payments_received
     or new.credits is distinct from old.credits
     or new.amount_due is distinct from old.amount_due
     or new.invoice_date is distinct from old.invoice_date
     or new.due_date is distinct from old.due_date then
    raise exception 'Finalized invoices cannot be edited; issue a credit note' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger invoices_guard before update on public.invoices
  for each row execute function public.tg_guard_invoice_update();
create trigger invoices_no_delete before delete on public.invoices
  for each row execute function public.tg_append_only();

-- =====================================================================
-- Row Level Security
-- Reads are scoped per role; all writes to stock, deliveries, orders,
-- invoices and payments go through SECURITY DEFINER functions.
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_settings enable row level security;
alter table public.supplier_invites enable row level security;
alter table public.customers enable row level security;
alter table public.customer_stock enable row level security;
alter table public.orders enable row level security;
alter table public.order_status_history enable row level security;
alter table public.deliveries enable row level security;
alter table public.delivery_adjustments enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.consumption_records enable row level security;
alter table public.stock_correction_requests enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.credit_notes enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.job_runs enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid()
  or public.is_admin()
  or id in (select user_id from public.customers where supplier_id = public.my_supplier_id())
  or id in (select s.owner_id from public.suppliers s join public.customers c on c.supplier_id = s.id where c.user_id = auth.uid())
);
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- subscription plans
create policy plans_select on public.subscription_plans for select to authenticated
  using (is_active or public.is_admin());
create policy plans_admin_all on public.subscription_plans for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- suppliers
create policy suppliers_select on public.suppliers for select to authenticated using (
  owner_id = auth.uid()
  or public.is_admin()
  or id in (select supplier_id from public.customers where user_id = auth.uid())
);
create policy suppliers_update on public.suppliers for update to authenticated
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

-- supplier settings
create policy supplier_settings_select on public.supplier_settings for select to authenticated using (
  supplier_id = public.my_supplier_id()
  or public.is_admin()
  or supplier_id in (select supplier_id from public.customers where user_id = auth.uid())
);
create policy supplier_settings_update on public.supplier_settings for update to authenticated
  using (supplier_id = public.my_supplier_id() or public.is_admin())
  with check (supplier_id = public.my_supplier_id() or public.is_admin());

-- invites
create policy invites_select on public.supplier_invites for select to authenticated
  using (supplier_id = public.my_supplier_id() or public.is_admin());
create policy invites_insert on public.supplier_invites for insert to authenticated
  with check (supplier_id = public.my_supplier_id());
create policy invites_update on public.supplier_invites for update to authenticated
  using (supplier_id = public.my_supplier_id()) with check (supplier_id = public.my_supplier_id());

-- customers
create policy customers_select on public.customers for select to authenticated using (
  user_id = auth.uid() or supplier_id = public.my_supplier_id() or public.is_admin()
);
create policy customers_update_supplier on public.customers for update to authenticated
  using (supplier_id = public.my_supplier_id() or public.is_admin())
  with check (supplier_id = public.my_supplier_id() or public.is_admin());

-- Tenant-scoped read policies for the business tables
do $$
declare
  t text;
begin
  foreach t in array array[
    'customer_stock', 'orders', 'deliveries', 'delivery_adjustments', 'inventory_transactions',
    'consumption_records', 'stock_correction_requests', 'invoices', 'credit_notes', 'payments'
  ] loop
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated using (
        supplier_id = public.my_supplier_id()
        or customer_id in (select public.my_customer_ids())
        or public.is_admin()
      )$f$, t);
  end loop;
end $$;

create policy order_history_select on public.order_status_history for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_id)   -- inherits orders RLS
);
create policy invoice_items_select on public.invoice_items for select to authenticated using (
  exists (select 1 from public.invoices i where i.id = invoice_id) -- inherits invoices RLS
);
create policy payment_allocations_select on public.payment_allocations for select to authenticated using (
  exists (select 1 from public.payments p where p.id = payment_id) -- inherits payments RLS
);

-- notifications: own only (mark read via mark_notifications_read)
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());

-- audit & jobs
create policy audit_select on public.audit_logs for select to authenticated
  using (public.is_admin() or (supplier_id is not null and supplier_id = public.my_supplier_id()));
create policy job_runs_select on public.job_runs for select to authenticated
  using (public.is_admin());

-- Defence in depth: anonymous users get nothing from these tables.
revoke all on all tables in schema public from anon;
-- Authenticated users never write ledgers/financial tables directly.
revoke insert, update, delete on
  public.customer_stock, public.orders, public.order_status_history, public.deliveries,
  public.delivery_adjustments, public.inventory_transactions, public.consumption_records,
  public.stock_correction_requests, public.invoices, public.invoice_items, public.credit_notes,
  public.payments, public.payment_allocations, public.notifications, public.audit_logs, public.job_runs,
  public.subscription_plans
from authenticated;
grant insert, update, delete on public.subscription_plans to authenticated; -- admin-only via RLS
revoke insert, delete on public.profiles, public.suppliers, public.supplier_settings, public.customers from authenticated;

-- Internal helpers are not callable by clients.
revoke execute on function public.notify(uuid, text, text, text, text, text, jsonb, text) from public, anon, authenticated;
revoke execute on function public.evaluate_stock_alert(uuid) from public, anon, authenticated;
revoke execute on function public.write_audit(text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
