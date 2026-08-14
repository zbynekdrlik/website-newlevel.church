alter table invitation.contacts
  add column if not exists email_enabled boolean not null default true;

create index if not exists contacts_active_email_idx
  on invitation.contacts (email)
  where active = true and email is not null and email_enabled = true;

drop index if exists invitation.message_queue_one_per_contact_event_channel;
