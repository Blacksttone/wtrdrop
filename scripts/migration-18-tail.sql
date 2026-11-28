-- Sunday 8:00 AM India time: ask every app customer to count their cans.
create or replace function public.run_weekly_stock_check(p_now timestamptz default now()) returns integer
language plpgsql security definer set search_path = public as $$
declare c record; n integer := 0; v_week text := to_char(p_now at time zone 'Asia/Kolkata', 'IYYY-IW');
begin
  for c in select id from public.customers
           where status = 'active' and blocked_at is null and (account_id is not null or user_id is not null) loop
    if public.notify_customer(c.id, 'all', 'stock_check', 'info', 'Weekly stock check 💧',
         'How many full water cans do you have now? Tap to update so your water never runs out.',
         '/app?stockcheck=1', jsonb_build_object('customer_id', c.id), 'stockcheck:' || c.id || ':' || v_week) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

do $$
declare f text;
begin
  execute 'revoke execute on function public.customer_stock_check(uuid, integer) from public, anon';
  execute 'grant execute on function public.customer_stock_check(uuid, integer) to authenticated, service_role';
  execute 'revoke execute on function public.run_weekly_stock_check(timestamptz) from public, anon, authenticated';
  execute 'grant execute on function public.run_weekly_stock_check(timestamptz) to service_role';
  foreach f in array array['public.list_supplier_customers()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- Sundays 02:30 UTC = 8:00 AM India time.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('wd-weekly-stock-check', '30 2 * * 0', $c$ select public.run_weekly_stock_check(); $c$);
  end if;
end $$;
