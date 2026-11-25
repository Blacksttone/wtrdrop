-- =====================================================================
-- Waterdrop — tighten function privileges (from Supabase security advisor).
--
-- 1. Internal helpers that skip caller checks must never be callable via
--    the REST API. They are only invoked from other SECURITY DEFINER
--    functions (which run as the owner), so revoking client access is safe.
-- 2. Anonymous visitors get no RPC access at all (every app action needs
--    a signed-in user), now and for functions added later.
-- 3. Pin search_path on the remaining functions.
-- =====================================================================


-- No anonymous RPC access to anything in public (existing and future functions).
-- Functions are also executable through the implicit PUBLIC grant, which anon
-- inherits, so: remember who can run what today, drop PUBLIC/anon, and give
-- authenticated/service_role back exactly the access they had.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    if r.auth_ok then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from public;

do $$
declare f text;
begin
  foreach f in array array[
    -- confirms ANY delivery without an ownership check; public entry point is confirm_delivery()
    'public.apply_delivery_confirmation(uuid, integer, text, boolean)',
    -- read another tenant's data by id; clients use get_customer_summary / get_stock_prediction
    'public.compute_prediction(uuid)',
    'public.customer_balance(uuid)',
    'public.customer_unbilled(uuid)',
    'public.effective_can_price(uuid)',
    'public.customer_local_date(uuid, timestamptz)',
    -- internal guards / helpers
    'public.customer_for_actor(uuid, boolean)',
    'public.require_auth()',
    'public.require_active_supplier()',
    'public.require_admin()',
    'public.report_scope(uuid)',
    'public.generate_business_code()',
    'public.is_trusted_backend()',
    -- trigger functions
    'public.tg_customer_settings_changed()',
    'public.tg_guard_customer_update()',
    'public.tg_guard_profile_update()',
    'public.tg_guard_supplier_settings_update()',
    'public.tg_guard_supplier_update()',
    'public.tg_inventory_after_insert()',
    'public.tg_inventory_before_insert()',
    'public.tg_guard_delivery_update()',
    'public.tg_guard_invoice_update()',
    'public.tg_append_only()',
    'public.tg_set_updated_at()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- Fixed search_path for functions that did not set one.
alter function public.billing_period_for(integer, date) set search_path = public;
alter function public.generate_business_code() set search_path = public;
alter function public.is_trusted_backend() set search_path = public;
alter function public.order_transition_allowed(public.order_status, public.order_status) set search_path = public;
alter function public.require_auth() set search_path = public;
alter function public.stock_level_for(integer, integer, integer) set search_path = public;
alter function public.tg_append_only() set search_path = public;
alter function public.tg_guard_delivery_update() set search_path = public;
alter function public.tg_guard_invoice_update() set search_path = public;
alter function public.tg_set_updated_at() set search_path = public;
