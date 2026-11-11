-- Estoque no Bolso: Fase 3 / estrutura inicial Supabase.
-- Aplicar no SQL Editor do projeto Supabase antes de configurar o app.
-- Todas as tabelas expostas usam RLS. DELETE direto pelo cliente não é concedido.

create schema if not exists private;

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id text not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  sku text,
  barcode text,
  unit text not null default 'un' check (unit in ('un','kg','g','L','ml','cx','pct','fardo')),
  quantity numeric(14,3) not null default 0 check (quantity >= 0),
  minimum_quantity numeric(14,3) not null default 0 check (minimum_quantity >= 0),
  cost_price numeric(14,2) not null default 0 check (cost_price >= 0),
  sale_price numeric(14,2) not null default 0 check (sale_price >= 0),
  supplier_name text,
  supplier_phone text,
  low_since_at timestamptz,
  last_purchase_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, client_id)
);
create unique index if not exists products_store_sku_unique
  on public.products(store_id, sku) where sku is not null and deleted_at is null;
create unique index if not exists products_store_barcode_unique
  on public.products(store_id, barcode) where barcode is not null and deleted_at is null;
create index if not exists products_store_active_idx on public.products(store_id, deleted_at, name);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id text not null,
  supplier_name text,
  supplier_phone text,
  status text not null default 'draft' check (status in ('draft','sent','partially_received','received','cancelled')),
  ordered_at timestamptz not null default now(),
  expected_at timestamptz,
  received_at timestamptz,
  notes text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, client_id)
);
create index if not exists purchases_store_status_idx on public.purchases(store_id, status, ordered_at desc);

create table if not exists public.purchase_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  client_id text not null,
  purchase_id uuid not null,
  product_id uuid,
  product_name text not null,
  unit text not null default 'un',
  requested_quantity numeric(14,3) not null default 0 check (requested_quantity >= 0),
  received_quantity numeric(14,3) not null default 0 check (received_quantity >= 0),
  unit_cost numeric(14,2) not null default 0 check (unit_cost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, client_id),
  foreign key (store_id, purchase_id) references public.purchases(store_id, id) on delete cascade,
  foreign key (store_id, product_id) references public.products(store_id, id) on delete restrict
);
create index if not exists purchase_items_purchase_idx on public.purchase_items(store_id, purchase_id);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  client_id text not null,
  product_id uuid not null,
  purchase_id uuid,
  movement_type text not null check (movement_type in ('opening_balance','purchase_in','manual_in','sale_out','manual_out','inventory_loss','inventory_gain','reversal')),
  quantity_delta numeric(14,3) not null check (quantity_delta <> 0),
  quantity_before numeric(14,3) not null check (quantity_before >= 0),
  quantity_after numeric(14,3) not null check (quantity_after >= 0),
  occurred_at timestamptz not null default now(),
  note text,
  idempotency_key uuid,
  reverses_movement_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users(id),
  unique (store_id, id),
  unique (store_id, client_id),
  foreign key (store_id, product_id) references public.products(store_id, id) on delete restrict,
  foreign key (store_id, purchase_id) references public.purchases(store_id, id) on delete restrict,
  foreign key (store_id, reverses_movement_id) references public.stock_movements(store_id, id) on delete restrict
);
create unique index if not exists stock_movements_idempotency_unique
  on public.stock_movements(store_id, idempotency_key) where idempotency_key is not null;
create index if not exists stock_movements_product_time_idx on public.stock_movements(store_id, product_id, occurred_at desc);

create table if not exists public.inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id text not null,
  status text not null default 'draft' check (status in ('draft','counting','completed','cancelled')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, client_id)
);

create table if not exists public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  client_id text not null,
  session_id uuid not null,
  product_id uuid not null,
  expected_quantity numeric(14,3) not null check (expected_quantity >= 0),
  counted_quantity numeric(14,3) check (counted_quantity is null or counted_quantity >= 0),
  difference numeric(14,3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, client_id),
  foreign key (store_id, session_id) references public.inventory_sessions(store_id, id) on delete cascade,
  foreign key (store_id, product_id) references public.products(store_id, id) on delete restrict
);

