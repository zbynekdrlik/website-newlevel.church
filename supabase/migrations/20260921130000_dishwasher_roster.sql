create table if not exists invitation.dishwasher_members (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  email text,
  discord_user_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists dishwasher_members_email_unique
  on invitation.dishwasher_members (lower(email))
  where email is not null;

create unique index if not exists dishwasher_members_discord_user_id_unique
  on invitation.dishwasher_members (discord_user_id)
  where discord_user_id is not null;

create table if not exists invitation.dishwasher_shifts (
  id uuid primary key default gen_random_uuid(),
  service_date date not null unique,
  discord_channel_id text,
  discord_message_id text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (extract(isodow from service_date) in (4, 7))
);

create table if not exists invitation.dishwasher_availability (
  member_id uuid not null references invitation.dishwasher_members(id) on delete cascade,
  service_date date not null,
  available boolean not null,
  note text check (note is null or char_length(note) <= 300),
  updated_at timestamptz not null default now(),
  primary key (member_id, service_date)
);

create table if not exists invitation.dishwasher_assignments (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references invitation.dishwasher_shifts(id) on delete cascade,
  member_id uuid not null references invitation.dishwasher_members(id) on delete restrict,
  position smallint not null check (position in (1, 2)),
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'declined', 'replaced')),
  source text not null default 'automatic'
    check (source in ('automatic', 'manual', 'discord')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists dishwasher_assignments_active_position_unique
  on invitation.dishwasher_assignments (shift_id, position)
  where status in ('pending', 'confirmed');

create unique index if not exists dishwasher_assignments_active_member_unique
  on invitation.dishwasher_assignments (shift_id, member_id)
  where status in ('pending', 'confirmed');

drop trigger if exists set_dishwasher_members_updated_at on invitation.dishwasher_members;
create trigger set_dishwasher_members_updated_at
before update on invitation.dishwasher_members
for each row execute function invitation.set_updated_at();

drop trigger if exists set_dishwasher_shifts_updated_at on invitation.dishwasher_shifts;
create trigger set_dishwasher_shifts_updated_at
before update on invitation.dishwasher_shifts
for each row execute function invitation.set_updated_at();

drop trigger if exists set_dishwasher_assignments_updated_at on invitation.dishwasher_assignments;
create trigger set_dishwasher_assignments_updated_at
before update on invitation.dishwasher_assignments
for each row execute function invitation.set_updated_at();

alter table invitation.dishwasher_members enable row level security;
alter table invitation.dishwasher_shifts enable row level security;
alter table invitation.dishwasher_availability enable row level security;
alter table invitation.dishwasher_assignments enable row level security;

revoke all on invitation.dishwasher_members from public, anon, authenticated;
revoke all on invitation.dishwasher_shifts from public, anon, authenticated;
revoke all on invitation.dishwasher_availability from public, anon, authenticated;
revoke all on invitation.dishwasher_assignments from public, anon, authenticated;

grant all on invitation.dishwasher_members to service_role;
grant all on invitation.dishwasher_shifts to service_role;
grant all on invitation.dishwasher_availability to service_role;
grant all on invitation.dishwasher_assignments to service_role;
