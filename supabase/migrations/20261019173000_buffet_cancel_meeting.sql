-- Cancel mistaken/test meetings without deleting the audit trail. A cancelled
-- meeting is terminal, excluded from reports, and can never be reopened.
alter table buffet.meetings
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references buffet.members(user_id),
  add constraint meetings_cancellation_state check (
    (cancelled_at is null and cancelled_by is null)
    or (cancelled_at is not null and cancelled_by is not null
      and closed_at is not null and expected_cash_cents = 0 and actual_cash_cents = 0)
  );

create function buffet.cancel_meeting(p_meeting_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_meeting buffet.meetings%rowtype; v_stock record;
begin
  perform buffet.require_admin();
  -- Same lock order as sales, reversals, cash adjustments and closing. A sale
  -- either commits before cancellation (and is undone) or sees a closed meeting.
  select * into v_meeting from buffet.meetings where id = p_meeting_id for update;
  if not found then raise exception 'Stretnutie neexistuje.'; end if;
  if v_meeting.cancelled_at is not null then return; end if;
  if v_meeting.closed_at is not null then
    raise exception 'Stretnutie už bolo uzavreté. Zrušiť možno iba otvorené stretnutie.';
  end if;

  -- Restore only inventory actually consumed, once per product in stable lock
  -- order. Preserve intervening restocks and product tracking-mode changes.
  for v_stock in
    select s.product_id, sum(s.quantity) as quantity
    from buffet.sales s
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
  -- Keep original opening cash, sales, and cash adjustments for audit. Zero
  -- closing totals are terminal placeholders, not a counted-cash reconciliation.
  update buffet.meetings set cancelled_at = now(), cancelled_by = auth.uid(),
    closed_at = now(), expected_cash_cents = 0, actual_cash_cents = 0
    where id = p_meeting_id;
end;
$$;

create function public.buffet_cancel_meeting(p_meeting_id uuid) returns void
language sql security invoker set search_path = '' as $$
  select buffet.cancel_meeting(p_meeting_id);
$$;
revoke execute on function buffet.cancel_meeting(uuid) from public, anon, authenticated;
revoke execute on function public.buffet_cancel_meeting(uuid) from public, anon, authenticated;
grant execute on function buffet.cancel_meeting(uuid) to authenticated;
grant execute on function public.buffet_cancel_meeting(uuid) to authenticated;

-- A stale tab must not report a cancelled meeting as successfully reconciled,
-- even when its submitted cash count matches the cancellation's zero marker.
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

-- Filter cancelled meetings before the limit so they cannot hide real history.
-- The catalogue/permission wrapper remains unchanged.
create or replace function buffet.snapshot() returns jsonb
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
      where m.closed_at is not null and m.cancelled_at is null order by m.closed_at desc limit 12
    ) x;
  return jsonb_build_object('member', v_member, 'products', v_products,
    'active_meeting', v_meeting, 'sales', v_sales,
    'cash_adjustments', v_adjustments, 'recent_meetings', v_recent);
end;
$$;

notify pgrst, 'reload schema';
