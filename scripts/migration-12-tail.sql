-- ---------------------------------------------------------------------
-- Customer accounts & members
-- ---------------------------------------------------------------------
create or replace function public.create_customer_account(p_name text, p_type public.customer_account_type)
returns public.customer_accounts
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_auth();
  a public.customer_accounts;
begin
  if (select role from public.profiles where id = v_uid) <> 'customer' then
    raise exception 'Only customer accounts can create a home, store or company' using errcode = '42501';
  end if;
  if (select count(*) from public.customer_accounts where owner_id = v_uid) >= 10 then
    raise exception 'You already own 10 accounts' using errcode = '22023';
  end if;
  insert into public.customer_accounts (name, account_type, owner_id)
  values (trim(p_name), coalesce(p_type, 'home'), v_uid) returning * into a;
  insert into public.customer_account_members (account_id, user_id, role) values (a.id, v_uid, 'owner');
  perform public.write_audit('account.created', 'customer_account', a.id, null, jsonb_build_object('type', a.account_type));
  return a;
end $$;

create or replace function public.update_customer_account(p_account_id uuid, p_name text default null,
                                                          p_type public.customer_account_type default null)
returns public.customer_accounts
language plpgsql security definer set search_path = public as $$
declare a public.customer_accounts;
begin
  perform public.require_account_admin(p_account_id);
  update public.customer_accounts set name = coalesce(nullif(trim(p_name), ''), name), account_type = coalesce(p_type, account_type)
  where id = p_account_id returning * into a;
  return a;
end $$;

create or replace function public.create_member_invite(p_account_id uuid, p_role public.account_member_role,
                                                       p_all_branches boolean default true, p_branch_ids uuid[] default '{}',
                                                       p_label text default null)
returns public.customer_member_invites
language plpgsql security definer set search_path = public as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  i int;
  r public.customer_member_invites;
begin
  perform public.require_account_admin(p_account_id);
  if p_role = 'owner' then
    raise exception 'There is only one owner' using errcode = '22023';
  end if;
  if p_role = 'admin' and public.my_account_role(p_account_id) <> 'owner' then
    raise exception 'Only the owner can add admins' using errcode = '42501';
  end if;
  if not coalesce(p_all_branches, true) and (
       coalesce(array_length(p_branch_ids, 1), 0) = 0
       or exists (select 1 from unnest(p_branch_ids) b where b not in (select id from public.customers where account_id = p_account_id))) then
    raise exception 'Choose at least one branch of this account' using errcode = '22023';
  end if;
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.customer_member_invites where code = v_code)
          and not exists (select 1 from public.staff_invites where code = v_code);
  end loop;
  insert into public.customer_member_invites (account_id, code, role, all_branches, branch_ids, label, created_by)
  values (p_account_id, v_code, p_role, coalesce(p_all_branches, true), coalesce(p_branch_ids, '{}'),
          nullif(trim(coalesce(p_label, '')), ''), auth.uid())
  returning * into r;
  return r;
end $$;

create or replace function public.join_customer_account(p_code text)
returns public.customer_account_members
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_auth();
  v_inv public.customer_member_invites;
  a public.customer_accounts;
  m public.customer_account_members;
  b uuid;
begin
  if (select role from public.profiles where id = v_uid) <> 'customer' then
    raise exception 'Family / team codes are for accounts registered as "I need water"' using errcode = '42501';
  end if;
  select * into v_inv from public.customer_member_invites where code = upper(trim(p_code)) for update;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.used_at is not null or v_inv.expires_at <= now() then
    raise exception 'This code is invalid, used or expired. Ask the account owner for a new one.' using errcode = '22023';
  end if;
  if exists (select 1 from public.customer_account_members where account_id = v_inv.account_id and user_id = v_uid) then
    raise exception 'You are already a member of this account' using errcode = '23505';
  end if;
  insert into public.customer_account_members (account_id, user_id, role, all_branches)
  values (v_inv.account_id, v_uid, v_inv.role, v_inv.all_branches) returning * into m;
  foreach b in array v_inv.branch_ids loop
    insert into public.customer_member_branches (member_id, customer_id) values (m.id, b) on conflict do nothing;
  end loop;
  update public.customer_member_invites set used_by = v_uid, used_at = now() where id = v_inv.id;
  select * into a from public.customer_accounts where id = v_inv.account_id;
  perform public.notify(a.owner_id, 'account', 'info', 'New member joined',
    format('%s joined %s as %s.', coalesce(nullif((select full_name from public.profiles where id = v_uid), ''), 'Someone'),
           a.name, m.role), '/app/team', jsonb_build_object('member_id', m.id));
  perform public.write_audit('account.member_joined', 'customer_account', a.id, null, jsonb_build_object('role', m.role));
  return m;
