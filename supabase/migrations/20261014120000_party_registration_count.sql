create or replace function public.get_party_registration_count(
  p_event_date date
)
returns integer
language sql
stable
security definer
set search_path = invitation, public
as $$
  select count(*)::integer
  from invitation.party_registrations registration
  join invitation.party_events event
    on event.id = registration.event_id
  where event.event_date = p_event_date;
$$;

revoke all on function public.get_party_registration_count(date)
  from public, anon, authenticated;
grant execute on function public.get_party_registration_count(date)
  to service_role;
