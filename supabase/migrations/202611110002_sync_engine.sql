-- Estoque no Bolso — Fase 4: sincronização idempotente e operações offline.
-- Migração aditiva: NÃO substitui nem exige reaplicar a migração inicial da Fase 3.

-- Datas civis são guardadas separadamente dos instantes UTC para preservar o dia
-- escolhido no celular, independentemente do fuso usado pelo banco.
alter table public.products
  add column if not exists low_since_date date,
  add column if not exists last_purchase_date date;

alter table public.stock_movements
  add column if not exists occurred_on date,
  add column if not exists minimum_quantity_at_time numeric(14,3),
  add column if not exists entered_low boolean not null default false,
  add column if not exists left_low boolean not null default false,
  add column if not exists deleted_at timestamptz;

update public.stock_movements
set occurred_on = (occurred_at at time zone 'America/Sao_Paulo')::date
where occurred_on is null;

update public.products
set low_since_date = (low_since_at at time zone 'America/Sao_Paulo')::date
where low_since_date is null and low_since_at is not null;

update public.products
set last_purchase_date = (last_purchase_at at time zone 'America/Sao_Paulo')::date
where last_purchase_date is null and last_purchase_at is not null;

alter table public.trash add column if not exists client_id text;
create unique index if not exists trash_store_client_unique
  on public.trash(store_id, client_id) where client_id is not null;

alter table public.audit_logs
  add column if not exists client_id text,
  add column if not exists deleted_at timestamptz;
create unique index if not exists audit_logs_store_client_unique
  on public.audit_logs(store_id, client_id) where client_id is not null;
create index if not exists stock_movements_store_active_time_idx
  on public.stock_movements(store_id, occurred_at desc) where deleted_at is null;

-- A exclusão lógica dos eventos de auditoria precisa de UPDATE sob RLS.
drop policy if exists audit_logs_store_update on public.audit_logs;
create policy audit_logs_store_update on public.audit_logs
  for update to authenticated
  using ((select private.owns_store(store_id)))
  with check ((select private.owns_store(store_id)));
grant update on public.audit_logs to authenticated;