-- Lixeira guarda o snapshot para restauração. O purge futuro será controlado no servidor.
create table if not exists public.trash (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  entity_type text not null check (entity_type in ('product','purchase','purchase_item','stock_movement','inventory_session')),
  entity_id uuid not null,
  snapshot jsonb not null,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  restored_at timestamptz,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists trash_store_expiry_idx on public.trash(store_id, expires_at) where restored_at is null;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_store_time_idx on public.audit_logs(store_id, created_at desc);

-- Helper de RLS: security definer, search_path vazio e nomes qualificados.
create or replace function private.owns_store(p_store_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.stores s
    where s.id = p_store_id and s.owner_id = (select auth.uid())
  );
$$;
revoke all on function private.owns_store(uuid) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.owns_store(uuid) to authenticated;

-- Um estabelecimento por conta. Chamadas repetidas retornam o mesmo ID.
create or replace function public.create_my_store(p_name text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_store_id uuid;
  v_store_name text := coalesce(nullif(btrim(p_name), ''), 'Meu comércio');
begin
  if v_user_id is null then
    raise exception 'Autenticação necessária.' using errcode = '28000';
  end if;
  insert into public.stores(owner_id, name)
  values (v_user_id, left(v_store_name, 80))
  on conflict (owner_id) do nothing;
  select s.id into v_store_id from public.stores s where s.owner_id = v_user_id;
  return v_store_id;
end;
$$;
revoke all on function public.create_my_store(text) from public, anon;
grant execute on function public.create_my_store(text) to authenticated;

-- Atualização automática dos timestamps.
create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at = now(); return new; end; $$;

-- RLS em todas as tabelas públicas.
alter table public.stores enable row level security;
alter table public.products enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.stock_movements enable row level security;
alter table public.inventory_sessions enable row level security;
alter table public.inventory_counts enable row level security;
alter table public.trash enable row level security;
alter table public.audit_logs enable row level security;

create policy stores_owner_select on public.stores for select to authenticated
  using (owner_id = (select auth.uid()));
create policy stores_owner_update on public.stores for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, update on public.stores to authenticated;

-- Políticas de isolamento por store_id. O cliente não recebe privilégio DELETE.
create policy products_store_select on public.products for select to authenticated using ((select private.owns_store(store_id)));
create policy products_store_insert on public.products for insert to authenticated with check ((select private.owns_store(store_id)));
create policy products_store_update on public.products for update to authenticated using ((select private.owns_store(store_id))) with check ((select private.owns_store(store_id)));
grant select, insert, update on public.products to authenticated;

create policy purchases_store_select on public.purchases for select to authenticated using ((select private.owns_store(store_id)));
create policy purchases_store_insert on public.purchases for insert to authenticated with check ((select private.owns_store(store_id)));
create policy purchases_store_update on public.purchases for update to authenticated using ((select private.owns_store(store_id))) with check ((select private.owns_store(store_id)));
grant select, insert, update on public.purchases to authenticated;

create policy purchase_items_store_select on public.purchase_items for select to authenticated using ((select private.owns_store(store_id)));
create policy purchase_items_store_insert on public.purchase_items for insert to authenticated with check ((select private.owns_store(store_id)));
create policy purchase_items_store_update on public.purchase_items for update to authenticated using ((select private.owns_store(store_id))) with check ((select private.owns_store(store_id)));
grant select, insert, update on public.purchase_items to authenticated;

create policy movements_store_select on public.stock_movements for select to authenticated using ((select private.owns_store(store_id)));
create policy movements_store_insert on public.stock_movements for insert to authenticated with check ((select private.owns_store(store_id)));
create policy movements_store_update on public.stock_movements for update to authenticated using ((select private.owns_store(store_id))) with check ((select private.owns_store(store_id)));
grant select, insert, update on public.stock_movements to authenticated;

create policy inventory_sessions_store_select on public.inventory_sessions for select to authenticated using ((select private.owns_store(store_id)));
create policy inventory_sessions_store_insert on public.inventory_sessions for insert to authenticated with check ((select private.owns_store(store_id)));
create policy inventory_sessions_store_update on public.inventory_sessions for update to authenticated using ((select private.owns_store(store_id))) with check ((select private.owns_store(store_id)));
grant select, insert, update on public.inventory_sessions to authenticated;

create policy inventory_counts_store_select on public.inventory_counts for select to authenticated using ((select private.owns_store(store_id)));
create policy inventory_counts_store_insert on public.inventory_counts for insert to authenticated with check ((select private.owns_store(store_id)));
create policy inventory_counts_store_update on public.inventory_counts for update to authenticated using ((select private.owns_store(store_id))) with check ((select private.owns_store(store_id)));
grant select, insert, update on public.inventory_counts to authenticated;

create policy trash_store_select on public.trash for select to authenticated using ((select private.owns_store(store_id)));
create policy trash_store_insert on public.trash for insert to authenticated with check ((select private.owns_store(store_id)));
create policy trash_store_update on public.trash for update to authenticated using ((select private.owns_store(store_id))) with check ((select private.owns_store(store_id)));
grant select, insert, update on public.trash to authenticated;

create policy audit_logs_store_select on public.audit_logs for select to authenticated using ((select private.owns_store(store_id)));
create policy audit_logs_store_insert on public.audit_logs for insert to authenticated with check ((select private.owns_store(store_id)));
grant select, insert on public.audit_logs to authenticated;

-- A função RPC cria stores; acesso anônimo às tabelas é explicitamente revogado.
revoke all on public.stores, public.products, public.purchases, public.purchase_items,
  public.stock_movements, public.inventory_sessions, public.inventory_counts,
  public.trash, public.audit_logs from anon;

-- Triggers de updated_at.
do $$
declare tbl text;
begin
  foreach tbl in array array['stores','products','purchases','purchase_items','inventory_sessions','inventory_counts'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', tbl);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()', tbl);
  end loop;
end $$;
