
-- =========================================================
-- ESTOQUE NO BOLSO
-- Migration 202611110003
-- Security hardening
-- =========================================================

BEGIN;

-- 1. Remover privilégios excessivos das tabelas existentes.

REVOKE
    DELETE,
    TRUNCATE,
    REFERENCES,
    TRIGGER
ON TABLE
    public.stores,
    public.products,
    public.purchases,
    public.purchase_items,
    public.stock_movements,
    public.inventory_sessions,
    public.inventory_counts,
    public.trash,
    public.audit_logs
FROM authenticated;


-- 2. Restringir privilégios padrão de objetos futuros
-- criados pelo usuário postgres.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
REVOKE ALL PRIVILEGES ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


-- 3. Mover as funções privilegiadas para o schema privado.

ALTER FUNCTION public.reverse_stock_movement(uuid, text, uuid)
SET SCHEMA private;

ALTER FUNCTION private.reverse_stock_movement(uuid, text, uuid)
SECURITY DEFINER;


ALTER FUNCTION public.soft_delete_status_event(uuid, text)
SET SCHEMA private;

ALTER FUNCTION private.soft_delete_status_event(uuid, text)
SECURITY DEFINER;


-- 4. Criar interfaces públicas para o aplicativo.

CREATE FUNCTION public.reverse_stock_movement(
    p_store_id uuid,
    p_movement_client_id text,
    p_operation_id uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT private.reverse_stock_movement(
        p_store_id,
        p_movement_client_id,
        p_operation_id
    );
$$;


CREATE FUNCTION public.soft_delete_status_event(
    p_store_id uuid,
    p_event_client_id text
)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT private.soft_delete_status_event(
        p_store_id,
        p_event_client_id
    );
$$;


-- 5. Permissões das funções privadas.

GRANT USAGE ON SCHEMA private TO authenticated, service_role;

REVOKE ALL ON FUNCTION
    private.reverse_stock_movement(uuid, text, uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    private.reverse_stock_movement(uuid, text, uuid)
TO authenticated, service_role;


REVOKE ALL ON FUNCTION
    private.soft_delete_status_event(uuid, text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    private.soft_delete_status_event(uuid, text)
TO authenticated, service_role;


-- 6. Permissões das interfaces públicas.

REVOKE ALL ON FUNCTION
    public.reverse_stock_movement(uuid, text, uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    public.reverse_stock_movement(uuid, text, uuid)
TO authenticated, service_role;


REVOKE ALL ON FUNCTION
    public.soft_delete_status_event(uuid, text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
    public.soft_delete_status_event(uuid, text)
TO authenticated, service_role;


-- 7. Impedir atualização direta dos históricos.

REVOKE UPDATE ON TABLE
    public.stock_movements,
    public.audit_logs
FROM authenticated;


COMMIT;
