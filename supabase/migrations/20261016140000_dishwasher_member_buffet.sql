alter table invitation.dishwasher_members
  add column if not exists also_buffet boolean not null default false;
