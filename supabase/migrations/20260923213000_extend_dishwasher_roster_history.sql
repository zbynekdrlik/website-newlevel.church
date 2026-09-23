insert into invitation.dishwasher_shifts (service_date)
values
  ('2026-08-09'),
  ('2026-08-13')
on conflict (service_date) do nothing;

with roster(service_date, position, member_id) as (
  values
    ('2026-08-09'::date, 1, 'da100000-0000-4000-8000-000000000003'::uuid),
    ('2026-08-09'::date, 2, 'da100000-0000-4000-8000-000000000004'::uuid),
    ('2026-08-13'::date, 1, 'da100000-0000-4000-8000-000000000007'::uuid),
    ('2026-08-13'::date, 2, 'da100000-0000-4000-8000-000000000009'::uuid)
)
insert into invitation.dishwasher_assignments (
  shift_id,
  member_id,
  position,
  status,
  source,
  responded_at
)
select
  shift.id,
  roster.member_id,
  roster.position,
  'confirmed',
  'manual',
  now()
from roster
join invitation.dishwasher_shifts as shift
  on shift.service_date = roster.service_date
on conflict do nothing;
