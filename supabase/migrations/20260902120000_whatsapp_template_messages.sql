alter table invitation.message_queue
  add column if not exists template_language text,
  add column if not exists template_parameters jsonb not null default '[]'::jsonb;

comment on column invitation.message_queue.template_language is
  'Meta WhatsApp template language code, for example sk. Null for non-template messages.';

comment on column invitation.message_queue.template_parameters is
  'Ordered WhatsApp body template parameters. Empty for non-template messages.';
