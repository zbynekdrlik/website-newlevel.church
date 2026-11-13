-- Page active-meeting sales by purchase so routine snapshots stay small even
-- after a long meeting. Totals still include every non-reversed sale.
create index sales_legacy_meeting_created_id
  on buffet.sales (meeting_id, created_at desc, id desc)
  where purchase_id is null;
create index purchases_meeting_created_id
  on buffet.purchases (meeting_id, created_at desc, id desc);

create function buffet.sales_page(p_meeting_id uuid,
  p_before_created_at timestamptz, p_before_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_active_meeting_id uuid;
  v_page jsonb;
begin
  perform buffet.require_member();
  select id into v_active_meeting_id
    from buffet.meetings where closed_at is null for share;
  if p_meeting_id is distinct from v_active_meeting_id then
    raise exception 'Stretnutie sa zmenilo. Obnovte údaje.';
  end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'Skontrolujte stránkovanie predajov.';
  end if;

  with candidates as materialized (
    select p.id, p.created_at, true as is_purchase
      from buffet.purchases p
      where p.meeting_id = p_meeting_id
        and (p_before_created_at is null
          or (p.created_at, p.id) < (p_before_created_at, p_before_id))
    union all
    select s.id, s.created_at, false as is_purchase
      from buffet.sales s
      where s.meeting_id = p_meeting_id and s.purchase_id is null
        and (p_before_created_at is null
          or (s.created_at, s.id) < (p_before_created_at, p_before_id))
    order by created_at desc, id desc limit 31
  ), page as materialized (
    select * from candidates order by created_at desc, id desc limit 30
  )
  select jsonb_build_object(
    'sales', coalesce((
      select jsonb_agg(to_jsonb(s) order by g.created_at desc, g.id desc,
        s.created_at desc, s.id desc)
      from page g join buffet.sales s
        on (g.is_purchase and s.purchase_id = g.id)
          or (not g.is_purchase and s.id = g.id)
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
declare
  v_role text;
  v_member jsonb;
  v_products jsonb;
  v_meeting_id uuid;
  v_meeting jsonb;
  v_sales_page jsonb;
  v_adjustments jsonb;
  v_recent jsonb;
  v_revenue bigint := 0;
  v_cash_adjustments bigint := 0;
begin
  v_role := buffet.require_member();
  select to_jsonb(m) into v_member from buffet.members m where m.user_id = auth.uid();
  -- Hold the meeting stable while reading stock, sales, and cash totals.
  select id into v_meeting_id from buffet.meetings where closed_at is null for share;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.name), '[]'::jsonb)
    into v_products from buffet.products p where p.active or v_role = 'admin';
  if v_meeting_id is not null then
    select coalesce(sum(s.quantity::bigint * s.unit_price_cents), 0)
      into v_revenue from buffet.sales s
      where s.meeting_id = v_meeting_id and s.reversed_at is null;
    select coalesce(sum(a.amount_cents), 0)
      into v_cash_adjustments from buffet.cash_adjustments a
      where a.meeting_id = v_meeting_id;
    select to_jsonb(m) || jsonb_build_object(
      'seller_name', mb.display_name,
      'sales_revenue_cents', v_revenue,
      'adjustments_cents', v_cash_adjustments,
      'expected_cash_cents_live', m.opening_cash_cents + v_revenue + v_cash_adjustments
    ) into v_meeting
    from buffet.meetings m join buffet.members mb on mb.user_id = m.seller_id
    where m.id = v_meeting_id;
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

create function public.buffet_sales_page(p_meeting_id uuid,
  p_before_created_at timestamptz, p_before_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select buffet.sales_page(p_meeting_id, p_before_created_at, p_before_id);
$$;

revoke execute on function buffet.sales_page(uuid, timestamptz, uuid)
  from public, anon, authenticated;
revoke execute on function public.buffet_sales_page(uuid, timestamptz, uuid)
  from public, anon;
grant execute on function buffet.sales_page(uuid, timestamptz, uuid)
  to authenticated;
grant execute on function public.buffet_sales_page(uuid, timestamptz, uuid)
  to authenticated;

notify pgrst, 'reload schema';
