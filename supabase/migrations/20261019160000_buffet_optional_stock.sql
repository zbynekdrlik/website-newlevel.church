-- Prepared products can be sold without consuming item stock. Existing products
-- and historical sales retain stock tracking until an operator changes a product.
alter table buffet.products add column track_stock boolean not null default true;
alter table buffet.sales add column stock_tracked boolean not null default true;

-- Keep the eight-argument RPC available for older clients/imports. Its existing
-- upsert preserves track_stock on updates and defaults to true on new products.
-- No default on the ninth argument: PostgREST can distinguish the two signatures.
create function buffet.save_product_details(p_product_id uuid, p_name text,
  p_price_cents integer, p_minimum_stock integer, p_target_stock integer,
  p_active boolean, p_category_id uuid, p_photo_path text, p_track_stock boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform buffet.require_permission('manage_products');
  if p_track_stock is null then raise exception 'Skontrolujte sledovanie zásob produktu.'; end if;
  perform buffet.save_product_details(p_product_id, p_name, p_price_cents,
    p_minimum_stock, p_target_stock, p_active, p_category_id, p_photo_path);
  update buffet.products set track_stock = p_track_stock where id = p_product_id;
  return p_product_id;
end;
$$;

create function public.buffet_save_product_details(p_product_id uuid, p_name text,
  p_price_cents integer, p_minimum_stock integer, p_target_stock integer,
  p_active boolean, p_category_id uuid, p_photo_path text, p_track_stock boolean) returns uuid
language sql security invoker set search_path = '' as $$
  select buffet.save_product_details(p_product_id, p_name, p_price_cents,
    p_minimum_stock, p_target_stock, p_active, p_category_id, p_photo_path, p_track_stock);
$$;

revoke execute on function buffet.save_product_details(uuid, text, integer, integer, integer, boolean, uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.buffet_save_product_details(uuid, text, integer, integer, integer, boolean, uuid, text, boolean) from public, anon, authenticated;
grant execute on function buffet.save_product_details(uuid, text, integer, integer, integer, boolean, uuid, text, boolean) to authenticated;
grant execute on function public.buffet_save_product_details(uuid, text, integer, integer, integer, boolean, uuid, text, boolean) to authenticated;

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
  -- The product row lock also serializes a concurrent tracking-mode change.
  update buffet.products
    set stock_quantity = case when track_stock then stock_quantity - p_quantity else stock_quantity end
    where id = p_product_id and active and (not track_stock or stock_quantity >= p_quantity)
    returning * into v_product;
  if not found then
    raise exception 'Produkt nie je dostupný alebo nemá dostatok kusov.';
  end if;
  insert into buffet.sales (id, meeting_id, product_id, product_name, quantity, unit_price_cents, seller_id, stock_tracked)
    values (p_sale_id, p_meeting_id, p_product_id, v_product.name, p_quantity,
      v_product.price_cents, auth.uid(), v_product.track_stock);
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
  -- Restore only stock actually consumed by this sale, regardless of today's mode.
  if v_sale.stock_tracked then
    update buffet.products set stock_quantity = stock_quantity + v_sale.quantity where id = v_sale.product_id;
  end if;
  update buffet.sales set reversed_at = now(), reversed_by = auth.uid() where id = p_sale_id;
end;
$$;

create or replace function buffet.restock(p_restock_id uuid, p_product_id uuid, p_quantity integer, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_existing buffet.restocks%rowtype; v_product buffet.products%rowtype;
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
  select * into v_product from buffet.products where id = p_product_id for update;
  if not found then raise exception 'Produkt neexistuje alebo je prekročený limit skladu.'; end if;
  if not v_product.track_stock then raise exception 'Produkt nemá zapnuté sledovanie zásob.'; end if;
  update buffet.products set stock_quantity = stock_quantity + p_quantity
    where id = p_product_id and stock_quantity <= 1000000 - p_quantity;
  if not found then raise exception 'Produkt neexistuje alebo je prekročený limit skladu.'; end if;
  insert into buffet.restocks (id, product_id, quantity, note, actor_id)
    values (p_restock_id, p_product_id, p_quantity, trim(p_note), auth.uid());
  return p_restock_id;
end;
$$;

notify pgrst, 'reload schema';
