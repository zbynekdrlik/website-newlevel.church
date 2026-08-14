create extension if not exists pgcrypto;

create schema if not exists invitation;

revoke all on schema invitation from public;
revoke all on schema invitation from anon;
revoke all on schema invitation from authenticated;
grant usage on schema invitation to service_role;

create or replace function invitation.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists invitation.contacts (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  phone text,
  source text not null default 'manual',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);

create unique index if not exists contacts_email_unique
  on invitation.contacts (email)
  where email is not null;

create unique index if not exists contacts_phone_unique
  on invitation.contacts (phone)
  where phone is not null;

create table if not exists invitation.invitations (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  event_starts_at timestamptz,
  location text,
  status text not null default 'draft'
    check (status in ('draft', 'open', 'closed', 'cancelled')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invitation.invitation_recipients (
  id uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references invitation.invitations(id) on delete cascade,
  contact_id uuid not null references invitation.contacts(id) on delete cascade,
  token_hash text unique,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'opened', 'responded', 'unsubscribed', 'cancelled')),
  invited_at timestamptz,
  opened_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invitation_id, contact_id)
);

create table if not exists invitation.message_logs (
  id bigint generated always as identity primary key,
  invitation_recipient_id uuid references invitation.invitation_recipients(id) on delete set null,
  contact_id uuid references invitation.contacts(id) on delete set null,
  channel text not null check (channel in ('email', 'sms', 'other')),
  provider text,
  status text not null check (status in ('queued', 'sent', 'failed', 'skipped')),
  provider_message_id text,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists invitation.import_batches (
  id uuid primary key default gen_random_uuid(),
  source text,
  imported_by uuid,
  imported_by_email text,
  contact_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists invitation.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_email text,
  action text not null,
  target_table text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

drop trigger if exists set_contacts_updated_at on invitation.contacts;
create trigger set_contacts_updated_at
before update on invitation.contacts
for each row execute function invitation.set_updated_at();

drop trigger if exists set_invitations_updated_at on invitation.invitations;
create trigger set_invitations_updated_at
before update on invitation.invitations
for each row execute function invitation.set_updated_at();

drop trigger if exists set_invitation_recipients_updated_at on invitation.invitation_recipients;
create trigger set_invitation_recipients_updated_at
before update on invitation.invitation_recipients
for each row execute function invitation.set_updated_at();

alter table invitation.contacts enable row level security;
alter table invitation.invitations enable row level security;
alter table invitation.invitation_recipients enable row level security;
alter table invitation.message_logs enable row level security;
alter table invitation.import_batches enable row level security;
alter table invitation.audit_log enable row level security;

revoke all on all tables in schema invitation from anon;
revoke all on all tables in schema invitation from authenticated;
revoke all on all routines in schema invitation from anon;
revoke all on all routines in schema invitation from authenticated;

grant all on all tables in schema invitation to service_role;
grant all on all routines in schema invitation to service_role;
grant usage, select on all sequences in schema invitation to service_role;