end $$;

create or replace function public.list_account_members(p_account_id uuid)
returns table (id uuid, user_id uuid, full_name text, email text, phone text, role public.account_member_role,
               status text, all_branches boolean, branch_ids uuid[], created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.user_id, p.full_name, p.email, p.phone, m.role, m.status, m.all_branches,
         coalesce((select array_agg(b.customer_id) from public.customer_member_branches b where b.member_id = m.id), '{}'),
         m.created_at
  from public.customer_account_members m join public.profiles p on p.id = m.user_id
  where m.account_id = p_account_id and p_account_id in (select public.my_account_ids())
  order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.created_at;
$$;

create or replace function public.update_account_member(p_member_id uuid, p_role public.account_member_role default null,
                                                        p_status text default null, p_all_branches boolean default null,
                                                        p_branch_ids uuid[] default null)
returns public.customer_account_members
language plpgsql security definer set search_path = public as $$
declare
  m public.customer_account_members;
  v_me text;
  b uuid;
begin
  select * into m from public.customer_account_members where id = p_member_id for update;
  if m.id is null then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  perform public.require_account_admin(m.account_id);
  v_me := public.my_account_role(m.account_id);
  if m.role = 'owner' then
    raise exception 'The owner cannot be changed or blocked' using errcode = '42501';
  end if;
  if v_me = 'admin' and (m.role = 'admin' or p_role = 'admin') then
    raise exception 'Only the owner can manage admins' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'There is only one owner' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('active', 'blocked') then
    raise exception 'Status must be active or blocked' using errcode = '22023';
  end if;
  update public.customer_account_members set
    role = coalesce(p_role, role), status = coalesce(p_status, status),
    all_branches = coalesce(p_all_branches, all_branches),
    blocked_at = case when p_status = 'blocked' then now() when p_status = 'active' then null else blocked_at end
  where id = m.id returning * into m;
  if p_branch_ids is not null then
    delete from public.customer_member_branches where member_id = m.id;
    foreach b in array p_branch_ids loop
      if b in (select id from public.customers where account_id = m.account_id) then
        insert into public.customer_member_branches (member_id, customer_id) values (m.id, b);
      end if;
    end loop;
  end if;
  if p_status is not null then
    perform public.notify(m.user_id, 'account', case when p_status = 'blocked' then 'critical' else 'success' end,
      case when p_status = 'blocked' then 'Your access was blocked' else 'Your access was restored' end,
      case when p_status = 'blocked' then 'The account owner blocked your access.' else 'You can use the account again.' end,
      '/home', '{}'::jsonb);
  end if;
  perform public.write_audit('account.member_updated', 'customer_account', m.account_id, null,
    jsonb_build_object('member_id', m.id, 'role', m.role, 'status', m.status));
  return m;
end $$;

create or replace function public.remove_account_member(p_member_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.customer_account_members;
begin
  select * into m from public.customer_account_members where id = p_member_id;
  if m.id is null then
    raise exception 'Member not found' using errcode = 'P0002';
  end if;
  if m.user_id = auth.uid() and m.role <> 'owner' then
    delete from public.customer_account_members where id = m.id;  -- leaving an account yourself
    return;
  end if;
  perform public.require_account_admin(m.account_id);
  if m.role = 'owner' then
    raise exception 'The owner cannot be removed' using errcode = '42501';
  end if;
  if m.role = 'admin' and public.my_account_role(m.account_id) <> 'owner' then
    raise exception 'Only the owner can remove admins' using errcode = '42501';
  end if;
  delete from public.customer_account_members where id = m.id;
  perform public.write_audit('account.member_removed', 'customer_account', m.account_id, null, jsonb_build_object('member_id', m.id));
end $$;

create or replace function public.revoke_member_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_account uuid;
begin
  select account_id into v_account from public.customer_member_invites where id = p_invite_id;
  perform public.require_account_admin(v_account);
  update public.customer_member_invites set revoked_at = now() where id = p_invite_id and used_at is null;
end $$;

-- ---------------------------------------------------------------------
-- Supplier search + connection requests (supplier approves)
-- ---------------------------------------------------------------------
create or replace function public.search_suppliers(p_query text default null)
returns table (supplier_id uuid, business_name text, delivery_area text, address text, logo_url text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_auth();
  return query
  select s.id, s.business_name, s.delivery_area, s.address, s.logo_url
  from public.suppliers s
  where s.status = 'active' and s.listed
    and (coalesce(trim(p_query), '') = ''
         or s.business_name ilike '%' || trim(p_query) || '%'
         or s.delivery_area ilike '%' || trim(p_query) || '%'
         or s.address ilike '%' || trim(p_query) || '%')
  order by s.business_name
  limit 30;
end $$;

create or replace function public.request_supplier_connection(
  p_account_id uuid, p_supplier_id uuid, p_contact_name text, p_phone text, p_address text,
  p_branch_name text default null, p_delivery_instructions text default null, p_household_type text default null,
  p_members_count integer default null, p_opening_stock integer default null, p_daily_consumption integer default 0
) returns public.supplier_connection_requests
language plpgsql security definer set search_path = public as $$
declare
  r public.supplier_connection_requests;
  s public.suppliers;
  a public.customer_accounts;
begin
  perform public.require_account_admin(p_account_id);
  select * into s from public.suppliers where id = p_supplier_id;
  if s.id is null or s.status <> 'active' or not s.listed then
    raise exception 'This supplier is not accepting requests' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.customers where account_id = p_account_id and supplier_id = p_supplier_id
             and lower(address) = lower(trim(p_address))) then
    raise exception 'This address is already connected to this supplier' using errcode = '23505';
  end if;
  if exists (select 1 from public.supplier_connection_requests where account_id = p_account_id
             and supplier_id = p_supplier_id and lower(address) = lower(trim(p_address)) and status = 'pending') then
    raise exception 'A request for this address is already waiting for the supplier' using errcode = '23505';
  end if;
  select * into a from public.customer_accounts where id = p_account_id;
  insert into public.supplier_connection_requests (account_id, supplier_id, branch_name, contact_name, phone, address,
    delivery_instructions, household_type, members_count, opening_stock, daily_consumption, requested_by)
  values (p_account_id, p_supplier_id, nullif(trim(coalesce(p_branch_name, '')), ''), trim(p_contact_name),
          nullif(trim(coalesce(p_phone, '')), ''), trim(p_address), nullif(trim(coalesce(p_delivery_instructions, '')), ''),
          p_household_type, p_members_count, p_opening_stock, coalesce(p_daily_consumption, 0), auth.uid())
  returning * into r;
  perform public.notify(s.owner_id, 'account', 'warning', 'New customer request',
    format('%s (%s) wants water delivery at %s.', a.name, a.account_type, r.address),
    '/supplier/customers?tab=requests', jsonb_build_object('request_id', r.id));
  return r;
end $$;

create or replace function public.cancel_connection_request(p_request_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.supplier_connection_requests;
begin
  select * into r from public.supplier_connection_requests where id = p_request_id for update;
  if r.id is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  perform public.require_account_admin(r.account_id);
  if r.status <> 'pending' then
    raise exception 'Request already %', r.status using errcode = '22023';
  end if;
  update public.supplier_connection_requests set status = 'cancelled', decided_at = now() where id = r.id;
end $$;

create or replace function public.decide_connection_request(p_request_id uuid, p_approve boolean, p_reason text default null)
returns public.supplier_connection_requests
language plpgsql security definer set search_path = public as $$
declare
  v_sid uuid := public.require_active_supplier();
  r public.supplier_connection_requests;
  c public.customers;
  a public.customer_accounts;
  m record;
begin
  select * into r from public.supplier_connection_requests where id = p_request_id and supplier_id = v_sid for update;
  if r.id is null then
    raise exception 'Request not found' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception 'Request already %', r.status using errcode = '23505';
  end if;
  if not p_approve and (p_reason is null or char_length(trim(p_reason)) < 3) then
    raise exception 'Please give a reason (shown to the customer)' using errcode = '22023';
  end if;
  if p_approve then
    c := public.create_branch(r.account_id, r.supplier_id, r.branch_name, r.contact_name, r.phone, r.address,
                              r.delivery_instructions, r.household_type, r.members_count, r.opening_stock,
                              r.daily_consumption, r.requested_by);
  end if;
  update public.supplier_connection_requests set
    status = case when p_approve then 'approved' else 'rejected' end, reason = nullif(trim(coalesce(p_reason, '')), ''),
    customer_id = c.id, decided_by = auth.uid(), decided_at = now()
  where id = r.id returning * into r;
  select * into a from public.customer_accounts where id = r.account_id;
  for m in select user_id from public.customer_account_members
           where account_id = r.account_id and status = 'active' and role in ('owner', 'admin') loop
    perform public.notify(m.user_id, 'account', case when p_approve then 'success' else 'warning' end,
      case when p_approve then 'Supplier accepted your request' else 'Supplier declined your request' end,
      case when p_approve then format('%s will now deliver to %s.', (select business_name from public.suppliers where id = v_sid), r.address)
           else format('%s could not accept the request for %s: %s', (select business_name from public.suppliers where id = v_sid),
                       r.address, r.reason) end,
      '/app/branches', jsonb_build_object('request_id', r.id));
  end loop;
  perform public.write_audit(case when p_approve then 'customer.request_approved' else 'customer.request_rejected' end,
                             'supplier_connection_request', r.id, v_sid, jsonb_build_object('reason', r.reason));
  return r;
end $$;

-- Code / QR / invite link: instant connection (no approval).
-- Older app versions call this without p_account_id: an account is created
-- (or reused) for them so they keep working.
drop function public.connect_to_supplier(text, text, text, text, text, text, integer, integer, text, integer);
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
  p_members_count integer default null,
  p_account_id uuid default null,
  p_branch_name text default null
) returns public.customers
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := public.require_auth();
  v_supplier public.suppliers;
  v_invite public.supplier_invites;
  v_account uuid := p_account_id;
  c public.customers;
begin
  if (select role from public.profiles where id = v_uid) <> 'customer' then
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

  if v_account is null then
    select id into v_account from public.customer_accounts where owner_id = v_uid order by created_at limit 1;
    if v_account is null then
      v_account := (public.create_customer_account(p_customer_name,
        case p_household_type when 'shop' then 'store'::public.customer_account_type
                              when 'office' then 'company'::public.customer_account_type
                              else 'home'::public.customer_account_type end)).id;
    end if;
  else
    perform public.require_account_admin(v_account);
  end if;

  c := public.create_branch(v_account, v_supplier.id, p_branch_name, p_customer_name, p_phone, p_address,
                            p_delivery_instructions, p_household_type, p_members_count, p_opening_stock,
                            p_daily_consumption, v_uid);
  if v_invite.id is not null then
    update public.supplier_invites set uses = uses + 1 where id = v_invite.id;
  end if;
  update public.profiles set full_name = coalesce(nullif(full_name, ''), trim(p_customer_name)),
                             phone = coalesce(phone, nullif(trim(coalesce(p_phone, '')), ''))
   where id = v_uid;
  return c;
end $$;

-- ---------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.my_customer_ids()', 'public.my_billing_customer_ids()', 'public.my_account_ids()',
    'public.my_account_role(uuid)',
    'public.create_customer_account(text, public.customer_account_type)',
    'public.update_customer_account(uuid, text, public.customer_account_type)',
    'public.create_member_invite(uuid, public.account_member_role, boolean, uuid[], text)',
    'public.join_customer_account(text)', 'public.list_account_members(uuid)',
    'public.update_account_member(uuid, public.account_member_role, text, boolean, uuid[])',
    'public.remove_account_member(uuid)', 'public.revoke_member_invite(uuid)',
    'public.search_suppliers(text)',
    'public.request_supplier_connection(uuid, uuid, text, text, text, text, text, text, integer, integer, integer)',
    'public.cancel_connection_request(uuid)', 'public.decide_connection_request(uuid, boolean, text)',
    'public.connect_to_supplier(text, text, text, text, text, text, integer, integer, text, integer, uuid, text)',
    'public.update_my_customer_settings(uuid, integer, boolean, time, text, integer, integer, integer, text, text, text, text, integer, text)',
    'public.list_supplier_customers()', 'public.admin_list_customers(text)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.head_customer_id(uuid)', 'public.billing_group(uuid)', 'public.require_account_admin(uuid)',
    'public.customer_for_billing(uuid)',
    'public.notify_customer(uuid, text, text, text, text, text, text, jsonb, text)',
    'public.create_branch(uuid, uuid, text, text, text, text, text, text, integer, integer, integer, uuid)',
    'public.customer_for_actor(uuid, boolean)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Realtime: requests appear live for suppliers.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.supplier_connection_requests';
  end if;
end $$;
