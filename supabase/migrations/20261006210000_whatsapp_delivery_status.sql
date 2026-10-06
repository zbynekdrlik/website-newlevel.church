alter table invitation.message_queue
  add column if not exists provider_delivery_status text
    check (provider_delivery_status in ('sent', 'delivered', 'read', 'failed')),
  add column if not exists provider_delivery_at timestamptz,
  add column if not exists provider_delivery_error_code text,
  add column if not exists provider_delivery_error text;

create index if not exists message_queue_meta_provider_message_id_idx
  on invitation.message_queue (provider_message_id)
  where provider = 'meta-whatsapp' and provider_message_id is not null;

create table if not exists invitation.whatsapp_delivery_events (
  provider_message_id text not null,
  status text not null check (status in ('sent', 'delivered', 'read', 'failed')),
  occurred_at timestamptz not null,
  error_code text,
  error_message text,
  received_at timestamptz not null default now(),
  primary key (provider_message_id, status, occurred_at)
);

alter table invitation.whatsapp_delivery_events enable row level security;
revoke all on invitation.whatsapp_delivery_events from anon, authenticated;
grant all on invitation.whatsapp_delivery_events to service_role;

create or replace function invitation.apply_pending_whatsapp_delivery()
returns trigger
language plpgsql
security definer
set search_path = invitation, pg_temp
as $$
declare
  v_event invitation.whatsapp_delivery_events%rowtype;
begin
  if new.provider = 'meta-whatsapp' and new.provider_message_id is not null then
    select * into v_event
    from invitation.whatsapp_delivery_events
    where provider_message_id = new.provider_message_id
    order by occurred_at desc,
      case status
        when 'read' then 4
        when 'failed' then 3
        when 'delivered' then 2
        else 1
      end desc
    limit 1;

    if found then
      update invitation.message_queue
      set
        provider_delivery_status = v_event.status,
        provider_delivery_at = v_event.occurred_at,
        provider_delivery_error_code = v_event.error_code,
        provider_delivery_error = v_event.error_message
      where id = new.id;

      delete from invitation.whatsapp_delivery_events
      where provider_message_id = new.provider_message_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists apply_pending_whatsapp_delivery
  on invitation.message_queue;
create trigger apply_pending_whatsapp_delivery
after update of provider_message_id on invitation.message_queue
for each row
when (new.provider_message_id is not null)
execute function invitation.apply_pending_whatsapp_delivery();
revoke all on function invitation.apply_pending_whatsapp_delivery()
  from public, anon, authenticated;

create or replace function invitation.record_whatsapp_delivery(
  p_provider_message_id text,
  p_status text,
  p_status_at timestamptz,
  p_error_code text default null,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = invitation, pg_temp
as $$
declare
  v_status_at timestamptz := coalesce(p_status_at, now());
  v_updated boolean;
  v_message_exists boolean := false;
begin
  if p_provider_message_id is null or length(p_provider_message_id) > 255
     or p_status not in ('sent', 'delivered', 'read', 'failed') then
    raise exception 'Invalid WhatsApp delivery status';
  end if;

  insert into invitation.whatsapp_delivery_events (
    provider_message_id, status, occurred_at, error_code, error_message
  ) values (
    p_provider_message_id,
    p_status,
    v_status_at,
    nullif(left(p_error_code, 80), ''),
    nullif(left(p_error_message, 1000), '')
  )
  on conflict (provider_message_id, status, occurred_at) do update
  set
    error_code = excluded.error_code,
    error_message = excluded.error_message;

  update invitation.message_queue as message
  set
    provider_delivery_status = p_status,
    provider_delivery_at = v_status_at,
    provider_delivery_error_code = nullif(left(p_error_code, 80), ''),
    provider_delivery_error = nullif(left(p_error_message, 1000), '')
  where message.provider = 'meta-whatsapp'
    and message.provider_message_id = p_provider_message_id
    and (
      message.provider_delivery_at is null
      or v_status_at > message.provider_delivery_at
      or (
        v_status_at = message.provider_delivery_at
        and case p_status
          when 'read' then 4
          when 'failed' then 3
          when 'delivered' then 2
          else 1
        end >= case message.provider_delivery_status
          when 'read' then 4
          when 'failed' then 3
          when 'delivered' then 2
          else 1
        end
    )
    );

  v_updated := found;
  if not v_updated then
    select exists (
      select 1
      from invitation.message_queue
      where provider = 'meta-whatsapp'
        and provider_message_id = p_provider_message_id
    ) into v_message_exists;
  end if;

  if v_updated or v_message_exists then
    delete from invitation.whatsapp_delivery_events
    where provider_message_id = p_provider_message_id;
  end if;

  return v_updated;
end;
$$;

revoke all on function invitation.record_whatsapp_delivery(
  text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function invitation.record_whatsapp_delivery(
  text, text, timestamptz, text, text
) to service_role;
