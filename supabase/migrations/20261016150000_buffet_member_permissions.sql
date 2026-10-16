-- Per-member permissions. Defaults preserve existing seller access.
alter table buffet.members
  add column can_sell boolean not null default true,
  add column can_manage_meetings boolean not null default true,
  add column can_restock boolean not null default false,
  add column can_manage_products boolean not null default false;

create function buffet.has_permission(p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from buffet.members m
    where m.user_id = auth.uid() and m.active
      and p_permission in ('sell', 'manage_meetings', 'restock', 'manage_products')
      and (m.role = 'admin' or case p_permission
        when 'sell' then m.can_sell
        when 'manage_meetings' then m.can_manage_meetings
        when 'restock' then m.can_restock
        when 'manage_products' then m.can_manage_products
        else false end)
  );
$$;

create function buffet.require_permission(p_permission text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform buffet.require_member();
  if not buffet.has_permission(p_permission) then
    raise exception 'Na túto akciu nemáte oprávnenie.';
  end if;
end;
$$;

-- Deactivated admins must lose Storage write access as well.
create or replace function buffet.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from buffet.members
    where user_id = auth.uid() and active and role = 'admin'
  );
$$;

create function buffet.set_member_permissions(
  p_user_id uuid,
  p_can_sell boolean,
  p_can_manage_meetings boolean,
  p_can_restock boolean,
  p_can_manage_products boolean
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform buffet.require_admin();
  if p_user_id is null or p_can_sell is null
      or p_can_manage_meetings is null or p_can_restock is null
      or p_can_manage_products is null then
    raise exception 'Skontrolujte člena a oprávnenia.';
  end if;
  if exists (select 1 from buffet.members where user_id = p_user_id and role = 'admin') then
    raise exception 'Oprávnenia správcu nie je možné obmedziť.';
  end if;
  update buffet.members
  set can_sell = p_can_sell,
      can_manage_meetings = p_can_manage_meetings,
      can_restock = p_can_restock,
      can_manage_products = p_can_manage_products
  where user_id = p_user_id and role = 'seller';
  if not found then raise exception 'Člen neexistuje.'; end if;
end;
$$;

create function public.buffet_set_member_permissions(
  p_user_id uuid,
  p_can_sell boolean,
  p_can_manage_meetings boolean,
  p_can_restock boolean,
  p_can_manage_products boolean
) returns void
language sql security invoker set search_path = '' as $$
  select buffet.set_member_permissions(
    p_user_id, p_can_sell, p_can_manage_meetings, p_can_restock, p_can_manage_products
  );
$$;

create or replace function buffet.admin_members() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform buffet.require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(m) order by m.active desc, lower(m.display_name))
    from buffet.members m
  ), '[]'::jsonb);
end;
$$;

