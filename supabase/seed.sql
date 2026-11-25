-- =====================================================================
-- Waterdrop LOCAL DEMO DATA (applied by `supabase db reset` / `supabase start`
-- on local stacks only — never run this against production).
--
-- Accounts (password for all: Waterdrop123!)
--   admin@waterdrop.test     platform admin
--   supplier@waterdrop.test  "Blue Spring Waters" supplier
--   customer@waterdrop.test  Meena — connected customer with history
-- =====================================================================

create or replace function pg_temp.demo_user(p_email text, p_role text, p_name text, p_phone text) returns uuid
language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v, 'authenticated', 'authenticated', p_email,
          extensions.crypt('Waterdrop123!', extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}',
          jsonb_build_object('full_name', p_name, 'phone', p_phone, 'role', p_role), now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v, v::text, jsonb_build_object('sub', v::text, 'email', p_email, 'email_verified', true),
          'email', now(), now(), now());
  return v;
end $$;

create or replace function pg_temp.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_admin uuid := pg_temp.demo_user('admin@waterdrop.test', 'customer', 'Platform Admin', '9000000000');
  v_sup uuid := pg_temp.demo_user('supplier@waterdrop.test', 'supplier', 'Ravi Kumar', '9876543210');
  v_cust uuid := pg_temp.demo_user('customer@waterdrop.test', 'customer', 'Meena Iyer', '9876500000');
  v_sid uuid;
  v_code text;
  v_cid uuid;
  v_off uuid;
  v_del uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  i int;
begin
  update public.profiles set role = 'admin' where id = v_admin;

  perform pg_temp.act_as(v_sup);
  select id, business_code into v_sid, v_code from public.register_supplier(
    'Blue Spring Waters', 'Ravi Kumar', '9876543210', 'supplier@waterdrop.test',
    '12 Anna Salai, T Nagar, Chennai 600017', 'T Nagar, Mylapore, Adyar', 40,
    '{"upi_id": "bluespring@upi", "gstin": "33ABCDE1234F1Z5", "bank_name": "Indian Bank", "ifsc": "IDIB000T001"}'::jsonb);
  update public.supplier_settings set billing_day = 1, billing_due_days = 10 where supplier_id = v_sid;

  -- Offline customer managed by supplier
  select id into v_off from public.supplier_add_customer('Sri Ganesh Tiffin Centre', '9840012345', '45 Usman Road, T Nagar',
    'Back entrance', 35, 6, 10, 0);

  -- App customer connects with code
  perform pg_temp.act_as(v_cust);
  select id into v_cid from public.connect_to_supplier('Meena Iyer', '9876500000', 'Flat 3B, Lotus Apartments, 7 Lake View Road, Mylapore',
    '3rd floor, ring the bell twice', v_code, null, 5, 2);

  -- Last month: deliveries (one short) + consumption history
  for i in 0..2 loop
    perform pg_temp.act_as(v_sup);
    select id into v_del from public.record_delivery(v_cid, 10, case when i = 1 then 8 else 10 end,
      (date_trunc('month', v_today) - interval '25 days' + make_interval(days => i * 8))::date);
    perform pg_temp.act_as(v_cust);
    perform public.confirm_delivery(v_del, case when i = 1 then 8 else 10 end);
  end loop;

  -- Generate last month's invoice, then a partial payment
  perform public.generate_invoices(v_sid, v_today);
  perform pg_temp.act_as(v_sup);
  perform public.record_payment(v_cid, 600, 'upi', 'UPI-DEMO-1001', v_today - 2);

  -- This month: a delivery awaiting confirmation + recent usage + a pending order
  perform public.record_delivery(v_cid, 6, 6, v_today);
  perform pg_temp.act_as(v_cust);
  for i in 1..6 loop
    begin
      perform public.record_consumption(v_cid, case when i % 3 = 0 then 3 else 2 end, v_today - i);
    exception when others then null;  -- stock may hit zero in demo history
    end;
  end loop;
  perform public.place_order(v_cid, 10, v_today + 1, 'Please deliver before 10 am');

  perform set_config('request.jwt.claims', '', true);
end $$;
