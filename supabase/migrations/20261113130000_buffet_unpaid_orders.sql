-- An unpaid purchase consumes stock now; cash is counted only when it is paid.
-- Keep the original sale and price snapshots for audit across meetings.
create table buffet.unpaid_orders (
  purchase_id uuid primary key references buffet.purchases(id),
  customer_name text not null check (char_length(trim(customer_name)) between 1 and 80),
  note text not null default '' check (char_length(note) <= 200),
  settled_meeting_id uuid references buffet.meetings(id),
  settled_amount_cents bigint check (settled_amount_cents between 0 and 100000000000),
  settled_at timestamptz,
  settled_by uuid references buffet.members(user_id),
  check ((settled_meeting_id is null and settled_amount_cents is null and settled_at is null and settled_by is null)
    or (settled_meeting_id is not null and settled_amount_cents is not null and settled_at is not null and settled_by is not null))
);
create index unpaid_orders_settled_meeting on buffet.unpaid_orders (settled_meeting_id)
  where settled_meeting_id is not null;
alter table buffet.unpaid_orders enable row level security;
revoke all on buffet.unpaid_orders from public, anon, authenticated;

create function buffet.meeting_paid_sales(p_meeting_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(s.quantity::bigint * s.unit_price_cents), 0)
  from buffet.sales s
  where s.meeting_id = p_meeting_id and s.reversed_at is null
    and not exists (select 1 from buffet.unpaid_orders u where u.purchase_id = s.purchase_id);
$$;

create function buffet.meeting_debt_payments(p_meeting_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(u.settled_amount_cents), 0)
  from buffet.unpaid_orders u where u.settled_meeting_id = p_meeting_id;
$$;