create or replace function buffet.open_meeting(p_meeting_date date, p_opening_cash_cents bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform buffet.require_permission('manage_meetings');
  if p_meeting_date is null or p_opening_cash_cents is null
      or p_opening_cash_cents < 0 or p_opening_cash_cents > 1000000000 then
    raise exception 'Skontrolujte dátum a počiatočnú hotovosť.';
  end if;
  if exists (select 1 from buffet.meetings where closed_at is null) then
    raise exception 'Stretnutie je už otvorené.';
  end if;
  insert into buffet.meetings (meeting_date, seller_id, opening_cash_cents)
    values (p_meeting_date, auth.uid(), p_opening_cash_cents) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'Stretnutie je už otvorené.';
end;
$$;

create or replace function buffet.record_sale(p_sale_id uuid, p_meeting_id uuid, p_product_id uuid, p_quantity integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_meeting buffet.meetings%rowtype;
  v_existing buffet.sales%rowtype;
  v_product buffet.products%rowtype;
begin
  perform buffet.require_permission('sell');
  if p_sale_id is null or p_product_id is null or p_quantity is null or p_quantity not between 1 and 99 then
    raise exception 'Skontrolujte produkt a množstvo.';
  end if;
  select * into v_meeting from buffet.meetings where id = p_meeting_id for update;
  if not found then raise exception 'Stretnutie neexistuje.'; end if;
  select * into v_existing from buffet.sales where id = p_sale_id;
  if found then
    if v_existing.meeting_id = p_meeting_id and v_existing.product_id = p_product_id
        and v_existing.quantity = p_quantity and v_existing.seller_id = auth.uid() then
      return p_sale_id;
    end if;
    raise exception 'Požiadavka na predaj už bola použitá.';
  end if;
  if v_meeting.closed_at is not null then raise exception 'Stretnutie nie je otvorené.'; end if;
  update buffet.products set stock_quantity = stock_quantity - p_quantity
    where id = p_product_id and active and stock_quantity >= p_quantity
    returning * into v_product;
  if not found then
    raise exception 'Produkt nie je dostupný alebo nemá dostatok kusov.';
  end if;
  insert into buffet.sales (id, meeting_id, product_id, product_name, quantity, unit_price_cents, seller_id)
    values (p_sale_id, p_meeting_id, p_product_id, v_product.name, p_quantity,
      v_product.price_cents, auth.uid());
  return p_sale_id;
end;
$$;

create or replace function buffet.reverse_sale(p_sale_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_meeting_id uuid; v_sale buffet.sales%rowtype; v_closed_at timestamptz; v_opening bigint; v_expected bigint;
begin
  perform buffet.require_permission('sell');
  select meeting_id into v_meeting_id from buffet.sales where id = p_sale_id;
  if not found then raise exception 'Predaj neexistuje.'; end if;
  select closed_at, opening_cash_cents into v_closed_at, v_opening
    from buffet.meetings where id = v_meeting_id for update;
  select * into v_sale from buffet.sales where id = p_sale_id for update;
  if v_sale.reversed_at is not null then return; end if;
  if v_closed_at is not null then raise exception 'Uzavretý predaj nemožno zrušiť.'; end if;
  select v_opening
    + coalesce((select sum(s.quantity::bigint * s.unit_price_cents) from buffet.sales s
      where s.meeting_id = v_meeting_id and s.reversed_at is null), 0)
    - v_sale.quantity::bigint * v_sale.unit_price_cents
    + coalesce((select sum(a.amount_cents) from buffet.cash_adjustments a
      where a.meeting_id = v_meeting_id), 0) into v_expected;
  if v_expected < 0 then
    raise exception 'Predaj nemožno zrušiť, pretože by hotovosť bola záporná.';
  end if;
  update buffet.products set stock_quantity = stock_quantity + v_sale.quantity where id = v_sale.product_id;
  update buffet.sales set reversed_at = now(), reversed_by = auth.uid() where id = p_sale_id;
end;
$$;

create or replace function buffet.add_cash_adjustment(p_adjustment_id uuid, p_meeting_id uuid,
  p_amount_cents bigint, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_existing buffet.cash_adjustments%rowtype; v_closed_at timestamptz; v_opening bigint; v_expected bigint;
begin
  perform buffet.require_permission('manage_meetings');
  if p_adjustment_id is null or p_amount_cents is null or p_amount_cents = 0
      or p_amount_cents < -1000000000 or p_amount_cents > 1000000000
      or char_length(trim(coalesce(p_note, ''))) not between 1 and 200 then
    raise exception 'Skontrolujte sumu a dôvod úpravy.';
  end if;
  select closed_at, opening_cash_cents into v_closed_at, v_opening from buffet.meetings where id = p_meeting_id for update;
  if not found or v_closed_at is not null then raise exception 'Stretnutie nie je otvorené.'; end if;
  select * into v_existing from buffet.cash_adjustments where id = p_adjustment_id;
  if found then
    if v_existing.meeting_id = p_meeting_id and v_existing.amount_cents = p_amount_cents
        and v_existing.note = trim(p_note) and v_existing.actor_id = auth.uid() then
      return p_adjustment_id;
    end if;
    raise exception 'Požiadavka na úpravu už bola použitá.';
  end if;
  select v_opening
    + coalesce((select sum(s.quantity::bigint * s.unit_price_cents) from buffet.sales s
      where s.meeting_id = p_meeting_id and s.reversed_at is null), 0)
    + coalesce((select sum(a.amount_cents) from buffet.cash_adjustments a
      where a.meeting_id = p_meeting_id), 0) + p_amount_cents into v_expected;
  if v_expected < 0 then raise exception 'Úprava by vytvorila zápornú hotovosť.'; end if;
  insert into buffet.cash_adjustments (id, meeting_id, amount_cents, note, actor_id)
    values (p_adjustment_id, p_meeting_id, p_amount_cents, trim(p_note), auth.uid());
  return p_adjustment_id;
end;
$$;

create or replace function buffet.close_meeting(p_meeting_id uuid, p_actual_cash_cents bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_meeting buffet.meetings%rowtype; v_expected bigint;
begin
  perform buffet.require_permission('manage_meetings');
  if p_actual_cash_cents is null or p_actual_cash_cents < 0 or p_actual_cash_cents > 1000000000 then
    raise exception 'Skontrolujte skutočnú hotovosť.';
  end if;
  select * into v_meeting from buffet.meetings where id = p_meeting_id for update;
  if not found then raise exception 'Stretnutie neexistuje.'; end if;
  if v_meeting.closed_at is not null then
    if v_meeting.actual_cash_cents = p_actual_cash_cents then return v_meeting.expected_cash_cents; end if;
    raise exception 'Stretnutie už bolo uzavreté.';
  end if;
  select v_meeting.opening_cash_cents
    + coalesce((select sum(s.quantity::bigint * s.unit_price_cents) from buffet.sales s
      where s.meeting_id = p_meeting_id and s.reversed_at is null), 0)
    + coalesce((select sum(a.amount_cents) from buffet.cash_adjustments a
      where a.meeting_id = p_meeting_id), 0) into v_expected;
  if v_expected < 0 then raise exception 'Očakávaná hotovosť nemôže byť záporná.'; end if;
  update buffet.meetings set closed_at = now(), actual_cash_cents = p_actual_cash_cents,
    expected_cash_cents = v_expected where id = p_meeting_id;
  return v_expected;
end;
$$;

create or replace function buffet.save_product(p_product_id uuid, p_name text, p_price_cents integer,
  p_minimum_stock integer, p_target_stock integer, p_active boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform buffet.require_permission('manage_products');
  if p_product_id is null or char_length(trim(coalesce(p_name, ''))) not between 1 and 80
      or p_price_cents is null or p_price_cents not between 0 and 10000000
      or p_minimum_stock is null or p_minimum_stock not between 0 and 1000000
      or p_target_stock is null or p_target_stock not between p_minimum_stock and 1000000
      or p_active is null then
    raise exception 'Skontrolujte údaje produktu.';
  end if;
  insert into buffet.products (id, name, price_cents, minimum_stock, target_stock, active)
    values (p_product_id, trim(p_name), p_price_cents, p_minimum_stock, p_target_stock, p_active)
    on conflict (id) do update set name = excluded.name, price_cents = excluded.price_cents,
      minimum_stock = excluded.minimum_stock, target_stock = excluded.target_stock, active = excluded.active;
  return p_product_id;
exception when unique_violation then
  raise exception 'Produkt s týmto názvom už existuje.';
end;
$$;

create or replace function buffet.restock(p_restock_id uuid, p_product_id uuid, p_quantity integer, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_existing buffet.restocks%rowtype;
begin
  perform buffet.require_permission('restock');
  if p_restock_id is null or p_product_id is null or p_quantity is null
      or p_quantity not between 1 and 1000000
      or char_length(trim(coalesce(p_note, ''))) not between 1 and 200 then
    raise exception 'Skontrolujte množstvo a dôvod doplnenia.';
  end if;
  select * into v_existing from buffet.restocks where id = p_restock_id;
  if found then
    if v_existing.product_id = p_product_id and v_existing.quantity = p_quantity
        and v_existing.note = trim(p_note) and v_existing.actor_id = auth.uid() then
      return p_restock_id;
    end if;
    raise exception 'Požiadavka na doplnenie už bola použitá.';
  end if;
  update buffet.products set stock_quantity = stock_quantity + p_quantity
    where id = p_product_id and stock_quantity <= 1000000 - p_quantity;
  if not found then raise exception 'Produkt neexistuje alebo je prekročený limit skladu.'; end if;
  insert into buffet.restocks (id, product_id, quantity, note, actor_id)
    values (p_restock_id, p_product_id, p_quantity, trim(p_note), auth.uid());
  return p_restock_id;
end;
$$;

create or replace function buffet.create_category(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform buffet.require_permission('manage_products');
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'Skontrolujte názov kategórie.';
  end if;
  insert into buffet.categories(name) values (trim(p_name)) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'Kategória s týmto názvom už existuje.';
end;
$$;

create or replace function buffet.save_product_details(p_product_id uuid, p_name text,
  p_price_cents integer, p_minimum_stock integer, p_target_stock integer,
  p_active boolean, p_category_id uuid, p_photo_path text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform buffet.require_permission('manage_products');
  if p_product_id is null
    or (p_category_id is not null and not exists (
      select 1 from buffet.categories where id = p_category_id))
    or (p_photo_path is not null and p_photo_path !~ (
      '^' || p_product_id::text ||
      '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$')) then
    raise exception 'Skontrolujte kategóriu alebo fotografiu produktu.';
  end if;
  perform buffet.save_product(p_product_id, p_name, p_price_cents,
    p_minimum_stock, p_target_stock, p_active);
  update buffet.products set category_id = p_category_id,
    photo_path = p_photo_path where id = p_product_id;
  return p_product_id;
end;
$$;

-- Stock and product managers also need hidden products in their inventory view.
create or replace function buffet.snapshot_catalog() returns jsonb
language sql security definer set search_path = '' as $$
  select buffet.snapshot() || jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.name) from buffet.categories c
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.name)
      from buffet.products p
      where p.active or buffet.has_permission('manage_products') or buffet.has_permission('restock')
    ), '[]'::jsonb)
  );
$$;

alter policy "Buffet admins upload product photos" on storage.objects
  with check (
    bucket_id = 'buffet-product-photos' and buffet.has_permission('manage_products')
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
  );
alter policy "Buffet admins delete product photos" on storage.objects
  using (bucket_id = 'buffet-product-photos' and buffet.has_permission('manage_products'));

revoke execute on function buffet.has_permission(text) from public, anon, authenticated;
revoke execute on function buffet.require_permission(text) from public, anon, authenticated;
revoke execute on function buffet.set_member_permissions(uuid, boolean, boolean, boolean, boolean) from public, anon, authenticated;
revoke execute on function public.buffet_set_member_permissions(uuid, boolean, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function buffet.has_permission(text) to authenticated;
grant execute on function buffet.set_member_permissions(uuid, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.buffet_set_member_permissions(uuid, boolean, boolean, boolean, boolean) to authenticated;
