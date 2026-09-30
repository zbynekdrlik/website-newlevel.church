create or replace function invitation.claim_due_messages(
  p_limit integer default 20,
  p_automation_id text default null
)
returns setof invitation.message_queue
language plpgsql
security definer
set search_path = invitation, pg_temp
as $$
begin
  return query
  with candidates as (
    select queued.id
    from invitation.message_queue as queued
    where queued.status = 'queued'
      and queued.scheduled_for <= now()
      and (
        p_automation_id is null
        or queued.automation_id = p_automation_id
      )
    order by queued.created_at asc, queued.id asc
    for update skip locked
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  )
  update invitation.message_queue as claimed
  set
    status = 'processing',
    attempts = claimed.attempts + 1
  from candidates
  where claimed.id = candidates.id
  returning claimed.*;
end;
$$;

revoke all on function invitation.claim_due_messages(integer, text)
  from public, anon, authenticated;
grant execute on function invitation.claim_due_messages(integer, text)
  to service_role;

comment on function invitation.claim_due_messages(integer, text) is
  'Atomically claims due queue rows so concurrent dispatchers cannot send the same message.';
