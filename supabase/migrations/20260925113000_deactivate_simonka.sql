update invitation.dishwasher_members
set active = false
where id = 'da100000-0000-4000-8000-000000000001';

update invitation.dishwasher_assignments
set status = 'replaced'
where member_id = 'da100000-0000-4000-8000-000000000001'
  and status in ('pending', 'confirmed')
  and shift_id in (
    select id
    from invitation.dishwasher_shifts
    where service_date >= '2026-09-25'
  );
