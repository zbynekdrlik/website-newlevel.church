-- Buffet data stays in its own schema. Only the public RPC wrappers are exposed
-- through the existing Data API; authenticated users have no direct table grants.
create schema buffet;
revoke all on schema buffet from public, anon, authenticated;
grant usage on schema buffet to authenticated;
alter default privileges for role postgres in schema buffet revoke execute on functions from public;

create table buffet.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 80),
  role text not null check (role in ('seller', 'admin')),
  created_at timestamptz not null default now()
);

create table buffet.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  price_cents integer not null check (price_cents between 0 and 10000000),
  stock_quantity integer not null default 0 check (stock_quantity between 0 and 1000000),
  minimum_stock integer not null default 0 check (minimum_stock between 0 and 1000000),
  target_stock integer not null default 0 check (target_stock between minimum_stock and 1000000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index products_name_unique on buffet.products (lower(trim(name)));

create table buffet.meetings (
  id uuid primary key default gen_random_uuid(),
  meeting_date date not null,
  seller_id uuid not null references buffet.members(user_id),
  opening_cash_cents bigint not null check (opening_cash_cents between 0 and 1000000000),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  expected_cash_cents bigint,
  actual_cash_cents bigint,
  check ((closed_at is null and expected_cash_cents is null and actual_cash_cents is null)
      or (closed_at is not null and expected_cash_cents is not null and actual_cash_cents is not null))
);
create unique index one_open_buffet_meeting on buffet.meetings ((true)) where closed_at is null;

create table buffet.sales (
  id uuid primary key,
  meeting_id uuid not null references buffet.meetings(id),
  product_id uuid not null references buffet.products(id),
  product_name text not null,
  quantity integer not null check (quantity between 1 and 99),
  unit_price_cents integer not null check (unit_price_cents between 0 and 10000000),
  seller_id uuid not null references buffet.members(user_id),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references buffet.members(user_id)
);
create index sales_meeting_created on buffet.sales (meeting_id, created_at desc);

create table buffet.restocks (
  id uuid primary key,
  product_id uuid not null references buffet.products(id),
  quantity integer not null check (quantity between 1 and 1000000),
  note text not null check (char_length(trim(note)) between 1 and 200),
  actor_id uuid not null references buffet.members(user_id),
  created_at timestamptz not null default now()
);

create table buffet.cash_adjustments (
  id uuid primary key,
  meeting_id uuid not null references buffet.meetings(id),
  amount_cents bigint not null check (amount_cents between -1000000000 and 1000000000 and amount_cents <> 0),
  note text not null check (char_length(trim(note)) between 1 and 200),
  actor_id uuid not null references buffet.members(user_id),
  created_at timestamptz not null default now()
);
create index cash_adjustments_meeting_created on buffet.cash_adjustments (meeting_id, created_at desc);

alter table buffet.members enable row level security;
alter table buffet.products enable row level security;
alter table buffet.meetings enable row level security;
alter table buffet.sales enable row level security;
alter table buffet.restocks enable row level security;
alter table buffet.cash_adjustments enable row level security;
revoke all on all tables in schema buffet from public, anon, authenticated;
revoke all on all sequences in schema buffet from public, anon, authenticated;

create function buffet.require_member() returns text
language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  select role into v_role from buffet.members where user_id = auth.uid();
  if v_role is null then
    raise exception 'Prístup do Buffetu nie je povolený.';
  end if;
  return v_role;
end;
$$;

create function buffet.require_admin() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if buffet.require_member() <> 'admin' then
    raise exception 'Na túto akciu nemáte oprávnenie.';
  end if;
end;
$$;

create function buffet.snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_member jsonb;
  v_products jsonb;
  v_meeting_id uuid;
  v_meeting jsonb;
  v_sales jsonb;
  v_adjustments jsonb;
  v_recent jsonb;
begin
  v_role := buffet.require_member();
  select to_jsonb(m) into v_member from buffet.members m where m.user_id = auth.uid();
  -- Hold the meeting stable while reading stock, sales, and cash totals.
  select id into v_meeting_id from buffet.meetings where closed_at is null for share;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.name), '[]'::jsonb)
    into v_products from buffet.products p where p.active or v_role = 'admin';
  if v_meeting_id is not null then
    select to_jsonb(m) || jsonb_build_object(
      'seller_name', mb.display_name,
      'sales_revenue_cents', coalesce((select sum(s.quantity::bigint * s.unit_price_cents)
        from buffet.sales s where s.meeting_id = m.id and s.reversed_at is null), 0),
      'adjustments_cents', coalesce((select sum(a.amount_cents)
        from buffet.cash_adjustments a where a.meeting_id = m.id), 0),
      'expected_cash_cents_live', m.opening_cash_cents
        + coalesce((select sum(s.quantity::bigint * s.unit_price_cents)
          from buffet.sales s where s.meeting_id = m.id and s.reversed_at is null), 0)
        + coalesce((select sum(a.amount_cents)
          from buffet.cash_adjustments a where a.meeting_id = m.id), 0)
    ) into v_meeting
    from buffet.meetings m join buffet.members mb on mb.user_id = m.seller_id
    where m.id = v_meeting_id;
  end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
    into v_sales from buffet.sales s where s.meeting_id = v_meeting_id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc), '[]'::jsonb)
    into v_adjustments from buffet.cash_adjustments a where a.meeting_id = v_meeting_id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.closed_at desc), '[]'::jsonb)
    into v_recent from (
      select m.id, m.meeting_date, m.opening_cash_cents, m.expected_cash_cents,
        m.actual_cash_cents, m.closed_at, mb.display_name as seller_name
      from buffet.meetings m join buffet.members mb on mb.user_id = m.seller_id
      where m.closed_at is not null order by m.closed_at desc limit 12
    ) x;
  return jsonb_build_object('member', v_member, 'products', v_products,
    'active_meeting', v_meeting, 'sales', v_sales,
    'cash_adjustments', v_adjustments, 'recent_meetings', v_recent);
