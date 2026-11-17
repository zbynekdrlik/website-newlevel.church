create table invitation.site_events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  starts_at timestamptz not null,
  registration_closes_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  created_at timestamptz not null default now()
);

insert into invitation.site_events (slug, title, starts_at, registration_closes_at)
values (
  'chlapsky-vecer-2026-11-20',
  'Chlapský večer SNV',
  timestamp '2026-11-20 18:00' at time zone 'Europe/Bratislava',
  timestamp '2026-11-21 00:00' at time zone 'Europe/Bratislava'
);

create table invitation.site_event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references invitation.site_events(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  email text not null check (length(email) <= 254 and email = lower(trim(email))),
  phone text not null check (length(trim(phone)) between 7 and 32),
  wants_food boolean not null,
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, email)
);

create table invitation.site_event_discord_notifications (
  registration_id uuid primary key references invitation.site_event_registrations(id) on delete cascade,
  generation integer not null default 1,
  status text not null default 'queued' check (status in ('queued', 'processing', 'sent')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create index site_event_discord_notifications_due
  on invitation.site_event_discord_notifications (next_attempt_at, registration_id)
  where status = 'queued';

alter table invitation.site_events enable row level security;
alter table invitation.site_event_registrations enable row level security;
alter table invitation.site_event_discord_notifications enable row level security;
revoke all on invitation.site_events from public, anon, authenticated;
revoke all on invitation.site_event_registrations from public, anon, authenticated;
revoke all on invitation.site_event_discord_notifications from public, anon, authenticated;
grant all on invitation.site_events to service_role;
grant all on invitation.site_event_registrations to service_role;
grant all on invitation.site_event_discord_notifications to service_role;

create function invitation.queue_site_event_discord_notification()
returns trigger
language plpgsql
security definer
set search_path = invitation, pg_temp
as $$
begin
  insert into invitation.site_event_discord_notifications (registration_id)
  values (new.id)
  on conflict (registration_id) do update
  set generation = invitation.site_event_discord_notifications.generation + 1,
      status = 'queued',
      attempts = 0,
      next_attempt_at = now(),
      claimed_at = null,
      sent_at = null,
      last_error = null,
      updated_at = now();
  return new;
end;
$$;

revoke all on function invitation.queue_site_event_discord_notification()
  from public, anon, authenticated;

create trigger queue_site_event_discord_notification_on_insert
after insert on invitation.site_event_registrations
for each row execute function invitation.queue_site_event_discord_notification();

create trigger queue_site_event_discord_notification_on_change
after update of name, phone, wants_food on invitation.site_event_registrations
for each row
when (
  old.name is distinct from new.name
  or old.phone is distinct from new.phone
  or old.wants_food is distinct from new.wants_food
)
execute function invitation.queue_site_event_discord_notification();

create function invitation.claim_site_event_discord_notifications(
  p_limit integer default 20,
  p_registration_id uuid default null
)
returns setof invitation.site_event_discord_notifications
language plpgsql
security definer
set search_path = invitation, pg_temp
as $$
begin
  return query
  with candidates as (
    select queued.registration_id
    from invitation.site_event_discord_notifications queued
    where (
      (queued.status = 'queued' and queued.next_attempt_at <= now())
      or (queued.status = 'processing' and queued.claimed_at < now() - interval '2 minutes')
    )
      and (p_registration_id is null or queued.registration_id = p_registration_id)
    order by queued.next_attempt_at, queued.registration_id
    for update skip locked
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  )
  update invitation.site_event_discord_notifications claimed
  set status = 'processing',
      attempts = claimed.attempts + 1,
      claimed_at = now(),
      updated_at = now()
  from candidates
  where claimed.registration_id = candidates.registration_id
  returning claimed.*;
end;
$$;

revoke all on function invitation.claim_site_event_discord_notifications(integer, uuid)
  from public, anon, authenticated;
grant execute on function invitation.claim_site_event_discord_notifications(integer, uuid)
  to service_role;
