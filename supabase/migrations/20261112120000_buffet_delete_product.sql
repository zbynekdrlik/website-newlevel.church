-- Hard deletion is limited to products with no financial or stock audit history.
-- The preview and delete use the same permission and dependency rules.
create function buffet.product_deletion_preview(p_product_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_product buffet.products%rowtype;
begin
  perform buffet.require_permission('manage_products');
  if p_product_id is null then raise exception 'Skontrolujte produkt.'; end if;
  select * into v_product from buffet.products where id = p_product_id;
  if not found then raise exception 'Produkt neexistuje.'; end if;

  return jsonb_build_object(
    'name', v_product.name,
    'stock_quantity', v_product.stock_quantity,
    'photo_path', v_product.photo_path,
    'state', md5(to_jsonb(v_product)::text),
    'sales_count', (select count(*) from buffet.sales where product_id = p_product_id),
    'restocks_count', (select count(*) from buffet.restocks where product_id = p_product_id),
    'adjustments_count', (select count(*) from buffet.stock_adjustments where product_id = p_product_id)
  );
end;
$$;

create function buffet.delete_product(
  p_product_id uuid, p_expected_state text
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_product buffet.products%rowtype;
begin
  perform buffet.require_permission('manage_products');
  if p_product_id is null or p_expected_state is null then
    raise exception 'Skontrolujte produkt.';
  end if;
  select * into v_product from buffet.products where id = p_product_id for update;
  if not found then raise exception 'Produkt neexistuje.'; end if;
  if md5(to_jsonb(v_product)::text) is distinct from p_expected_state then
    raise exception 'Produkt sa zmenil. Obnovte prehľad pred vymazaním.';
  end if;
  if exists (select 1 from buffet.sales where product_id = p_product_id)
      or exists (select 1 from buffet.restocks where product_id = p_product_id)
      or exists (select 1 from buffet.stock_adjustments where product_id = p_product_id) then
    raise exception 'Produkt má históriu predaja alebo skladu. Namiesto vymazania ho skryte.';
  end if;
  delete from buffet.products where id = p_product_id;
  return v_product.photo_path;
end;
$$;

create function public.buffet_product_deletion_preview(p_product_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$
  select buffet.product_deletion_preview(p_product_id);
$$;
create function public.buffet_delete_product(
  p_product_id uuid, p_expected_state text
) returns text language sql security invoker set search_path = '' as $$
  select buffet.delete_product(p_product_id, p_expected_state);
$$;

revoke execute on function buffet.product_deletion_preview(uuid) from public, anon, authenticated;
revoke execute on function buffet.delete_product(uuid, text) from public, anon, authenticated;
revoke execute on function public.buffet_product_deletion_preview(uuid) from public, anon, authenticated;
revoke execute on function public.buffet_delete_product(uuid, text) from public, anon, authenticated;
grant execute on function buffet.product_deletion_preview(uuid) to authenticated;
grant execute on function buffet.delete_product(uuid, text) to authenticated;
grant execute on function public.buffet_product_deletion_preview(uuid) to authenticated;
grant execute on function public.buffet_delete_product(uuid, text) to authenticated;

notify pgrst, 'reload schema';
