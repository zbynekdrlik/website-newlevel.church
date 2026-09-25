create table if not exists invitation.dishwasher_notification_runs (
  notification_key text primary key,
  kind text not null check (kind in ('monthly_schedule', 'shift_reminder')),
  target_date date not null,
  discord_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

alter table invitation.dishwasher_notification_runs enable row level security;
revoke all on invitation.dishwasher_notification_runs from public, anon, authenticated;
grant all on invitation.dishwasher_notification_runs to service_role;

select cron.unschedule('dishwasher-roster-notifications-hourly')
where exists (
  select 1 from cron.job
  where jobname = 'dishwasher-roster-notifications-hourly'
);

select cron.schedule(
  'dishwasher-roster-notifications-hourly',
  '5 * * * *',
  $$
  select net.http_post(
    url := 'https://kbpuhcuiljbwgxgiauku.supabase.co/functions/v1/dishwasher-roster/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', coalesce(
        (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'dispatch_message_cron_secret'
          limit 1
        ),
        ''
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);