-- Cria/atualiza metadados sem sobrescrever a quantidade de um produto já existente.
-- A quantidade inicial só é aplicada no INSERT; movimentos posteriores usam RPC própria.
create or replace function public.sync_upsert_product(
  p_store_id uuid,
  p_client_id text,
  p_name text,
  p_unit text,
  p_quantity numeric,
  p_minimum_quantity numeric,
  p_cost_price numeric,
  p_sale_price numeric default 0,
  p_supplier_name text default null,
  p_supplier_phone text default null,
  p_low_since_date date default null,
  p_last_purchase_date date default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_product_id uuid;
begin
  if auth.uid() is null or not private.owns_store(p_store_id) then
    raise exception 'Acesso ao estabelecimento não autorizado.' using errcode = '42501';
  end if;
  if nullif(btrim(p_client_id), '') is null then
    raise exception 'Identificador local do produto obrigatório.' using errcode = '22023';
  end if;
  if nullif(btrim(p_name), '') is null then
    raise exception 'Nome do produto obrigatório.' using errcode = '22023';
  end if;

  insert into public.products(
    store_id, client_id, name, unit, quantity, minimum_quantity,
    cost_price, sale_price, supplier_name, supplier_phone,
    low_since_date, last_purchase_date, low_since_at, last_purchase_at
  ) values (
    p_store_id, p_client_id, left(btrim(p_name), 120), coalesce(p_unit, 'un'),
    greatest(coalesce(p_quantity, 0), 0), greatest(coalesce(p_minimum_quantity, 0), 0),
    greatest(coalesce(p_cost_price, 0), 0), greatest(coalesce(p_sale_price, 0), 0),
    nullif(left(btrim(coalesce(p_supplier_name, '')), 120), ''),
    nullif(left(btrim(coalesce(p_supplier_phone, '')), 30), ''),
    p_low_since_date, p_last_purchase_date,
    case when p_low_since_date is null then null else (p_low_since_date::timestamp at time zone 'America/Sao_Paulo') end,
    case when p_last_purchase_date is null then null else (p_last_purchase_date::timestamp at time zone 'America/Sao_Paulo') end
  )
  on conflict (store_id, client_id) do update set
    name = excluded.name,
    unit = excluded.unit,
    minimum_quantity = excluded.minimum_quantity,
    cost_price = excluded.cost_price,
    sale_price = excluded.sale_price,
    supplier_name = excluded.supplier_name,
    supplier_phone = excluded.supplier_phone,
    low_since_date = excluded.low_since_date,
    last_purchase_date = excluded.last_purchase_date,
    low_since_at = excluded.low_since_at,
    last_purchase_at = excluded.last_purchase_at,
    updated_at = now()
  where public.products.deleted_at is null
  returning id into v_product_id;

  if v_product_id is null then
    raise exception 'Este produto está na lixeira da nuvem. Restaure-o antes de sincronizar.' using errcode = 'P0002';
  end if;
  return v_product_id;
end;
$$;

-- Importa o histórico inicial sem alterar quantity: a quantidade atual já veio
-- no cadastro do produto. client_id e idempotency_key protegem reenvios parciais.
create or replace function public.sync_import_movement(
  p_store_id uuid,
  p_product_client_id text,
  p_movement_client_id text,
  p_operation_id uuid,
  p_movement_type text,
  p_quantity_delta numeric,
  p_quantity_before numeric,
  p_quantity_after numeric,
  p_occurred_at timestamptz,
  p_occurred_on date,
  p_minimum_quantity_at_time numeric default null,
  p_entered_low boolean default false,
  p_left_low boolean default false,
  p_note text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_product_id uuid;
begin
  if auth.uid() is null or not private.owns_store(p_store_id) then
    raise exception 'Acesso ao estabelecimento não autorizado.' using errcode = '42501';
  end if;
  select p.id into v_product_id
  from public.products p
  where p.store_id = p_store_id
    and p.client_id = p_product_client_id
    and p.deleted_at is null;
  if v_product_id is null then
    raise exception 'Produto não encontrado para importar o histórico.' using errcode = 'P0002';
  end if;

  insert into public.stock_movements(
    store_id, client_id, product_id, movement_type, quantity_delta,
    quantity_before, quantity_after, occurred_at, occurred_on,
    minimum_quantity_at_time, entered_low, left_low,
    idempotency_key, note, created_by
  ) values (
    p_store_id, p_movement_client_id, v_product_id, p_movement_type, p_quantity_delta,
    p_quantity_before, p_quantity_after, coalesce(p_occurred_at, now()),
    coalesce(p_occurred_on, (coalesce(p_occurred_at, now()) at time zone 'America/Sao_Paulo')::date),
    p_minimum_quantity_at_time, coalesce(p_entered_low, false), coalesce(p_left_low, false),
    p_operation_id, left(p_note, 500), auth.uid()
  )
  on conflict do nothing;
  return found;
end;
$$;

create or replace function public.sync_import_status_event(
  p_store_id uuid,
  p_product_client_id text,
  p_event_client_id text,
  p_action text,
  p_details jsonb,
  p_occurred_at timestamptz default now()
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_product_id uuid;
begin
  if auth.uid() is null or not private.owns_store(p_store_id) then
    raise exception 'Acesso ao estabelecimento não autorizado.' using errcode = '42501';
  end if;
  if p_action not in ('stock_low', 'stock_normal') then
    raise exception 'Evento de estoque inválido.' using errcode = '22023';
  end if;
  select p.id into v_product_id
  from public.products p
  where p.store_id = p_store_id and p.client_id = p_product_client_id;
  if v_product_id is null then
    raise exception 'Produto do evento não encontrado.' using errcode = 'P0002';
  end if;
  insert into public.audit_logs(store_id, client_id, entity_type, entity_id, action, details, created_by, created_at)
  values (p_store_id, p_event_client_id, 'product', v_product_id, p_action,
          coalesce(p_details, '{}'::jsonb), auth.uid(), coalesce(p_occurred_at, now()))
  on conflict do nothing;
  return found;
end;
$$;

-- Aplica uma entrada/saída de forma transacional. Reenvios com o mesmo
-- operation_id ou movement_client_id retornam sem aplicar a quantidade de novo.
create or replace function public.apply_stock_movement(
  p_store_id uuid,
  p_product_client_id text,
  p_movement_client_id text,
  p_operation_id uuid,
  p_movement_type text,
  p_quantity_delta numeric,
  p_occurred_at timestamptz,
  p_occurred_on date,
  p_minimum_quantity_at_time numeric default null,
  p_note text default null
)
returns table(duplicate boolean, product_quantity numeric, movement_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_existing public.stock_movements%rowtype;
  v_before numeric(14,3);
  v_after numeric(14,3);
  v_entered_low boolean := false;
  v_left_low boolean := false;
  v_min numeric(14,3);
  v_movement_id uuid;
  v_occurred_on date;
begin
  if auth.uid() is null or not private.owns_store(p_store_id) then
    raise exception 'Acesso ao estabelecimento não autorizado.' using errcode = '42501';
  end if;
  if p_operation_id is null or nullif(btrim(p_movement_client_id), '') is null then
    raise exception 'Identificador idempotente da movimentação obrigatório.' using errcode = '22023';
  end if;
  if p_quantity_delta is null or p_quantity_delta = 0 then
    raise exception 'A quantidade da movimentação não pode ser zero.' using errcode = '22023';
  end if;
  if p_movement_type not in ('opening_balance','purchase_in','manual_in','sale_out','manual_out','inventory_loss','inventory_gain','reversal') then
    raise exception 'Tipo de movimentação inválido.' using errcode = '22023';
  end if;

  select m.* into v_existing
  from public.stock_movements m
  where m.store_id = p_store_id
    and (m.idempotency_key = p_operation_id or m.client_id = p_movement_client_id)
  limit 1;
  if found then
    return query select true, v_existing.quantity_after, v_existing.id;
    return;
  end if;

  select p.* into v_product
  from public.products p
  where p.store_id = p_store_id and p.client_id = p_product_client_id and p.deleted_at is null
  for update;
  if not found then
    raise exception 'Produto não encontrado ou excluído.' using errcode = 'P0002';
  end if;

  -- Revalida após o lock para cobrir duas requisições concorrentes do mesmo evento.
  select m.* into v_existing
  from public.stock_movements m
  where m.store_id = p_store_id
    and (m.idempotency_key = p_operation_id or m.client_id = p_movement_client_id)
  limit 1;
  if found then
    return query select true, v_existing.quantity_after, v_existing.id;
    return;
  end if;

  v_before := v_product.quantity;
  v_after := v_before + p_quantity_delta;
  if v_after < 0 then
    raise exception 'A movimentação deixaria o estoque negativo. Atualize o estoque e tente novamente.' using errcode = '23514';
  end if;
  v_min := coalesce(p_minimum_quantity_at_time, v_product.minimum_quantity);
  v_entered_low := v_before >= v_min and v_after < v_min;
  v_left_low := v_before < v_min and v_after >= v_min;
  v_occurred_on := coalesce(p_occurred_on, (coalesce(p_occurred_at, now()) at time zone 'America/Sao_Paulo')::date);

  update public.products p set
    quantity = v_after,
    low_since_at = case
      when v_entered_low then (v_occurred_on::timestamp at time zone 'America/Sao_Paulo')
      when v_left_low then null
      else p.low_since_at
    end,
    low_since_date = case
      when v_entered_low then v_occurred_on
      when v_left_low then null
      else p.low_since_date
    end,
    last_purchase_at = case when p_quantity_delta > 0 then coalesce(p_occurred_at, now()) else p.last_purchase_at end,
    last_purchase_date = case when p_quantity_delta > 0 then v_occurred_on else p.last_purchase_date end,
    updated_at = now()
  where p.id = v_product.id;

  insert into public.stock_movements(
    store_id, client_id, product_id, movement_type, quantity_delta,
    quantity_before, quantity_after, occurred_at, occurred_on,
    minimum_quantity_at_time, entered_low, left_low,
    idempotency_key, note, created_by
  ) values (
    p_store_id, p_movement_client_id, v_product.id, p_movement_type, p_quantity_delta,
    v_before, v_after, coalesce(p_occurred_at, now()), v_occurred_on,
    v_min, v_entered_low, v_left_low, p_operation_id, left(p_note, 500), auth.uid()
  ) returning id into v_movement_id;

  return query select false, v_after, v_movement_id;
end;
$$;

-- Exclusão lógica do produto; movimentos antigos permanecem para auditoria.
create or replace function public.soft_delete_product(
  p_store_id uuid,
  p_product_client_id text,
  p_operation_id uuid,
  p_snapshot jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
begin
  if auth.uid() is null or not private.owns_store(p_store_id) then
    raise exception 'Acesso ao estabelecimento não autorizado.' using errcode = '42501';
  end if;
  select p.* into v_product
  from public.products p
  where p.store_id = p_store_id and p.client_id = p_product_client_id
  for update;
  if not found then return false; end if;
  if v_product.deleted_at is not null then return true; end if;

  insert into public.trash(store_id, client_id, entity_type, entity_id, snapshot, created_by)
  values (p_store_id, 'delete-product:' || p_operation_id::text, 'product', v_product.id,
          coalesce(p_snapshot, '{}'::jsonb), auth.uid())
  on conflict do nothing;

  update public.products set deleted_at = now(), updated_at = now() where id = v_product.id;
  insert into public.audit_logs(store_id, client_id, entity_type, entity_id, action, details, created_by)
  values (p_store_id, 'delete-product:' || p_operation_id::text, 'product', v_product.id,
          'product_deleted', jsonb_build_object('client_id', p_product_client_id), auth.uid())
  on conflict do nothing;
  return true;
end;
$$;

-- Excluir movimentação que já foi sincronizada significa estorná-la, nunca apagá-la
-- fisicamente. A linha original recebe deleted_at; a reversão fica auditável.
create or replace function public.reverse_stock_movement(
  p_store_id uuid,
  p_movement_client_id text,
  p_operation_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_original public.stock_movements%rowtype;
  v_existing public.stock_movements%rowtype;
  v_product public.products%rowtype;
  v_after numeric(14,3);
  v_client_id text := 'reversal:' || p_operation_id::text;
  v_on date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if auth.uid() is null or not private.owns_store(p_store_id) then
    raise exception 'Acesso ao estabelecimento não autorizado.' using errcode = '42501';
  end if;
  select m.* into v_existing from public.stock_movements m
  where m.store_id = p_store_id and m.idempotency_key = p_operation_id limit 1;
  if found then return true; end if;

  select m.* into v_original from public.stock_movements m
  where m.store_id = p_store_id and m.client_id = p_movement_client_id
  for update;
  if not found then return false; end if;
  if v_original.deleted_at is not null then return true; end if;

  select p.* into v_product from public.products p
  where p.id = v_original.product_id and p.store_id = p_store_id and p.deleted_at is null
  for update;
  if not found then
    raise exception 'Produto relacionado à movimentação não está ativo.' using errcode = 'P0002';
  end if;

  v_after := v_product.quantity - v_original.quantity_delta;
  if v_after < 0 then
    raise exception 'O estorno deixaria o estoque negativo. Revise as movimentações posteriores.' using errcode = '23514';
  end if;

  update public.products p set
    quantity = v_after,
    low_since_at = case
      when v_product.quantity >= v_product.minimum_quantity and v_after < v_product.minimum_quantity
        then (v_on::timestamp at time zone 'America/Sao_Paulo')
      when v_product.quantity < v_product.minimum_quantity and v_after >= v_product.minimum_quantity then null
      else p.low_since_at end,
    low_since_date = case
      when v_product.quantity >= v_product.minimum_quantity and v_after < v_product.minimum_quantity then v_on
      when v_product.quantity < v_product.minimum_quantity and v_after >= v_product.minimum_quantity then null
      else p.low_since_date end,
    updated_at = now()
  where p.id = v_product.id;

  update public.stock_movements set deleted_at = now() where id = v_original.id;
  insert into public.stock_movements(
    store_id, client_id, product_id, movement_type, quantity_delta,
    quantity_before, quantity_after, occurred_at, occurred_on,
    minimum_quantity_at_time, entered_low, left_low, idempotency_key,
    reverses_movement_id, note, created_by
  ) values (
    p_store_id, v_client_id, v_original.product_id, 'reversal', -v_original.quantity_delta,
    v_product.quantity, v_after, now(), v_on, v_product.minimum_quantity,
    v_product.quantity >= v_product.minimum_quantity and v_after < v_product.minimum_quantity,
    v_product.quantity < v_product.minimum_quantity and v_after >= v_product.minimum_quantity,
    p_operation_id, v_original.id, 'Estorno de movimentação ' || v_original.client_id, auth.uid()
  ) on conflict do nothing;
  return true;
end;
$$;

create or replace function public.soft_delete_status_event(
  p_store_id uuid,
  p_event_client_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.owns_store(p_store_id) then
    raise exception 'Acesso ao estabelecimento não autorizado.' using errcode = '42501';
  end if;
  update public.audit_logs set deleted_at = now()
  where store_id = p_store_id and client_id = p_event_client_id and deleted_at is null;
  return found;
end;
$$;

-- Restringe a execução das RPCs à sessão autenticada.
revoke all on function public.sync_upsert_product(uuid,text,text,text,numeric,numeric,numeric,numeric,text,text,date,date) from public, anon;
revoke all on function public.sync_import_movement(uuid,text,text,uuid,text,numeric,numeric,numeric,timestamptz,date,numeric,boolean,boolean,text) from public, anon;
revoke all on function public.sync_import_status_event(uuid,text,text,text,jsonb,timestamptz) from public, anon;
revoke all on function public.apply_stock_movement(uuid,text,text,uuid,text,numeric,timestamptz,date,numeric,text) from public, anon;
revoke all on function public.soft_delete_product(uuid,text,uuid,jsonb) from public, anon;
revoke all on function public.reverse_stock_movement(uuid,text,uuid) from public, anon;
revoke all on function public.soft_delete_status_event(uuid,text) from public, anon;

grant execute on function public.sync_upsert_product(uuid,text,text,text,numeric,numeric,numeric,numeric,text,text,date,date) to authenticated;
grant execute on function public.sync_import_movement(uuid,text,text,uuid,text,numeric,numeric,numeric,timestamptz,date,numeric,boolean,boolean,text) to authenticated;
grant execute on function public.sync_import_status_event(uuid,text,text,text,jsonb,timestamptz) to authenticated;
grant execute on function public.apply_stock_movement(uuid,text,text,uuid,text,numeric,timestamptz,date,numeric,text) to authenticated;
grant execute on function public.soft_delete_product(uuid,text,uuid,jsonb) to authenticated;
grant execute on function public.reverse_stock_movement(uuid,text,uuid) to authenticated;
grant execute on function public.soft_delete_status_event(uuid,text) to authenticated;

-- Grants continuam sem DELETE direto pelo navegador. A sincronização usa as RPCs acima.
revoke delete on public.products, public.stock_movements, public.trash, public.audit_logs from anon, authenticated;
