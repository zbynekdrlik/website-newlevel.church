select cron.unschedule('dispatch-message-cron-every-minute')
where exists (
  select 1 from cron.job where jobname = 'dispatch-message-cron-every-minute'
);

select cron.schedule(
  'dispatch-message-cron-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://kbpuhcuiljbwgxgiauku.supabase.co/functions/v1/dispatch-message-cron',
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
    body := jsonb_build_object('limit', 50),
    timeout_milliseconds := 25000
  );
  $$
);
