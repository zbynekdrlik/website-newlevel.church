create table invitation.party_discord_notifications (
  registration_id uuid primary key references invitation.party_registrations(id) on delete cascade,
  generation integer not null default 1,
  status text not null default 'queued' check (status in ('queued', 'processing', 'sent')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create index party_discord_notifications_due
  on invitation.party_discord_notifications (next_attempt_at, registration_id)
  where status = 'queued';

alter table invitation.party_discord_notifications enable row level security;
revoke all on invitation.party_discord_notifications from public, anon, authenticated;
grant all on invitation.party_discord_notifications to service_role;

create function invitation.queue_party_discord_notification()
returns trigger
language plpgsql
security definer
set search_path = invitation, pg_temp
as $$
begin
  insert into invitation.party_discord_notifications (registration_id)
  values (new.id)
  on conflict (registration_id) do update
  set generation = invitation.party_discord_notifications.generation + 1,
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

create trigger queue_party_discord_notification
after insert or update of registered_at on invitation.party_registrations
for each row execute function invitation.queue_party_discord_notification();

create function invitation.claim_party_discord_notifications(
  p_limit integer default 20,
  p_registration_id uuid default null
)
returns setof invitation.party_discord_notifications
language plpgsql
security definer
set search_path = invitation, pg_temp
as $$
begin
  return query
  with candidates as (
    select queued.registration_id
    from invitation.party_discord_notifications queued
    where (
      (queued.status = 'queued' and queued.next_attempt_at <= now())
      or (queued.status = 'processing' and queued.claimed_at < now() - interval '2 minutes')
    )
      and (p_registration_id is null or queued.registration_id = p_registration_id)
    order by queued.next_attempt_at, queued.registration_id
    for update skip locked
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  )
  update invitation.party_discord_notifications claimed
  set status = 'processing',
      attempts = claimed.attempts + 1,
      claimed_at = now(),
      updated_at = now()
  from candidates
  where claimed.registration_id = candidates.registration_id
  returning claimed.*;
end;
$$;

revoke all on function invitation.claim_party_discord_notifications(integer, uuid)
  from public, anon, authenticated;
grant execute on function invitation.claim_party_discord_notifications(integer, uuid)
  to service_role;