create function buffet.record_unpaid_purchase(p_purchase_id uuid, p_meeting_id uuid,
  p_items jsonb, p_expected_total_cents bigint, p_customer_name text, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_existing boolean; v_order buffet.unpaid_orders%rowtype;
begin
  perform buffet.require_permission('sell');
  if char_length(trim(coalesce(p_customer_name, ''))) not between 1 and 80
      or char_length(trim(coalesce(p_note, ''))) > 200 then
    raise exception 'Zadajte meno zákazníka a skontrolujte poznámku.';
  end if;
  -- record_purchase takes the meeting lock, checks stock and prices, and is
  -- replay-safe. Its writes and this order row are one transaction.
  perform 1 from buffet.meetings where id = p_meeting_id for update;
  select exists(select 1 from buffet.purchases where id = p_purchase_id) into v_existing;
  perform buffet.record_purchase(p_purchase_id, p_meeting_id, p_items, p_expected_total_cents);
  select * into v_order from buffet.unpaid_orders where purchase_id = p_purchase_id;
  if found then
    if v_order.customer_name = trim(p_customer_name) and v_order.note = trim(coalesce(p_note, '')) then
      return p_purchase_id;
    end if;
    raise exception 'Požiadavka na nezaplatenú objednávku už bola použitá.';
  end if;
  if v_existing then
    raise exception 'Tento nákup už bol zaznamenaný ako zaplatený.';
  end if;
  insert into buffet.unpaid_orders (purchase_id, customer_name, note)
    values (p_purchase_id, trim(p_customer_name), trim(coalesce(p_note, '')));
  return p_purchase_id;
end;
$$;

create function buffet.settle_unpaid_order(p_purchase_id uuid, p_meeting_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_meeting buffet.meetings%rowtype; v_order buffet.unpaid_orders%rowtype; v_amount bigint;
begin
  perform buffet.require_permission('sell');
  if p_purchase_id is null or p_meeting_id is null then
    raise exception 'Skontrolujte objednávku a stretnutie.';
  end if;
  -- The same meeting lock serializes payment with closing and cancellation.
  select * into v_meeting from buffet.meetings where id = p_meeting_id for update;
  if not found then raise exception 'Stretnutie neexistuje.'; end if;
  select * into v_order from buffet.unpaid_orders where purchase_id = p_purchase_id for update;
  if not found then raise exception 'Nezaplatená objednávka neexistuje.'; end if;
  if v_order.settled_at is not null then
    if v_order.settled_meeting_id = p_meeting_id then return p_purchase_id; end if;
    raise exception 'Objednávka už bola zaplatená na inom stretnutí.';
  end if;
  if v_meeting.closed_at is not null then raise exception 'Stretnutie nie je otvorené.'; end if;
  if exists (
    select 1 from buffet.purchases p join buffet.meetings m on m.id = p.meeting_id
    where p.id = p_purchase_id and m.cancelled_at is not null
  ) then raise exception 'Objednávka zo zrušeného stretnutia sa nedá uhradiť.'; end if;
  select sum(s.quantity::bigint * s.unit_price_cents) into v_amount
    from buffet.sales s where s.purchase_id = p_purchase_id and s.reversed_at is null;
  if v_amount is null then raise exception 'Zrušenú objednávku nemožno uhradiť.'; end if;
  update buffet.unpaid_orders set settled_meeting_id = p_meeting_id,
    settled_amount_cents = v_amount, settled_at = now(), settled_by = auth.uid()
    where purchase_id = p_purchase_id;
  return p_purchase_id;
end;
$$;

create function buffet.list_unpaid_orders() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_orders jsonb;
begin
  perform buffet.require_permission('sell');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
    into v_orders from (
    select u.purchase_id, u.customer_name, u.note, p.created_at,
      m.meeting_date, sum(s.quantity::bigint * s.unit_price_cents) as total_cents,
      jsonb_agg(jsonb_build_object('product_name', s.product_name,
        'quantity', s.quantity, 'unit_price_cents', s.unit_price_cents)
        order by s.created_at, s.id) as items
    from buffet.unpaid_orders u
    join buffet.purchases p on p.id = u.purchase_id
    join buffet.meetings m on m.id = p.meeting_id and m.cancelled_at is null
    join buffet.sales s on s.purchase_id = u.purchase_id and s.reversed_at is null
    where u.settled_at is null
    group by u.purchase_id, p.created_at, m.meeting_date
  ) x;
  return v_orders;
end;
$$;

create or replace function buffet.reverse_sale(p_sale_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_meeting_id uuid; v_sale buffet.sales%rowtype; v_closed_at timestamptz;
  v_opening bigint; v_expected bigint; v_unpaid boolean;
begin
  perform buffet.require_permission('sell');
  select meeting_id into v_meeting_id from buffet.sales where id = p_sale_id;
  if not found then raise exception 'Predaj neexistuje.'; end if;
  select closed_at, opening_cash_cents into v_closed_at, v_opening
    from buffet.meetings where id = v_meeting_id for update;
  select * into v_sale from buffet.sales where id = p_sale_id for update;
  if v_sale.reversed_at is not null then return; end if;
  if v_closed_at is not null then raise exception 'Uzavretý predaj nemožno zrušiť.'; end if;
  select exists(select 1 from buffet.unpaid_orders u where u.purchase_id = v_sale.purchase_id)
    into v_unpaid;
  if v_unpaid and exists(select 1 from buffet.unpaid_orders u
      where u.purchase_id = v_sale.purchase_id and u.settled_at is not null) then
    raise exception 'Zaplatenú objednávku nemožno zrušiť.';
  end if;
  v_expected := v_opening + buffet.meeting_paid_sales(v_meeting_id)
    - case when v_unpaid then 0 else v_sale.quantity::bigint * v_sale.unit_price_cents end
    + buffet.meeting_debt_payments(v_meeting_id)
    + coalesce((select sum(a.amount_cents) from buffet.cash_adjustments a
      where a.meeting_id = v_meeting_id), 0);
  if v_expected < 0 then
    raise exception 'Predaj nemožno zrušiť, pretože by hotovosť bola záporná.';
  end if;
  if v_sale.stock_tracked then
    update buffet.products set stock_quantity = stock_quantity + v_sale.quantity
      where id = v_sale.product_id and stock_quantity <= 1000000 - v_sale.quantity;
    if not found then raise exception 'Produkt by po vrátení prekročil limit skladu.'; end if;
  end if;
  update buffet.sales set reversed_at = now(), reversed_by = auth.uid() where id = p_sale_id;
end;
$$;

create or replace function buffet.add_cash_adjustment(p_adjustment_id uuid, p_meeting_id uuid,
  p_amount_cents bigint, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_existing buffet.cash_adjustments%rowtype; v_closed_at timestamptz;
  v_opening bigint; v_expected bigint;
begin
  perform buffet.require_permission('manage_meetings');
  if p_adjustment_id is null or p_amount_cents is null or p_amount_cents = 0
      or p_amount_cents < -1000000000 or p_amount_cents > 1000000000
      or char_length(trim(coalesce(p_note, ''))) not between 1 and 200 then
    raise exception 'Skontrolujte sumu a dôvod úpravy.';
  end if;
  select closed_at, opening_cash_cents into v_closed_at, v_opening
    from buffet.meetings where id = p_meeting_id for update;
  if not found or v_closed_at is not null then raise exception 'Stretnutie nie je otvorené.'; end if;
  select * into v_existing from buffet.cash_adjustments where id = p_adjustment_id;
  if found then
    if v_existing.meeting_id = p_meeting_id and v_existing.amount_cents = p_amount_cents
        and v_existing.note = trim(p_note) and v_existing.actor_id = auth.uid() then
      return p_adjustment_id;
    end if;
    raise exception 'Požiadavka na úpravu už bola použitá.';
  end if;
  v_expected := v_opening + buffet.meeting_paid_sales(p_meeting_id)
    + buffet.meeting_debt_payments(p_meeting_id)
    + coalesce((select sum(a.amount_cents) from buffet.cash_adjustments a
      where a.meeting_id = p_meeting_id), 0) + p_amount_cents;
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
  if v_meeting.cancelled_at is not null then raise exception 'Stretnutie bolo zrušené.'; end if;
  if v_meeting.closed_at is not null then
    if v_meeting.actual_cash_cents = p_actual_cash_cents then return v_meeting.expected_cash_cents; end if;
    raise exception 'Stretnutie už bolo uzavreté.';
  end if;
  v_expected := v_meeting.opening_cash_cents + buffet.meeting_paid_sales(p_meeting_id)
    + buffet.meeting_debt_payments(p_meeting_id)
    + coalesce((select sum(a.amount_cents) from buffet.cash_adjustments a
      where a.meeting_id = p_meeting_id), 0);
  if v_expected < 0 then raise exception 'Očakávaná hotovosť nemôže byť záporná.'; end if;
  update buffet.meetings set closed_at = now(), actual_cash_cents = p_actual_cash_cents,
    expected_cash_cents = v_expected where id = p_meeting_id;
  return v_expected;
end;
$$;

create or replace function buffet.cancel_meeting(p_meeting_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_meeting buffet.meetings%rowtype; v_stock record;
begin
  perform buffet.require_admin();
  select * into v_meeting from buffet.meetings where id = p_meeting_id for update;
  if not found then raise exception 'Stretnutie neexistuje.'; end if;
  if v_meeting.cancelled_at is not null then return; end if;
  if v_meeting.closed_at is not null then
    raise exception 'Stretnutie už bolo uzavreté. Zrušiť možno iba otvorené stretnutie.';
  end if;
  -- Payments received on this meeting are void with it; older orders become
  -- outstanding again. Orders issued here disappear when their sales reverse.
  update buffet.unpaid_orders set settled_meeting_id = null,
    settled_amount_cents = null, settled_at = null, settled_by = null
    where settled_meeting_id = p_meeting_id;
  for v_stock in
    select s.product_id, sum(s.quantity) as quantity from buffet.sales s
    where s.meeting_id = p_meeting_id and s.reversed_at is null and s.stock_tracked
    group by s.product_id order by s.product_id
  loop
    update buffet.products set stock_quantity = stock_quantity + v_stock.quantity
      where id = v_stock.product_id and stock_quantity <= 1000000 - v_stock.quantity;
    if not found then
      raise exception 'Produkt by po vrátení prekročil limit skladu. Najprv upravte zásoby.';
    end if;
  end loop;
  update buffet.sales set reversed_at = now(), reversed_by = auth.uid()
    where meeting_id = p_meeting_id and reversed_at is null;
  update buffet.meetings set cancelled_at = now(), cancelled_by = auth.uid(),
    closed_at = now(), expected_cash_cents = 0, actual_cash_cents = 0
    where id = p_meeting_id;
end;
$$;

create or replace function buffet.sales_page(p_meeting_id uuid,
  p_before_created_at timestamptz, p_before_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_active_meeting_id uuid; v_page jsonb; v_can_sell boolean;
begin
  perform buffet.require_member();
  v_can_sell := buffet.has_permission('sell');
  select id into v_active_meeting_id from buffet.meetings where closed_at is null for share;
  if p_meeting_id is distinct from v_active_meeting_id then
    raise exception 'Stretnutie sa zmenilo. Obnovte údaje.';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'Skontrolujte stránkovanie predajov.';
  end if;
  with candidates as materialized (
    select p.id, p.created_at, true as is_purchase from buffet.purchases p
      where p.meeting_id = p_meeting_id and (p_before_created_at is null
        or (p.created_at, p.id) < (p_before_created_at, p_before_id))
    union all
    select s.id, s.created_at, false as is_purchase from buffet.sales s
      where s.meeting_id = p_meeting_id and s.purchase_id is null
        and (p_before_created_at is null
          or (s.created_at, s.id) < (p_before_created_at, p_before_id))
    order by created_at desc, id desc limit 31
  ), page as materialized (
    select * from candidates order by created_at desc, id desc limit 30
  )
  select jsonb_build_object(
    'sales', coalesce((
      select jsonb_agg(to_jsonb(s) || jsonb_build_object(
        'unpaid_customer_name', case when v_can_sell then u.customer_name else null end,
        'unpaid_settled_at', u.settled_at)
        order by g.created_at desc, g.id desc, s.created_at desc, s.id desc)
      from page g join buffet.sales s
        on (g.is_purchase and s.purchase_id = g.id)
          or (not g.is_purchase and s.id = g.id)
      left join buffet.unpaid_orders u on u.purchase_id = s.purchase_id
    ), '[]'::jsonb),
    'next_cursor', case when (select count(*) from candidates) > 30 then (
      select jsonb_build_object('created_at', g.created_at, 'id', g.id)
      from page g order by g.created_at desc, g.id desc offset 29 limit 1
    ) else 'null'::jsonb end
  ) into v_page;
  return v_page;
end;
$$;

create or replace function buffet.snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_role text; v_member jsonb; v_products jsonb; v_meeting_id uuid;
  v_meeting jsonb; v_sales_page jsonb; v_adjustments jsonb; v_recent jsonb;
  v_revenue bigint := 0; v_debt_payments bigint := 0; v_cash_adjustments bigint := 0;
begin
  v_role := buffet.require_member();
  select to_jsonb(m) into v_member from buffet.members m where m.user_id = auth.uid();
  select id into v_meeting_id from buffet.meetings where closed_at is null for share;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.name), '[]'::jsonb)
    into v_products from buffet.products p where p.active or v_role = 'admin';
  if v_meeting_id is not null then
    v_revenue := buffet.meeting_paid_sales(v_meeting_id);
    v_debt_payments := buffet.meeting_debt_payments(v_meeting_id);
    select coalesce(sum(a.amount_cents), 0) into v_cash_adjustments
      from buffet.cash_adjustments a where a.meeting_id = v_meeting_id;
    select to_jsonb(m) || jsonb_build_object(
      'seller_name', mb.display_name,
      'sales_revenue_cents', v_revenue,
      'debt_payments_cents', v_debt_payments,
      'adjustments_cents', v_cash_adjustments,
      'expected_cash_cents_live', m.opening_cash_cents + v_revenue + v_debt_payments + v_cash_adjustments
    ) into v_meeting from buffet.meetings m
      join buffet.members mb on mb.user_id = m.seller_id where m.id = v_meeting_id;
  end if;
  v_sales_page := buffet.sales_page(v_meeting_id, null, null);
  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc), '[]'::jsonb)
    into v_adjustments from buffet.cash_adjustments a where a.meeting_id = v_meeting_id;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.closed_at desc), '[]'::jsonb)
    into v_recent from (
      select m.id, m.meeting_date, m.opening_cash_cents, m.expected_cash_cents,
        m.actual_cash_cents, m.closed_at, mb.display_name as seller_name
      from buffet.meetings m join buffet.members mb on mb.user_id = m.seller_id
      where m.closed_at is not null and m.cancelled_at is null
      order by m.closed_at desc limit 12
    ) x;
  return jsonb_build_object('member', v_member, 'products', v_products,
    'active_meeting', v_meeting, 'sales', v_sales_page->'sales',
    'sales_next_cursor', v_sales_page->'next_cursor',
    'cash_adjustments', v_adjustments, 'recent_meetings', v_recent);
