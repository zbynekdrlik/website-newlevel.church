insert into invitation.dishwasher_members (
  id,
  name,
  discord_user_id,
  active
)
values
  (
    'da100000-0000-4000-8000-000000000011',
    'Janka',
    '1238785348453273641',
    true
  ),
  (
    'da100000-0000-4000-8000-000000000012',
    'Kristína',
    '1130075457879015475',
    true
  )
on conflict (id) do update
set name = excluded.name,
    discord_user_id = excluded.discord_user_id,
    active = true;

-- The roster now has one person per service. Future pending assignments are
-- rebuilt after this migration; completed history remains unchanged.
update invitation.dishwasher_assignments as assignment
set status = 'replaced',
    responded_at = now()
where assignment.status in ('pending', 'confirmed')
  and exists (
    select 1
    from invitation.dishwasher_shifts as shift
    where shift.id = assignment.shift_id
      and shift.service_date >= current_date
  );
