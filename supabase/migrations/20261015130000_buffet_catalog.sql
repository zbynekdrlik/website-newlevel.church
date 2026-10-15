-- Buffet catalog extension. No existing product, sale, or invitation data is changed.
create table buffet.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 60),
  created_at timestamptz not null default now()
);
create unique index categories_name_unique on buffet.categories (lower(trim(name)));
alter table buffet.categories enable row level security;
revoke all on buffet.categories from public, anon, authenticated;

alter table buffet.products
  add column category_id uuid references buffet.categories(id) on delete restrict,
  add column photo_path text check (photo_path is null or char_length(photo_path) <= 150);
create index products_category_name on buffet.products (category_id, name);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('buffet-product-photos', 'buffet-product-photos', false, 5000000,
  array['image/jpeg', 'image/png', 'image/webp']::text[])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create function buffet.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from buffet.members where user_id = auth.uid());
$$;
create function buffet.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from buffet.members where user_id = auth.uid() and role = 'admin');
$$;
revoke execute on function buffet.is_member() from public, anon, authenticated;
revoke execute on function buffet.is_admin() from public, anon, authenticated;
grant execute on function buffet.is_member() to authenticated;
grant execute on function buffet.is_admin() to authenticated;

create policy "Buffet members read product photos" on storage.objects
  for select to authenticated using (
    bucket_id = 'buffet-product-photos' and buffet.is_member()
  );
create policy "Buffet admins upload product photos" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'buffet-product-photos' and buffet.is_admin()
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
  );
create policy "Buffet admins delete product photos" on storage.objects
  for delete to authenticated using (
    bucket_id = 'buffet-product-photos' and buffet.is_admin()
  );

create function buffet.create_category(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform buffet.require_admin();
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 60 then
    raise exception 'Skontrolujte názov kategórie.';
  end if;
  insert into buffet.categories(name) values (trim(p_name)) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'Kategória s týmto názvom už existuje.';
end;
$$;

create function buffet.save_product_details(p_product_id uuid, p_name text,
  p_price_cents integer, p_minimum_stock integer, p_target_stock integer,
  p_active boolean, p_category_id uuid, p_photo_path text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform buffet.require_admin();
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

create function buffet.snapshot_catalog() returns jsonb
language sql security definer set search_path = '' as $$
  select buffet.snapshot() || jsonb_build_object('categories',
    coalesce((select jsonb_agg(to_jsonb(c) order by c.name)
      from buffet.categories c), '[]'::jsonb));
$$;

create or replace function public.buffet_snapshot() returns jsonb
language sql security invoker set search_path = '' as $$
  select buffet.snapshot_catalog();
$$;
create function public.buffet_create_category(p_name text) returns uuid
language sql security invoker set search_path = '' as $$
  select buffet.create_category(p_name);
$$;
create function public.buffet_save_product_details(p_product_id uuid, p_name text,
  p_price_cents integer, p_minimum_stock integer, p_target_stock integer,
  p_active boolean, p_category_id uuid, p_photo_path text) returns uuid
language sql security invoker set search_path = '' as $$
  select buffet.save_product_details(p_product_id, p_name, p_price_cents,
    p_minimum_stock, p_target_stock, p_active, p_category_id, p_photo_path);
$$;

revoke execute on function buffet.create_category(text) from public, anon, authenticated;
revoke execute on function buffet.save_product_details(uuid, text, integer, integer, integer, boolean, uuid, text) from public, anon, authenticated;
revoke execute on function buffet.snapshot_catalog() from public, anon, authenticated;
revoke execute on function public.buffet_create_category(text) from public, anon;
revoke execute on function public.buffet_save_product_details(uuid, text, integer, integer, integer, boolean, uuid, text) from public, anon;
grant execute on function buffet.create_category(text) to authenticated;
grant execute on function buffet.save_product_details(uuid, text, integer, integer, integer, boolean, uuid, text) to authenticated;
grant execute on function buffet.snapshot_catalog() to authenticated;
grant execute on function public.buffet_create_category(text) to authenticated;
grant execute on function public.buffet_save_product_details(uuid, text, integer, integer, integer, boolean, uuid, text) to authenticated;
