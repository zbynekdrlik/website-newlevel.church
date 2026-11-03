-- A customer purchase is one atomic, replay-safe group of sale lines.
create table buffet.purchases (
  id uuid primary key,
  meeting_id uuid not null references buffet.meetings(id),
  seller_id uuid not null references buffet.members(user_id),
  request_items jsonb not null,
  expected_total_cents bigint not null check (expected_total_cents between 0 and 100000000000),
  created_at timestamptz not null default now()
);
alter table buffet.purchases enable row level security;
revoke all on buffet.purchases from public, anon, authenticated;

alter table buffet.sales add column purchase_id uuid references buffet.purchases(id);
create index sales_purchase_id on buffet.sales (purchase_id) where purchase_id is not null;

create function buffet.record_purchase(p_purchase_id uuid, p_meeting_id uuid,
  p_items jsonb, p_expected_total_cents bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_meeting buffet.meetings%rowtype;
  v_existing buffet.purchases%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_quantity integer;
  v_seen uuid[] := '{}';
  v_sale_id uuid;
  v_line buffet.sales%rowtype;
  v_total bigint := 0;
begin
  perform buffet.require_permission('sell');
  if p_purchase_id is null or p_meeting_id is null
      or p_expected_total_cents is null or p_expected_total_cents not between 0 and 100000000000
      or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Skontrolujte položky nákupu.';
  end if;
  if jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Skontrolujte položky nákupu.';
  end if;
  select * into v_meeting from buffet.meetings where id = p_meeting_id for update;
  if not found then raise exception 'Stretnutie neexistuje.'; end if;
  select * into v_existing from buffet.purchases where id = p_purchase_id;
  if found then
    if v_existing.meeting_id = p_meeting_id and v_existing.seller_id = auth.uid()
        and v_existing.request_items = p_items
        and v_existing.expected_total_cents = p_expected_total_cents then
      return p_purchase_id;
    end if;
    raise exception 'Požiadavka na nákup už bola použitá.';
  end if;
  if v_meeting.closed_at is not null then raise exception 'Stretnutie nie je otvorené.'; end if;

  -- Reject malformed and repeated lines before touching inventory.
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception 'Skontrolujte položky nákupu.';
    end if;
    if v_item - 'product_id' - 'quantity' <> '{}'::jsonb
        or jsonb_typeof(v_item->'product_id') is distinct from 'string'
        or (v_item->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(v_item->'quantity') is distinct from 'number'
        or (v_item->>'quantity') !~ '^[0-9]{1,2}$' then
      raise exception 'Skontrolujte položky nákupu.';
    end if;
    v_product_id := (v_item->>'product_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    if v_quantity not between 1 and 99 or v_product_id = any(v_seen) then
      raise exception 'Skontrolujte položky nákupu.';
    end if;
    v_seen := array_append(v_seen, v_product_id);
  end loop;

  insert into buffet.purchases (id, meeting_id, seller_id, request_items, expected_total_cents)
    values (p_purchase_id, p_meeting_id, auth.uid(), p_items, p_expected_total_cents);
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_sale_id := gen_random_uuid();
    perform buffet.record_sale(v_sale_id, p_meeting_id,
      (v_item->>'product_id')::uuid, (v_item->>'quantity')::integer);
    update buffet.sales set purchase_id = p_purchase_id where id = v_sale_id
      returning * into v_line;
    v_total := v_total + v_line.quantity::bigint * v_line.unit_price_cents;
  end loop;
  if v_total <> p_expected_total_cents then
    raise exception 'Ceny produktov sa zmenili. Obnovte stránku a vytvorte nákup znova.';
  end if;
  return p_purchase_id;
end;
$$;

create function buffet.reverse_purchase(p_purchase_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_purchase buffet.purchases%rowtype; v_sale record;
begin
  perform buffet.require_permission('sell');
  select * into v_purchase from buffet.purchases where id = p_purchase_id;
  if not found then raise exception 'Nákup neexistuje.'; end if;
  -- reverse_sale takes this same meeting lock and verifies cash and stock.
  perform 1 from buffet.meetings where id = v_purchase.meeting_id for update;
  for v_sale in select id from buffet.sales where purchase_id = p_purchase_id order by id loop
    perform buffet.reverse_sale(v_sale.id);
  end loop;
end;
$$;

create function public.buffet_record_purchase(p_purchase_id uuid, p_meeting_id uuid,
  p_items jsonb, p_expected_total_cents bigint) returns uuid
language sql security invoker set search_path = '' as $$
  select buffet.record_purchase(p_purchase_id, p_meeting_id, p_items, p_expected_total_cents);
$$;
create function public.buffet_reverse_purchase(p_purchase_id uuid) returns void
language sql security invoker set search_path = '' as $$
  select buffet.reverse_purchase(p_purchase_id);
$$;
revoke execute on function buffet.record_purchase(uuid, uuid, jsonb, bigint) from public, anon, authenticated;
revoke execute on function buffet.reverse_purchase(uuid) from public, anon, authenticated;
revoke execute on function public.buffet_record_purchase(uuid, uuid, jsonb, bigint) from public, anon, authenticated;
revoke execute on function public.buffet_reverse_purchase(uuid) from public, anon, authenticated;
grant execute on function buffet.record_purchase(uuid, uuid, jsonb, bigint) to authenticated;
grant execute on function buffet.reverse_purchase(uuid) to authenticated;
grant execute on function public.buffet_record_purchase(uuid, uuid, jsonb, bigint) to authenticated;
grant execute on function public.buffet_reverse_purchase(uuid) to authenticated;

notify pgrst, 'reload schema';
