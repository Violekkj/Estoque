
-- Estoque no Bolso — Fase 5.1: restauração segura de produtos.
-- Reativa o registro original, preservando seu histórico e seus vínculos.

create or replace function public.restore_product_from_trash(
  p_store_id uuid,
  p_trash_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_trash public.trash%rowtype;
  v_product public.products%rowtype;
begin
  -- Valida autenticação e propriedade do estabelecimento.
  if auth.uid() is null or not private.owns_store(p_store_id) then
    raise exception 'Acesso ao estabelecimento não autorizado.'
      using errcode = '42501';
  end if;

  -- Localiza e bloqueia o registro da lixeira.
  select t.* into v_trash
  from public.trash t
  where t.id = p_trash_id
    and t.store_id = p_store_id
    and t.entity_type = 'product'
  for update;

  if not found then
    raise exception 'Produto não encontrado na lixeira.'
      using errcode = 'P0002';
  end if;

  -- Requisições repetidas não restauram nem registram a operação novamente.
  if v_trash.restored_at is not null then
    return true;
  end if;

  if v_trash.expires_at <= now() then
    raise exception 'O prazo de restauração deste item expirou.'
      using errcode = '22023';
  end if;

  -- Recupera o produto original.
  select p.* into v_product
  from public.products p
  where p.id = v_trash.entity_id
    and p.store_id = p_store_id
  for update;

  if not found then
    raise exception 'O produto original não foi encontrado.'
      using errcode = 'P0002';
  end if;

  -- Evita conflito com SKU de outro produto ativo.
  if v_product.sku is not null and exists (
    select 1
    from public.products p
    where p.store_id = p_store_id
      and p.id <> v_product.id
      and p.deleted_at is null
      and p.sku = v_product.sku
  ) then
    raise exception 'Não foi possível restaurar: o SKU já está em uso.'
      using errcode = '23505';
  end if;

  -- Evita conflito com código de barras de outro produto ativo.
  if v_product.barcode is not null and exists (
    select 1
    from public.products p
    where p.store_id = p_store_id
      and p.id <> v_product.id
      and p.deleted_at is null
      and p.barcode = v_product.barcode
  ) then
    raise exception 'Não foi possível restaurar: o código de barras já está em uso.'
      using errcode = '23505';
  end if;

  -- Reativa o registro original sem alterar quantidade ou movimentações.
  update public.products
  set deleted_at = null,
      updated_at = now()
  where id = v_product.id
    and store_id = p_store_id;

  -- Marca a restauração na lixeira.
  update public.trash
  set restored_at = now()
  where id = p_trash_id
    and store_id = p_store_id
    and restored_at is null;

  -- Registra a restauração sem apagar o evento de exclusão anterior.
  insert into public.audit_logs (
    store_id,
    client_id,
    entity_type,
    entity_id,
    action,
    details,
    created_by
  )
  values (
    p_store_id,
    'restore-product:' || p_trash_id::text,
    'product',
    v_product.id,
    'product_restored',
    jsonb_build_object(
      'trash_id', p_trash_id,
      'product_client_id', v_product.client_id
    ),
    auth.uid()
  )
  on conflict do nothing;

  return true;
end;
$$;

-- Somente usuários autenticados podem chamar a função.
revoke all on function public.restore_product_from_trash(uuid, uuid)
  from public, anon;

grant execute on function public.restore_product_from_trash(uuid, uuid)
  to authenticated;
