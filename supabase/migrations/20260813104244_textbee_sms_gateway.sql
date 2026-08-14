alter table invitation.contacts
  add column if not exists sms_enabled boolean not null default true;

alter table invitation.message_queue
  add column if not exists automation_id text;

alter table invitation.message_logs
  add column if not exists automation_id text,
  add column if not exists sent_at timestamptz;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'invitation.message_batches'::regclass
      and conname = 'message_batches_channel_strategy_check'
  ) then
    alter table invitation.message_batches
      drop constraint message_batches_channel_strategy_check;
  end if;
end;
$$;

alter table invitation.message_batches
  add constraint message_batches_channel_strategy_check
  check (channel_strategy in ('whatsapp_then_email', 'email_only', 'whatsapp_only', 'sms_then_email', 'sms_only'));

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'invitation.message_queue'::regclass
      and conname = 'message_queue_channel_check'
  ) then
    alter table invitation.message_queue
      drop constraint message_queue_channel_check;
  end if;
end;
$$;

alter table invitation.message_queue
  add constraint message_queue_channel_check
  check (channel in ('whatsapp', 'email', 'sms'));

create unique index if not exists message_queue_automation_contact_channel_unique
  on invitation.message_queue (automation_id, contact_id, channel)
  where automation_id is not null;

create unique index if not exists message_logs_sent_automation_contact_channel_unique
  on invitation.message_logs (automation_id, contact_id, channel)
  where automation_id is not null and status = 'sent';

create index if not exists contacts_active_sms_idx
  on invitation.contacts (active, sms_enabled)
  where phone is not null;
