-- Test helpers (loaded before every test file; each file runs in a fresh session)
create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

create or replace function tests.create_user(p_email text, p_role text, p_name text default 'Test User')
returns uuid language plpgsql security definer as $$
declare v uuid;
begin
  insert into auth.users (email, raw_user_meta_data)
  values (p_email, jsonb_build_object('role', p_role, 'full_name', p_name, 'phone', '9876543210'))
  returning id into v;
  return v;
end $$;

create or replace function tests.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
$$;
create or replace function tests.logout() returns void language sql as $$
  select set_config('request.jwt.claims', '', false);
$$;

create or replace function tests.eq(p_actual anyelement, p_expected anyelement, p_msg text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'ASSERTION FAILED: % (expected %, got %)', p_msg, p_expected, p_actual;
  end if;
  raise notice 'ok - %', p_msg;
end $$;

-- Runs SQL and asserts it raises an error whose message contains p_like.
create or replace function tests.throws(p_sql text, p_like text, p_msg text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if p_like is null or sqlerrm ~* p_like then
      raise notice 'ok - % (raised: %)', p_msg, sqlerrm;
      return;
    end if;
    raise exception 'ASSERTION FAILED: % (unexpected error: %)', p_msg, sqlerrm;
  end;
  raise exception 'ASSERTION FAILED: % (no error raised)', p_msg;
end $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
create table if not exists tests.ctx (k text primary key, v uuid);
grant all on tests.ctx to anon, authenticated, service_role;
create or replace function tests.supplier_code(p_n int default 1) returns text language sql security definer as $$
  select business_code from public.suppliers order by created_at offset p_n - 1 limit 1;
$$;
grant execute on function tests.supplier_code(int) to authenticated;
-- Test-only wrappers around internal helpers that clients may not call.
create or replace function tests.local_date(p uuid) returns date language sql security definer as $$ select public.customer_local_date(p) $$;
create or replace function tests.balance(p uuid) returns numeric language sql security definer as $$ select public.customer_balance(p) $$;
create or replace function tests.prediction(p uuid) returns jsonb language sql security definer as $$ select public.compute_prediction(p) $$;
grant execute on function tests.local_date(uuid), tests.balance(uuid), tests.prediction(uuid) to authenticated;
