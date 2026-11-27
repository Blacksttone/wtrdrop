-- =====================================================================
-- Waterdrop — phone push notifications (Firebase Cloud Messaging).
-- The Android app registers its FCM token after login. Every in-app
-- notification for a user with a token gets push_status = 'pending'; the
-- dispatch-notifications Edge Function sends it (called right away via
-- pg_net, and every 2 minutes by pg_cron as a retry).
-- =====================================================================

create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null unique check (char_length(token) between 20 and 4096),
  platform text not null default 'android' check (platform in ('android', 'ios', 'web')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index push_tokens_user_idx on public.push_tokens (user_id);
alter table public.push_tokens enable row level security;
create policy push_tokens_select on public.push_tokens for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.push_tokens from authenticated;
revoke all on public.push_tokens from anon;

alter table public.notifications
  add column push_status text not null default 'skipped' check (push_status in ('pending', 'sending', 'sent', 'failed', 'skipped'));
create index notifications_push_pending_idx on public.notifications (created_at) where push_status = 'pending';

-- A phone token belongs to whoever is logged in on that phone now.
create or replace function public.register_push_token(p_token text, p_platform text default 'android') returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := public.require_auth();
begin
  if p_token is null or char_length(p_token) not between 20 and 4096 then
    raise exception 'Invalid push token' using errcode = '22023';
  end if;
  insert into public.push_tokens (user_id, token, platform) values (v_uid, p_token, coalesce(p_platform, 'android'))
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, last_seen_at = now();
  -- Keep at most 5 phones per person.
  delete from public.push_tokens where user_id = v_uid and id not in (
    select id from public.push_tokens where user_id = v_uid order by last_seen_at desc limit 5);
end $$;

create or replace function public.unregister_push_token(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_tokens where token = p_token and user_id = auth.uid();
end $$;

-- Queue a push for users who have the app on a phone.
create or replace function public.tg_notification_push_pending() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.push_tokens where user_id = new.user_id) then
    new.push_status := 'pending';
  end if;
  return new;
end $$;
create trigger notifications_push_pending before insert on public.notifications
  for each row execute function public.tg_notification_push_pending();

-- Wake the dispatcher immediately (once per statement) so pushes arrive in seconds.
create or replace function public.tg_notification_push_kick() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  if to_regnamespace('net') is null or to_regnamespace('vault') is null then
    return null;
  end if;
  if not exists (select 1 from new_rows where push_status = 'pending') then
    return null;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'wd_functions_url'$q$ into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'wd_cron_secret'$q$ into v_secret;
  if v_url is null or v_secret is null then
    return null;
  end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3)'
    using v_url || '/dispatch-notifications',
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
          '{}'::jsonb;
  return null;
exception when others then
  return null; -- never block the action that created the notification
end $$;
create trigger notifications_push_kick after insert on public.notifications
  referencing new table as new_rows for each statement execute function public.tg_notification_push_kick();

-- The dispatcher checks its shared secret against the vault (no Edge Function secret to manage).
create or replace function public.verify_dispatch_secret(p_secret text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if to_regnamespace('vault') is null or p_secret is null or p_secret = '' then
    return false;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'wd_cron_secret'$q$ into v;
  return v is not null and v = p_secret;
end $$;

-- Outbox claim / completion now include the push channel.
drop function public.claim_notification_batch(integer);
create or replace function public.claim_notification_batch(p_limit integer default 50)
returns table (id uuid, channel text, user_id uuid, email text, phone text, full_name text, title text,
               message text, link text, severity text, notification_type text)
language plpgsql security definer set search_path = public as $$
begin
  return query
  with picked as (
    select n.id from public.notifications n
    where (n.email_status = 'pending' or n.whatsapp_status = 'pending' or n.push_status = 'pending')
      and n.delivery_attempts < 5 and n.created_at > now() - interval '3 days'
    order by n.created_at
    limit p_limit
    for update skip locked
  ), upd as (
    update public.notifications n set
      email_status = case when n.email_status = 'pending' then 'sending' else n.email_status end,
      whatsapp_status = case when n.whatsapp_status = 'pending' then 'sending' else n.whatsapp_status end,
      push_status = case when n.push_status = 'pending' then 'sending' else n.push_status end,
      delivery_attempts = n.delivery_attempts + 1
    from picked where n.id = picked.id
    returning n.id, n.user_id, n.title, n.message, n.link, n.severity, n.notification_type,
              n.email_status, n.whatsapp_status, n.push_status
  )
  select u.id, ch.channel, u.user_id, p.email, p.phone, p.full_name, u.title, u.message, u.link, u.severity, u.notification_type
  from upd u join public.profiles p on p.id = u.user_id
  cross join lateral (values ('push', u.push_status), ('email', u.email_status), ('whatsapp', u.whatsapp_status)) as ch(channel, st)
  where ch.st = 'sending';
end $$;

-- p_error starting with "not configured" marks the channel skipped (no pointless retries).
create or replace function public.complete_notification_delivery(p_id uuid, p_channel text, p_ok boolean, p_error text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_next text;
begin
  select case when p_ok then 'sent'
              when p_error like 'not configured%' then 'skipped'
              when delivery_attempts >= 5 then 'failed' else 'pending' end
    into v_next from public.notifications where id = p_id;
  if p_channel = 'email' then
    update public.notifications set email_status = v_next,
      last_delivery_error = case when p_ok then last_delivery_error else left(p_error, 500) end where id = p_id;
  elsif p_channel = 'whatsapp' then
    update public.notifications set whatsapp_status = v_next,
      last_delivery_error = case when p_ok then last_delivery_error else left(p_error, 500) end where id = p_id;
  elsif p_channel = 'push' then
    update public.notifications set push_status = v_next,
      last_delivery_error = case when p_ok then last_delivery_error else left(p_error, 500) end where id = p_id;
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.register_push_token(text, text)', 'public.unregister_push_token(text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.claim_notification_batch(integer)', 'public.complete_notification_delivery(uuid, text, boolean, text)',
    'public.verify_dispatch_secret(text)', 'public.tg_notification_push_pending()', 'public.tg_notification_push_kick()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  execute 'grant execute on function public.claim_notification_batch(integer) to service_role';
  execute 'grant execute on function public.complete_notification_delivery(uuid, text, boolean, text) to service_role';
  execute 'grant execute on function public.verify_dispatch_secret(text) to service_role';
end $$;
