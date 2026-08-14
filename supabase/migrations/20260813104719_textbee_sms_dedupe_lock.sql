create unique index if not exists message_logs_automation_contact_channel_unique
  on invitation.message_logs (automation_id, contact_id, channel)
  where automation_id is not null;
