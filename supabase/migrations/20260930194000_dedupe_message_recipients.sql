alter table invitation.message_queue
  add column if not exists recipient_dedupe_key text;

create unique index if not exists message_queue_recipient_dedupe_key_unique
  on invitation.message_queue (recipient_dedupe_key)
  where recipient_dedupe_key is not null;

create or replace function invitation.set_message_queue_recipient_dedupe_key()
returns trigger
language plpgsql
set search_path = invitation, pg_temp
as $$
begin
  new.recipient_dedupe_key := case
    when new.automation_id is null then null
    else concat(
      new.automation_id,
      '|',
      lower(new.channel),
      '|',
      lower(btrim(new.recipient))
    )
  end;
  return new;
end;
$$;

drop trigger if exists set_message_queue_recipient_dedupe_key
  on invitation.message_queue;
create trigger set_message_queue_recipient_dedupe_key
before insert or update of automation_id, channel, recipient
on invitation.message_queue
for each row execute function invitation.set_message_queue_recipient_dedupe_key();

comment on column invitation.message_queue.recipient_dedupe_key is
  'Prevents one automation from sending the same channel to the same normalized recipient more than once, even when multiple contacts share that destination.';
