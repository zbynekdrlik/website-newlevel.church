-- One-time links let a Buffet admin enroll a seller without sharing passwords.
-- Raw invitation tokens are returned once and only their SHA-256 hashes are stored.
alter table buffet.members
  add column active boolean not null default true;

create table buffet.member_invitations (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  created_by uuid not null references buffet.members(user_id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references buffet.members(user_id) on delete set null,
  check (expires_at > created_at),
  check ((used_at is null and used_by is null) or used_at is not null)
);
create index member_invitations_pending
  on buffet.member_invitations (expires_at)
  where used_at is null;
alter table buffet.member_invitations enable row level security;
revoke all on buffet.member_invitations from public, anon, authenticated;
grant usage on schema buffet to service_role;

create or replace function buffet.require_member() returns text
language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  select role into v_role
  from buffet.members
  where user_id = auth.uid() and active;
  if v_role is null then
    raise exception 'Prístup do Buffetu nie je povolený.';
  end if;
  return v_role;
end;
$$;

create or replace function buffet.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from buffet.members where user_id = auth.uid() and active
  );
$$;

create function buffet.create_member_invitation() returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  perform buffet.require_admin();
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

create function buffet.admin_members() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform buffet.require_admin();
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'user_id', user_id,
        'display_name', display_name,
        'role', role,
        'active', active,
        'created_at', created_at
      ) order by active desc, lower(display_name)
    )
    from buffet.members
  ), '[]'::jsonb);
end;
$$;

create function buffet.set_member_active(
  p_user_id uuid,
  p_active boolean
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform buffet.require_admin();
  if p_user_id is null or p_active is null then
    raise exception 'Skontrolujte člena a stav prístupu.';
  end if;
  if p_user_id = auth.uid() and not p_active then
    raise exception 'Nemôžete deaktivovať vlastný účet.';
  end if;
  update buffet.members set active = p_active where user_id = p_user_id;
  if not found then
    raise exception 'Člen neexistuje.';
  end if;
end;
$$;

create function buffet.member_invitation_is_valid(p_token text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when p_token is null or p_token !~ '^[0-9a-f]{64}$' then false
    else exists(
      select 1
      from buffet.member_invitations
      where token_hash = sha256(convert_to(p_token, 'UTF8'))
        and used_at is null
        and expires_at > now()
    )
  end;
$$;

create function buffet.redeem_member_invitation(
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

  insert into buffet.members (user_id, display_name, role, active)
  values (p_user_id, trim(p_display_name), 'seller', true);
  update buffet.member_invitations
  set used_at = now(), used_by = p_user_id
  where id = v_invitation_id;
end;
$$;

create function public.buffet_create_member_invitation() returns text
language sql security invoker set search_path = '' as $$
  select buffet.create_member_invitation();
$$;
create function public.buffet_admin_members() returns jsonb
language sql security invoker set search_path = '' as $$
  select buffet.admin_members();
$$;
create function public.buffet_set_member_active(
  p_user_id uuid,
  p_active boolean
) returns void
language sql security invoker set search_path = '' as $$
  select buffet.set_member_active(p_user_id, p_active);
$$;
create function public.buffet_member_invitation_is_valid(p_token text) returns boolean
language sql security invoker set search_path = '' as $$
  select buffet.member_invitation_is_valid(p_token);
$$;
create function public.buffet_redeem_member_invitation(
  p_token text,
  p_display_name text,
  p_user_id uuid
) returns void
language sql security invoker set search_path = '' as $$
  select buffet.redeem_member_invitation(p_token, p_display_name, p_user_id);
$$;

revoke execute on function buffet.create_member_invitation() from public, anon, authenticated;
revoke execute on function buffet.admin_members() from public, anon, authenticated;
revoke execute on function buffet.set_member_active(uuid, boolean) from public, anon, authenticated;
revoke execute on function buffet.member_invitation_is_valid(text) from public, anon, authenticated;
revoke execute on function buffet.redeem_member_invitation(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.buffet_create_member_invitation() from public, anon;
revoke execute on function public.buffet_admin_members() from public, anon;
revoke execute on function public.buffet_set_member_active(uuid, boolean) from public, anon;
revoke execute on function public.buffet_member_invitation_is_valid(text) from public, anon, authenticated;
revoke execute on function public.buffet_redeem_member_invitation(text, text, uuid) from public, anon, authenticated;

grant execute on function buffet.create_member_invitation() to authenticated;
grant execute on function buffet.admin_members() to authenticated;
grant execute on function buffet.set_member_active(uuid, boolean) to authenticated;
grant execute on function public.buffet_create_member_invitation() to authenticated;
grant execute on function public.buffet_admin_members() to authenticated;
grant execute on function public.buffet_set_member_active(uuid, boolean) to authenticated;

grant execute on function buffet.member_invitation_is_valid(text) to service_role;
grant execute on function buffet.redeem_member_invitation(text, text, uuid) to service_role;
grant execute on function public.buffet_member_invitation_is_valid(text) to service_role;
grant execute on function public.buffet_redeem_member_invitation(text, text, uuid) to service_role;
