alter table invitation.dishwasher_assignments
  drop constraint if exists dishwasher_assignments_source_check;

alter table invitation.dishwasher_assignments
  add constraint dishwasher_assignments_source_check
  check (source in ('automatic', 'manual', 'discord', 'portal'));