end;
$$;

create function public.buffet_record_unpaid_purchase(p_purchase_id uuid, p_meeting_id uuid,
  p_items jsonb, p_expected_total_cents bigint, p_customer_name text, p_note text) returns uuid
language sql security invoker set search_path = '' as $$
  select buffet.record_unpaid_purchase(p_purchase_id, p_meeting_id, p_items,
    p_expected_total_cents, p_customer_name, p_note);
$$;
create function public.buffet_settle_unpaid_order(p_purchase_id uuid, p_meeting_id uuid) returns uuid
language sql security invoker set search_path = '' as $$
  select buffet.settle_unpaid_order(p_purchase_id, p_meeting_id);
$$;
create function public.buffet_unpaid_orders() returns jsonb
language sql security invoker set search_path = '' as $$
  select buffet.list_unpaid_orders();
$$;
revoke execute on function buffet.meeting_paid_sales(uuid), buffet.meeting_debt_payments(uuid),
  buffet.record_unpaid_purchase(uuid, uuid, jsonb, bigint, text, text),
  buffet.settle_unpaid_order(uuid, uuid), buffet.list_unpaid_orders()
  from public, anon, authenticated;
revoke execute on function public.buffet_record_unpaid_purchase(uuid, uuid, jsonb, bigint, text, text),
  public.buffet_settle_unpaid_order(uuid, uuid), public.buffet_unpaid_orders()
  from public, anon, authenticated;
grant execute on function buffet.record_unpaid_purchase(uuid, uuid, jsonb, bigint, text, text),
  buffet.settle_unpaid_order(uuid, uuid), buffet.list_unpaid_orders() to authenticated;
grant execute on function public.buffet_record_unpaid_purchase(uuid, uuid, jsonb, bigint, text, text),
  public.buffet_settle_unpaid_order(uuid, uuid), public.buffet_unpaid_orders() to authenticated;

notify pgrst, 'reload schema';
