drop index if exists invitation.contacts_phone_unique;

create index if not exists contacts_phone_idx
  on invitation.contacts (phone)
  where phone is not null;

create or replace function public.register_invitation_contact(
  p_name text,
  p_email text,
  p_phone text,
  p_source text default 'register-contact'
)
returns uuid
language plpgsql
security definer
set search_path = invitation, public
as $$
declare
  v_name text := nullif(trim(p_name), '');
  v_email text := nullif(lower(trim(p_email)), '');
  v_phone text := nullif(trim(p_phone), '');
  v_source text := coalesce(nullif(trim(p_source), ''), 'register-contact');
  v_contact_id uuid;
  v_phone_match_id uuid;
  v_phone_match_email text;
begin
  if v_email is null and v_phone is null then
    raise exception 'email or phone is required'
      using errcode = '22023';
  end if;

  if v_name is not null and length(v_name) > 120 then
    raise exception 'name is too long'
      using errcode = '22023';
  end if;

  if v_email is not null and length(v_email) > 254 then
    raise exception 'email is too long'
      using errcode = '22023';
  end if;

  if v_phone is not null and length(v_phone) > 32 then
    raise exception 'phone is too long'
      using errcode = '22023';
  end if;

  if v_email is not null then
    select id into v_contact_id
    from invitation.contacts
    where email = v_email;
  end if;

  if v_contact_id is null and v_phone is not null then
    select id, email into v_phone_match_id, v_phone_match_email
    from invitation.contacts
    where phone = v_phone
    order by created_at
    limit 1;

    if v_email is null or v_phone_match_email is null then
      v_contact_id := v_phone_match_id;
    end if;
  end if;

  if v_contact_id is not null then
    update invitation.contacts
    set
      name = coalesce(v_name, name),
      email = coalesce(v_email, email),
      phone = coalesce(v_phone, phone),
      source = v_source,
      active = true,
      updated_at = now()
    where id = v_contact_id;

    return v_contact_id;
  end if;

  insert into invitation.contacts (name, email, phone, source, active)
  values (v_name, v_email, v_phone, v_source, true)
  returning id into v_contact_id;

  return v_contact_id;
exception
  when unique_violation then
    raise exception 'contact already exists'
      using errcode = '23505';
end;
$$;

revoke all on function public.register_invitation_contact(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.register_invitation_contact(text, text, text, text)
  to service_role;
