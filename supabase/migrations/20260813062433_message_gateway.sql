create table if not exists invitation.party_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null unique,
  title text not null default 'New Level Party',
  starts_at timestamptz,
  registration_deadline timestamptz,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'open', 'closed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invitation.party_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references invitation.party_events(id) on delete cascade,
  contact_id uuid not null references invitation.contacts(id) on delete cascade,
  wants_food boolean not null default false,
  message text,
  source text not null default 'website',
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, contact_id)
);

create table if not exists invitation.message_batches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references invitation.party_events(id) on delete cascade,
  kind text not null default 'party_invitation'
    check (kind in ('party_invitation', 'party_reminder', 'custom')),
  channel_strategy text not null default 'whatsapp_then_email'
    check (channel_strategy in ('whatsapp_then_email', 'email_only', 'whatsapp_only')),
  status text not null default 'queued'
    check (status in ('queued', 'dispatching', 'sent', 'partial', 'failed', 'cancelled')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invitation.message_queue (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references invitation.message_batches(id) on delete cascade,
  event_id uuid references invitation.party_events(id) on delete cascade,
  contact_id uuid not null references invitation.contacts(id) on delete cascade,
  channel text not null check (channel in ('whatsapp', 'email')),
  recipient text not null,
  subject text,
  body text not null,
  template_name text,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'sent', 'failed', 'skipped', 'cancelled')),
  provider text,
  provider_message_id text,
  attempts integer not null default 0,
  last_error text,
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists message_queue_one_per_contact_event_channel
  on invitation.message_queue (event_id, contact_id, channel)
  where event_id is not null;

drop trigger if exists set_party_events_updated_at on invitation.party_events;
create trigger set_party_events_updated_at
before update on invitation.party_events
for each row execute function invitation.set_updated_at();

drop trigger if exists set_party_registrations_updated_at on invitation.party_registrations;
create trigger set_party_registrations_updated_at
before update on invitation.party_registrations
for each row execute function invitation.set_updated_at();

drop trigger if exists set_message_batches_updated_at on invitation.message_batches;
create trigger set_message_batches_updated_at
before update on invitation.message_batches
for each row execute function invitation.set_updated_at();

drop trigger if exists set_message_queue_updated_at on invitation.message_queue;
create trigger set_message_queue_updated_at
before update on invitation.message_queue
for each row execute function invitation.set_updated_at();

alter table invitation.party_events enable row level security;
alter table invitation.party_registrations enable row level security;
alter table invitation.message_batches enable row level security;
alter table invitation.message_queue enable row level security;

revoke all on invitation.party_events from anon, authenticated;
revoke all on invitation.party_registrations from anon, authenticated;
revoke all on invitation.message_batches from anon, authenticated;
revoke all on invitation.message_queue from anon, authenticated;

grant all on invitation.party_events to service_role;
grant all on invitation.party_registrations to service_role;
grant all on invitation.message_batches to service_role;
grant all on invitation.message_queue to service_role;

create or replace function public.upsert_party_registration(
  p_event_date date,
  p_name text,
  p_email text,
  p_phone text,
  p_wants_food boolean default false,
  p_message text default null,
  p_source text default 'website'
)
returns uuid
language plpgsql
security definer
set search_path = invitation, public
as $$
declare
  v_event_id uuid;
  v_contact_id uuid;
  v_registration_id uuid;
begin
  if p_event_date is null then
    raise exception 'event_date is required' using errcode = '22023';
  end if;

  insert into invitation.party_events (
    event_date,
    title,
    starts_at,
    registration_deadline,
    status
  )
  values (
    p_event_date,
    'New Level Party',
    (p_event_date::timestamp + time '16:00') at time zone 'Europe/Bratislava',
    ((p_event_date - 2)::timestamp + time '20:00') at time zone 'Europe/Bratislava',
    'open'
  )
  on conflict (event_date) do update
  set updated_at = now()
  returning id into v_event_id;

  v_contact_id := public.register_invitation_contact(
    p_name,
    p_email,
    p_phone,
    coalesce(nullif(trim(p_source), ''), 'website')
  );

  insert into invitation.party_registrations (
    event_id,
    contact_id,
    wants_food,
    message,
    source
  )
  values (
    v_event_id,
    v_contact_id,
    coalesce(p_wants_food, false),
    nullif(trim(p_message), ''),
    coalesce(nullif(trim(p_source), ''), 'website')
  )
  on conflict (event_id, contact_id) do update
  set
    wants_food = excluded.wants_food,
    message = excluded.message,
    source = excluded.source,
    registered_at = now(),
    updated_at = now()
  returning id into v_registration_id;

  return v_registration_id;
end;
$$;

revoke all on function public.upsert_party_registration(date, text, text, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_party_registration(date, text, text, text, boolean, text, text)
  to service_role;