end;
$$;

create function buffet.open_meeting(p_meeting_date date, p_opening_cash_cents bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform buffet.require_member();
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

create function buffet.record_sale(p_sale_id uuid, p_meeting_id uuid, p_product_id uuid, p_quantity integer) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_meeting buffet.meetings%rowtype;
  v_existing buffet.sales%rowtype;
  v_product buffet.products%rowtype;
begin
  perform buffet.require_member();
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

create function buffet.reverse_sale(p_sale_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_meeting_id uuid; v_sale buffet.sales%rowtype; v_closed_at timestamptz; v_opening bigint; v_expected bigint;
begin
  perform buffet.require_member();
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

create function buffet.add_cash_adjustment(p_adjustment_id uuid, p_meeting_id uuid,
  p_amount_cents bigint, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_existing buffet.cash_adjustments%rowtype; v_closed_at timestamptz; v_opening bigint; v_expected bigint;
begin
  perform buffet.require_member();
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

create function buffet.close_meeting(p_meeting_id uuid, p_actual_cash_cents bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_meeting buffet.meetings%rowtype; v_expected bigint;
begin
  perform buffet.require_member();
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

create function buffet.save_product(p_product_id uuid, p_name text, p_price_cents integer,
  p_minimum_stock integer, p_target_stock integer, p_active boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform buffet.require_admin();
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

create function buffet.restock(p_restock_id uuid, p_product_id uuid, p_quantity integer, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_existing buffet.restocks%rowtype;
begin
  perform buffet.require_admin();
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

-- SECURITY INVOKER wrappers are the only Buffet routines in the exposed public schema.
create function public.buffet_snapshot() returns jsonb language sql security invoker set search_path = '' as $$
  select buffet.snapshot();
$$;
create function public.buffet_open_meeting(p_meeting_date date, p_opening_cash_cents bigint) returns uuid language sql security invoker set search_path = '' as $$
  select buffet.open_meeting(p_meeting_date, p_opening_cash_cents);
$$;
create function public.buffet_record_sale(p_sale_id uuid, p_meeting_id uuid, p_product_id uuid, p_quantity integer) returns uuid language sql security invoker set search_path = '' as $$
  select buffet.record_sale(p_sale_id, p_meeting_id, p_product_id, p_quantity);
$$;
create function public.buffet_reverse_sale(p_sale_id uuid) returns void language sql security invoker set search_path = '' as $$
  select buffet.reverse_sale(p_sale_id);
$$;
create function public.buffet_add_cash_adjustment(p_adjustment_id uuid, p_meeting_id uuid, p_amount_cents bigint, p_note text) returns uuid language sql security invoker set search_path = '' as $$
  select buffet.add_cash_adjustment(p_adjustment_id, p_meeting_id, p_amount_cents, p_note);
$$;
create function public.buffet_close_meeting(p_meeting_id uuid, p_actual_cash_cents bigint) returns bigint language sql security invoker set search_path = '' as $$
  select buffet.close_meeting(p_meeting_id, p_actual_cash_cents);
$$;
create function public.buffet_save_product(p_product_id uuid, p_name text, p_price_cents integer, p_minimum_stock integer, p_target_stock integer, p_active boolean) returns uuid language sql security invoker set search_path = '' as $$
  select buffet.save_product(p_product_id, p_name, p_price_cents, p_minimum_stock, p_target_stock, p_active);
$$;
create function public.buffet_restock(p_restock_id uuid, p_product_id uuid, p_quantity integer, p_note text) returns uuid language sql security invoker set search_path = '' as $$
  select buffet.restock(p_restock_id, p_product_id, p_quantity, p_note);
$$;

revoke execute on all functions in schema buffet from public, anon, authenticated;
revoke execute on function public.buffet_snapshot() from public, anon;
revoke execute on function public.buffet_open_meeting(date, bigint) from public, anon;
revoke execute on function public.buffet_record_sale(uuid, uuid, uuid, integer) from public, anon;
revoke execute on function public.buffet_reverse_sale(uuid) from public, anon;
revoke execute on function public.buffet_add_cash_adjustment(uuid, uuid, bigint, text) from public, anon;
revoke execute on function public.buffet_close_meeting(uuid, bigint) from public, anon;
revoke execute on function public.buffet_save_product(uuid, text, integer, integer, integer, boolean) from public, anon;
revoke execute on function public.buffet_restock(uuid, uuid, integer, text) from public, anon;
grant execute on all functions in schema buffet to authenticated;
grant execute on function public.buffet_snapshot() to authenticated;
grant execute on function public.buffet_open_meeting(date, bigint) to authenticated;
grant execute on function public.buffet_record_sale(uuid, uuid, uuid, integer) to authenticated;
grant execute on function public.buffet_reverse_sale(uuid) to authenticated;
grant execute on function public.buffet_add_cash_adjustment(uuid, uuid, bigint, text) to authenticated;
grant execute on function public.buffet_close_meeting(uuid, bigint) to authenticated;
grant execute on function public.buffet_save_product(uuid, text, integer, integer, integer, boolean) to authenticated;
grant execute on function public.buffet_restock(uuid, uuid, integer, text) to authenticated;
