create table if not exists invitation.sms_campaigns (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references invitation.party_events(id) on delete cascade,
  automation_id text not null unique,
  audience_type text not null
    check (audience_type in (
      'all_with_phone',
      'registered_for_event',
      'not_registered_for_event',
      'previously_registered_not_registered'
    )),
  sender text not null default 'NewLevel',
  message text not null,
  scheduled_for timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued', 'dispatching', 'sent', 'partial', 'failed', 'cancelled')),
  queued_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_sms_campaigns_updated_at on invitation.sms_campaigns;
create trigger set_sms_campaigns_updated_at
before update on invitation.sms_campaigns
for each row execute function invitation.set_updated_at();

alter table invitation.sms_campaigns enable row level security;

revoke all on invitation.sms_campaigns from anon, authenticated;
grant all on invitation.sms_campaigns to service_role;

create index if not exists sms_campaigns_due_idx
  on invitation.sms_campaigns (scheduled_for)
  where status = 'queued';
