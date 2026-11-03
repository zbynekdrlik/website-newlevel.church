-- Scope recovery to active Bufet members in the shared Auth project and
-- throttle anonymous requests for each member to one per minute.
alter table buffet.members add column password_reset_requested_at timestamptz;

create function buffet.claim_password_reset(p_email text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid;
begin
  select m.user_id into v_user_id
  from auth.users u
  join buffet.members m on m.user_id = u.id
  where lower(u.email) = lower(trim(p_email)) and m.active
  for update of m;
  if not found then return false; end if;

  update buffet.members
  set password_reset_requested_at = now()
  where user_id = v_user_id
    and (password_reset_requested_at is null
      or password_reset_requested_at <= now() - interval '1 minute');
  return found;
end;
$$;

create function public.buffet_claim_password_reset(p_email text) returns boolean
language sql security invoker set search_path = '' as $$
  select buffet.claim_password_reset(p_email);
$$;

revoke execute on function buffet.claim_password_reset(text) from public, anon, authenticated;
revoke execute on function public.buffet_claim_password_reset(text) from public, anon, authenticated;
grant execute on function buffet.claim_password_reset(text) to service_role;
grant execute on function public.buffet_claim_password_reset(text) to service_role;

-- Auth can resend an expired email invitation to an unconfirmed account.
-- Consuming a fresh Bufet invitation for that same active seller keeps the
-- original member row and its sale history intact.
create or replace function buffet.redeem_member_invitation(
  p_token text,
  p_display_name text,
  p_user_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_invitation_id uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Pozvánka nie je platná alebo už bola použitá.';
  end if;
  if char_length(trim(coalesce(p_display_name, ''))) not between 1 and 80
      or p_display_name ~ '[[:cntrl:]]' then
    raise exception 'Meno musí mať 1 až 80 znakov.';
  end if;
  if p_user_id is null
      or not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Používateľ neexistuje.';
  end if;

  select id into v_invitation_id
  from buffet.member_invitations
  where token_hash = sha256(convert_to(p_token, 'UTF8'))
    and used_at is null
    and expires_at > now()
  for update;
  if not found then
    raise exception 'Pozvánka nie je platná alebo už bola použitá.';
  end if;

  if exists (select 1 from buffet.members where user_id = p_user_id) then
    if not exists (
      select 1 from buffet.members
      where user_id = p_user_id and active and role = 'seller'
    ) then
      raise exception 'Prístup člena nie je aktívny.';
    end if;
  else
    insert into buffet.members (user_id, display_name, role, active)
    values (p_user_id, trim(p_display_name), 'seller', true);
  end if;

  update buffet.member_invitations
  set used_at = now(), used_by = p_user_id
  where id = v_invitation_id;
end;
$$;
