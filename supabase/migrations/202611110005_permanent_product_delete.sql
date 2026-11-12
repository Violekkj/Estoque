-- Estoque no Bolso — Fase 5.2: exclusão definitiva e controlada de produtos.
-- Aplicar DEPOIS de 202611110004_trash_restore.sql.
-- Exclusão física só é permitida sem dependências; movimentos, estornos,
-- itens de compras e contagens de inventário nunca são apagados por este fluxo.

create or replace function private.permanently_delete_product_from_trash(
  p_store_id uuid,
  p_trash_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trash public.trash%rowtype;
  v_product public.products%rowtype;
  v_client_id text := 'purge-product:' || p_trash_id::text;
begin
  if auth.uid() is null or not private.owns_store(p_store_id) then
    raise exception 'Acesso ao estabelecimento não autorizado.'
      using errcode = '42501';
  end if;

  -- Permite repetir a mesma chamada caso a resposta da rede se perca após o commit.
  if exists (
    select 1
    from public.audit_logs a
    where a.store_id = p_store_id
      and a.client_id = v_client_id
      and a.action = 'product_permanently_deleted'
  ) then
    return true;
  end if;

  select t.* into v_trash
  from public.trash t
  where t.id = p_trash_id
    and t.store_id = p_store_id
    and t.entity_type = 'product'
  for update;

  if not found then
    -- Outra chamada simultânea pode ter concluído a mesma exclusão enquanto aguardávamos o lock.
    if exists (
      select 1 from public.audit_logs a
      where a.store_id = p_store_id
        and a.client_id = v_client_id
        and a.action = 'product_permanently_deleted'
    ) then
      return true;
    end if;
    raise exception 'Produto não encontrado na Lixeira.'
      using errcode = 'P0002';
  end if;

  if v_trash.restored_at is not null then
    raise exception 'Este produto já foi restaurado e não pode ser removido pela Lixeira.'
      using errcode = '22023';
  end if;

  select p.* into v_product
  from public.products p
  where p.id = v_trash.entity_id
    and p.store_id = p_store_id
  for update;

  if not found then
    raise exception 'O registro original do produto não foi encontrado. A Lixeira foi preservada para verificação.'
      using errcode = 'P0002';
  end if;

  if v_product.deleted_at is null then
    raise exception 'Este produto não está excluído. Atualize a Lixeira antes de continuar.'
      using errcode = '22023';
  end if;

  -- Todos os registros históricos são considerados, inclusive movimentações estornadas.
  if exists (
    select 1 from public.stock_movements m
    where m.store_id = p_store_id and m.product_id = v_product.id
  ) then
    raise exception 'Não é possível excluir definitivamente: existem movimentações ou estornos vinculados. O histórico precisa ser preservado.'
      using errcode = '23503';
  end if;

  if exists (
    select 1 from public.purchase_items pi
    where pi.store_id = p_store_id and pi.product_id = v_product.id
  ) then
    raise exception 'Não é possível excluir definitivamente: existem itens de compras vinculados ao produto.'
      using errcode = '23503';
  end if;

  if exists (
    select 1 from public.inventory_counts ic
    where ic.store_id = p_store_id and ic.product_id = v_product.id
  ) then
    raise exception 'Não é possível excluir definitivamente: existem contagens de inventário vinculadas ao produto.'
      using errcode = '23503';
  end if;

  -- Registro de auditoria sem FK para products: a rastreabilidade da ação permanece.
  insert into public.audit_logs(
    store_id, client_id, entity_type, entity_id, action, details, created_by
  ) values (
    p_store_id,
    v_client_id,
    'product',
    v_product.id,
    'product_permanently_deleted',
    jsonb_build_object(
      'product_name', v_product.name,
      'trash_id', p_trash_id,
      'dependency_check', 'passed'
    ),
    auth.uid()
  )
  on conflict do nothing;

  delete from public.products
  where id = v_product.id and store_id = p_store_id;

  delete from public.trash
  where id = p_trash_id and store_id = p_store_id;

  return true;
exception
  when foreign_key_violation then
    raise exception 'Não é possível excluir definitivamente: existe um registro vinculado ao produto. O histórico foi preservado.'
      using errcode = '23503';
end;
$$;

-- RPC pública como wrapper SECURITY INVOKER; o privilégio de DELETE fica isolado
-- na função privada SECURITY DEFINER e não é concedido diretamente ao navegador.
create or replace function public.permanently_delete_product_from_trash(
  p_store_id uuid,
  p_trash_id uuid
)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select private.permanently_delete_product_from_trash(p_store_id, p_trash_id);
$$;

revoke all on function private.permanently_delete_product_from_trash(uuid, uuid)
  from public, anon;
grant execute on function private.permanently_delete_product_from_trash(uuid, uuid)
  to authenticated;

revoke all on function public.permanently_delete_product_from_trash(uuid, uuid)
  from public, anon;
grant execute on function public.permanently_delete_product_from_trash(uuid, uuid)
  to authenticated;
