-- Keep signed stock changes separate from historical, positive-only restocks.
-- Every adjustment records its actor and reason; sales retain their own ledger.
create table buffet.stock_adjustments (
  id uuid primary key,
  product_id uuid not null references buffet.products(id),
  quantity_change integer not null check (
    quantity_change between -1000000 and 1000000 and quantity_change <> 0
  ),
  note text not null check (char_length(trim(note)) between 1 and 200),
  actor_id uuid not null references buffet.members(user_id),
  created_at timestamptz not null default now()
);
create index stock_adjustments_product_created
  on buffet.stock_adjustments (product_id, created_at desc);
alter table buffet.stock_adjustments enable row level security;
revoke all on buffet.stock_adjustments from public, anon, authenticated;

create function buffet.adjust_stock(
  p_adjustment_id uuid, p_product_id uuid, p_delta integer, p_note text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_inserted uuid;
  v_existing buffet.stock_adjustments%rowtype;
  v_product buffet.products%rowtype;
begin
  perform buffet.require_permission('restock');
  if p_adjustment_id is null or p_product_id is null or p_delta is null
      or p_delta not between -1000000 and 1000000 or p_delta = 0
      or char_length(trim(coalesce(p_note, ''))) not between 1 and 200 then
    raise exception 'Skontrolujte množstvo a dôvod úpravy zásob.';
  end if;

  -- Claim the request ID before changing stock. Concurrent retries wait for
  -- the first transaction and cannot apply the same change twice.
  insert into buffet.stock_adjustments
    (id, product_id, quantity_change, note, actor_id)
    values (p_adjustment_id, p_product_id, p_delta, trim(p_note), auth.uid())
    on conflict (id) do nothing returning id into v_inserted;
  if v_inserted is null then
    select * into v_existing from buffet.stock_adjustments where id = p_adjustment_id;
    if v_existing.product_id = p_product_id
        and v_existing.quantity_change = p_delta
        and v_existing.note = trim(p_note)
        and v_existing.actor_id = auth.uid() then
      return p_adjustment_id;
    end if;
    raise exception 'Požiadavka na úpravu zásob už bola použitá.';
  end if;

  -- Sales, reversals, cancellation and restocks also lock this product row.
  select * into v_product from buffet.products where id = p_product_id for update;
  if not found then raise exception 'Produkt neexistuje.'; end if;
  if not v_product.track_stock then
    raise exception 'Produkt nemá zapnuté sledovanie zásob.';
  end if;
  if v_product.stock_quantity + p_delta not between 0 and 1000000 then
    raise exception 'Úprava by vytvorila neplatný stav skladu.';
  end if;
  update buffet.products set stock_quantity = stock_quantity + p_delta
    where id = p_product_id;
  return p_adjustment_id;
end;
$$;

create function public.buffet_adjust_stock(
  p_adjustment_id uuid, p_product_id uuid, p_delta integer, p_note text
) returns uuid language sql security invoker set search_path = '' as $$
  select buffet.adjust_stock(p_adjustment_id, p_product_id, p_delta, p_note);
$$;
revoke execute on function buffet.adjust_stock(uuid, uuid, integer, text)
  from public, anon, authenticated;
revoke execute on function public.buffet_adjust_stock(uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function buffet.adjust_stock(uuid, uuid, integer, text)
  to authenticated;
grant execute on function public.buffet_adjust_stock(uuid, uuid, integer, text)
  to authenticated;

notify pgrst, 'reload schema';
