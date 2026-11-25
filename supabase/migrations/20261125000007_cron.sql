-- =====================================================================
-- Waterdrop — scheduled automation (pg_cron).
-- All jobs are idempotent and safe to retry: unique constraints on
-- consumption days / invoice periods / notification dedupe keys guarantee
-- that re-running a job never duplicates data.
--
-- Times are UTC. 18:30 UTC = 00:00 IST.
-- Email/WhatsApp dispatch runs in the `dispatch-notifications` Edge Function;
-- it is scheduled here via pg_net when the vault secrets exist (see README).
-- =====================================================================
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron not available; schedule jobs via the run-scheduled-jobs Edge Function instead';
    return;
  end if;

  create extension if not exists pg_cron;

  -- Every 15 minutes: automatic daily consumption (customer local time aware)
  perform cron.schedule('wd-auto-consumption', '*/15 * * * *', $c$ select public.process_auto_consumption(); $c$);
  -- Hourly: prediction refresh + low-stock / order-soon alerts
  perform cron.schedule('wd-refresh-predictions', '5 * * * *', $c$ select public.refresh_all_predictions(); $c$);
  -- Daily 00:20 IST: generate invoices for suppliers whose billing day is today
  perform cron.schedule('wd-monthly-billing', '50 18 * * *', $c$ select public.run_monthly_billing((now() at time zone 'Asia/Kolkata')::date); $c$);
  -- Daily 09:00 IST: overdue status + payment due / overdue reminders
  perform cron.schedule('wd-payment-reminders', '30 3 * * *', $c$ select public.process_payment_reminders((now() at time zone 'Asia/Kolkata')::date); $c$);
  -- Weekly: prune old job run rows
  perform cron.schedule('wd-prune-jobs', '0 20 * * 0', $c$ delete from public.job_runs where started_at < now() - interval '90 days'; $c$);

  -- Every 2 minutes: call the email/WhatsApp dispatcher if configured.
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from information_schema.schemata where schema_name = 'vault') then
    create extension if not exists pg_net;
    perform cron.schedule('wd-dispatch-notifications', '*/2 * * * *', $c$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'wd_functions_url') || '/dispatch-notifications',
        headers := jsonb_build_object('Content-Type', 'application/json',
                     'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'wd_cron_secret')),
        body := '{}'::jsonb
      )
      where exists (select 1 from vault.decrypted_secrets where name = 'wd_functions_url');
    $c$);
  end if;
end $$;
