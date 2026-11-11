# Checklist manual da Fase 3

Antes de disponibilizar contas reais:

1. Criar duas contas de teste diferentes e confirmar dois estabelecimentos distintos.
2. Entrar com a conta A e confirmar que `stores` mostra somente o estabelecimento A.
3. Entrar com a conta B e confirmar que `stores` mostra somente o estabelecimento B.
4. Consultar `products` sem sessão: não deve retornar linhas.
5. Tentar inserir um produto com `store_id` de outro estabelecimento: RLS deve negar.
6. Confirmar que o cliente autenticado não possui permissão SQL de DELETE direto.
7. Confirmar que `create_my_store` repetido para o mesmo usuário retorna o mesmo ID.
8. Testar confirmação de e-mail e URL de retorno em produção e localhost.

A Fase 3 cria schema e autenticação; ela ainda não envia os produtos locais ao banco. Essa sincronização pertence à Fase 4 e não deve ser simulada como concluída.
