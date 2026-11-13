-- Rank available products by units sold in the last 30 days. The existing
-- snapshot RPC carries the ordered IDs so the full catalog can use the ranking.
create index sales_recent_popularity
  on buffet.sales (created_at desc, product_id)
  include (quantity, meeting_id)
  where reversed_at is null;

create or replace function buffet.snapshot_catalog() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_snapshot jsonb;
  v_categories jsonb;
  v_top_products jsonb;
begin
  -- snapshot() checks active membership before any catalog or sales are read.
  v_snapshot := buffet.snapshot();
  select coalesce(jsonb_agg(to_jsonb(c) order by c.name), '[]'::jsonb)
    into v_categories from buffet.categories c;
  select coalesce(jsonb_agg(r.product_id order by r.units desc, r.name, r.product_id),
    '[]'::jsonb) into v_top_products
  from (
    select p.id as product_id, p.name, sum(s.quantity::bigint) as units
    from buffet.sales s
    join buffet.meetings m on m.id = s.meeting_id
    join buffet.products p on p.id = s.product_id
    where s.created_at >= now() - interval '30 days'
      and s.reversed_at is null
      and m.cancelled_at is null
      and p.active
      and (not p.track_stock or p.stock_quantity > 0)
    group by p.id
    order by units desc, p.name, p.id
  ) r;
  return v_snapshot || jsonb_build_object(
    'categories', v_categories, 'top_products', v_top_products);
end;
$$;

notify pgrst, 'reload schema';
