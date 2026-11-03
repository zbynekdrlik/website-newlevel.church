-- Invitation creation can be delegated without granting access to the member list
-- or to member administration. Existing and future sellers default to no access.
alter table buffet.members
  add column can_invite_members boolean not null default false;

create or replace function buffet.has_permission(p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from buffet.members m
    where m.user_id = auth.uid() and m.active
      and p_permission in ('sell', 'manage_meetings', 'restock', 'manage_products', 'invite_members')
      and (m.role = 'admin' or case p_permission
        when 'sell' then m.can_sell
        when 'manage_meetings' then m.can_manage_meetings
        when 'restock' then m.can_restock
        when 'manage_products' then m.can_manage_products
        when 'invite_members' then m.can_invite_members
        else false end)
  );
$$;

create or replace function buffet.create_member_invitation() returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  perform buffet.require_permission('invite_members');
  v_token := replace(gen_random_uuid()::text, '-', '')
    || replace(gen_random_uuid()::text, '-', '');
  insert into buffet.member_invitations (
    token_hash, created_by, expires_at
  ) values (
    sha256(convert_to(v_token, 'UTF8')),
    auth.uid(),
    now() + interval '7 days'
  );
  return v_token;
end;
$$;

-- Keep the existing five-argument RPC for older clients: it remains admin-only
-- and preserves the new grant. The editor uses this six-argument overload.
create function buffet.set_member_permissions(
  p_user_id uuid,
  p_can_sell boolean,
  p_can_manage_meetings boolean,
  p_can_restock boolean,
  p_can_manage_products boolean,
  p_can_invite_members boolean
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform buffet.require_admin();
  if p_can_invite_members is null then
    raise exception 'Skontrolujte člena a oprávnenia.';
  end if;
  perform buffet.set_member_permissions(
    p_user_id, p_can_sell, p_can_manage_meetings, p_can_restock, p_can_manage_products
  );
  update buffet.members set can_invite_members = p_can_invite_members
  where user_id = p_user_id and role = 'seller';
end;
$$;

create function public.buffet_set_member_permissions(
  p_user_id uuid,
  p_can_sell boolean,
  p_can_manage_meetings boolean,
  p_can_restock boolean,
  p_can_manage_products boolean,
  p_can_invite_members boolean
) returns void
language sql security invoker set search_path = '' as $$
  select buffet.set_member_permissions(
    p_user_id, p_can_sell, p_can_manage_meetings, p_can_restock,
    p_can_manage_products, p_can_invite_members
  );
$$;

revoke execute on function buffet.set_member_permissions(uuid, boolean, boolean, boolean, boolean, boolean)
  from public, anon, authenticated;
revoke execute on function public.buffet_set_member_permissions(uuid, boolean, boolean, boolean, boolean, boolean)
  from public, anon, authenticated;
grant execute on function buffet.set_member_permissions(uuid, boolean, boolean, boolean, boolean, boolean)
  to authenticated;
grant execute on function public.buffet_set_member_permissions(uuid, boolean, boolean, boolean, boolean, boolean)
  to authenticated;
