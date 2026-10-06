insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'email-campaign-images',
  'email-campaign-images',
  false,
  900000,
  array['image/jpeg']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on column invitation.message_queue.template_parameters is
  'WhatsApp body template parameters, or an email attachment reference when channel=email.';
