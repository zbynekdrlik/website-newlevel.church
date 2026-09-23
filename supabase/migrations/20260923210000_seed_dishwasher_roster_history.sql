-- Seed the historical roster supplied when the dishwasher tool was introduced.
-- Fixed IDs keep the import idempotent and allow both people named Lucia to
-- remain separate until staff can replace their labels with full names.
insert into invitation.dishwasher_members (id, name, active)
values
  ('da100000-0000-4000-8000-000000000001', 'Simonka', true),
  ('da100000-0000-4000-8000-000000000002', 'Judit', true),
  ('da100000-0000-4000-8000-000000000003', 'Gabika', true),
  ('da100000-0000-4000-8000-000000000004', 'Anka', true),
  ('da100000-0000-4000-8000-000000000005', 'Lucia', true),
  ('da100000-0000-4000-8000-000000000006', 'Lucia', true),
  ('da100000-0000-4000-8000-000000000007', 'Lili', true),
  ('da100000-0000-4000-8000-000000000008', 'Efko', true),
  ('da100000-0000-4000-8000-000000000009', 'Katka', true),
  ('da100000-0000-4000-8000-000000000010', 'Patrika', true)
on conflict (id) do update
set name = excluded.name,
    active = excluded.active;

insert into invitation.dishwasher_shifts (service_date)
values
  ('2026-08-16'),
  ('2026-08-20'),
  ('2026-08-23'),
  ('2026-08-27'),
  ('2026-08-30'),
  ('2026-09-03'),
  ('2026-09-06'),
  ('2026-09-10'),
  ('2026-09-13'),
  ('2026-09-17'),
  ('2026-09-20')
on conflict (service_date) do nothing;

with roster(service_date, position, member_id) as (
  values
    ('2026-08-16'::date, 1, 'da100000-0000-4000-8000-000000000001'::uuid),
    ('2026-08-16'::date, 2, 'da100000-0000-4000-8000-000000000002'::uuid),
    ('2026-08-20'::date, 1, 'da100000-0000-4000-8000-000000000003'::uuid),
    ('2026-08-20'::date, 2, 'da100000-0000-4000-8000-000000000004'::uuid),
    ('2026-08-23'::date, 1, 'da100000-0000-4000-8000-000000000005'::uuid),
    ('2026-08-23'::date, 2, 'da100000-0000-4000-8000-000000000006'::uuid),
    ('2026-08-27'::date, 1, 'da100000-0000-4000-8000-000000000007'::uuid),
    ('2026-08-27'::date, 2, 'da100000-0000-4000-8000-000000000008'::uuid),
    ('2026-08-30'::date, 1, 'da100000-0000-4000-8000-000000000009'::uuid),
    ('2026-08-30'::date, 2, 'da100000-0000-4000-8000-000000000002'::uuid),
    ('2026-09-03'::date, 1, 'da100000-0000-4000-8000-000000000001'::uuid),
    ('2026-09-03'::date, 2, 'da100000-0000-4000-8000-000000000003'::uuid),
    ('2026-09-06'::date, 1, 'da100000-0000-4000-8000-000000000004'::uuid),
    ('2026-09-06'::date, 2, 'da100000-0000-4000-8000-000000000010'::uuid),
    ('2026-09-10'::date, 1, 'da100000-0000-4000-8000-000000000005'::uuid),
    ('2026-09-10'::date, 2, 'da100000-0000-4000-8000-000000000006'::uuid),
    ('2026-09-13'::date, 1, 'da100000-0000-4000-8000-000000000009'::uuid),
    ('2026-09-13'::date, 2, 'da100000-0000-4000-8000-000000000001'::uuid),
    ('2026-09-17'::date, 1, 'da100000-0000-4000-8000-000000000003'::uuid),
    ('2026-09-17'::date, 2, 'da100000-0000-4000-8000-000000000007'::uuid),
    ('2026-09-20'::date, 1, 'da100000-0000-4000-8000-000000000004'::uuid),
    ('2026-09-20'::date, 2, 'da100000-0000-4000-8000-000000000002'::uuid)
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
