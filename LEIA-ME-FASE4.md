# Fase 4 — SQL aditivo

O arquivo a executar no Supabase é:

`supabase/migrations/202611110002_sync_engine.sql`

A migração inicial da Fase 3 (`202611110001_initial_store_schema.sql`) já foi aplicada no projeto e **não deve ser executada novamente**.

A migração 0002 adiciona os campos de data e idempotência necessários, habilita a exclusão lógica de movimentações e cria as RPCs usadas pelo `src/cloud/sync-engine.js`.

Execute em SQL Editor → New query. Rode uma vez e confira o resultado. Se houver qualquer erro, não repita no escuro: copie a mensagem completa para análise.
