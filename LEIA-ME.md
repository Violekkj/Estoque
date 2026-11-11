# Estoque no Bolso — v14 / Fase 4

Esta entrega acrescenta o motor local-first de sincronização entre IndexedDB e Supabase. Ela mantém o PWA estático e não exige Vite, Node ou processo de build para publicar no GitHub Pages.

## O que está incluído

- IndexedDB versão 2, com a store `sync_queue`.
- Gravação do snapshot e das operações pendentes na mesma transação IndexedDB.
- Identificador UUID idempotente para cada movimentação de estoque.
- Migração inicial de produtos e histórico locais para um estabelecimento cuja nuvem ainda esteja vazia.
- Download de produtos e movimentações da nuvem ao autenticar em um aparelho sem dados locais.
- Processamento da fila ao voltar a ficar online, ao focar/retomar o app e por verificação periódica enquanto o app estiver aberto.
- Indicador no cabeçalho: somente neste aparelho, offline, pendente, sincronizando, erro ou tudo sincronizado.
- RPCs transacionais no Supabase para aplicar entradas/saídas, com bloqueio da linha do produto e deduplicação por `operation_id` (`idempotency_key` no banco).
- Exclusão de movimentação sincronizada é enviada como estorno, mantendo trilha de auditoria; exclusão de produto é soft delete e gera registro na lixeira do banco.

## Antes de publicar: backup e migração SQL

1. No aplicativo atual, abra **Backup** e copie/guarde um backup dos dados locais.
2. No Supabase, abra **SQL Editor → New query**.
3. Execute **uma única vez** o arquivo `supabase/migrations/202611110002_sync_engine.sql`.
4. **Não execute novamente** `202611110001_initial_store_schema.sql`: essa é a migração base da Fase 3, que já foi aplicada no projeto.
5. Aguarde a mensagem de sucesso da migração aditiva da Fase 4. Ela adiciona colunas e funções; não apaga os dados existentes.

A migração 0002 precisa ser aplicada antes de usar o motor v14. Sem ela, as consultas e RPCs de sincronização não existirão no banco.

## Configuração Supabase

O arquivo `src/config/supabase-config.js` já contém o Project URL e a chave `sb_publishable_` informados pelo proprietário do projeto. A publishable key é pública e pode estar no frontend; nunca inclua `service_role` ou `sb_secret_` no repositório.

## Atualizar o projeto local

1. Faça uma cópia da pasta atual do projeto.
2. Extraia o pacote v14.
3. Copie **todo o conteúdo** do pacote para a raiz do repositório local. Não copie somente `index.html` e `sw.js`: o motor depende de `src/cloud/sync-engine.js` e dos módulos de `src/data/`.
4. Abra localmente usando `INICIAR-LOCAL.bat` ou `py -m http.server 8000` e acesse `http://localhost:8000`.
5. Faça o teste local descrito abaixo.
6. Se tudo estiver correto, use o GitHub Desktop para revisar as alterações, fazer commit e push para a branch `main`.

## Como ocorre o primeiro sincronismo

- Se a conta estiver autenticada e ainda não houver produtos na nuvem, o estado local real (não demonstração) é enviado: primeiro os produtos e depois o histórico, preservando `client_id`, datas e UUIDs idempotentes.
- A migração inicial é repetível: se uma chamada for interrompida, o reenvio usa `store_id + client_id` e `idempotency_key` para não duplicar produtos ou movimentos.
- Se a nuvem já possuir produtos, a nuvem é a fonte de verdade para IDs já conhecidos; produtos locais que nunca chegaram à nuvem podem ser incluídos sem sobrescrever a quantidade de um produto existente.
- Em um dispositivo novo sem produtos, o login baixa o estoque e o histórico do estabelecimento para o IndexedDB local.

**Importante:** entre com a conta do estabelecimento antes de cadastrar novos dados em um segundo dispositivo. Se você tiver um backup antigo e o estabelecimento já tiver dados na nuvem, entre primeiro para baixar a cópia central. A restauração manual de um backup antigo é uma ação distinta e pode gerar dados adicionais.

## Conflitos e idempotência

- Cada movimentação recebe um `operationId` UUID no dispositivo e é persistida junto com o snapshot na `sync_queue`.
- O servidor guarda esse valor em `stock_movements.idempotency_key`. Reenvios com o mesmo UUID retornam o resultado existente sem aplicar a quantidade novamente.
- Entradas e saídas usam RPC transacional e `SELECT ... FOR UPDATE` no produto. Operações concorrentes são serializadas no banco; uma saída que deixaria o estoque negativo é recusada e permanece pendente localmente para revisão.
- Metadados do produto (nome, unidade, mínimo, custo e fornecedor) usam a última atualização aceita pelo servidor. Nesta fase não existe tela de resolução manual de conflito.

## Teste recomendado

1. Entre na conta já criada e confira o indicador **Online · Tudo sincronizado**.
2. Cadastre um produto com quantidade inicial e confira `public.products` no Supabase.
3. Registre uma entrada e uma saída. Confira `public.stock_movements` e observe se a quantidade da tabela `products` corresponde ao saldo local.
4. Desligue a internet, registre uma nova entrada e confirme que o indicador mostra **Offline** e que a alteração continua visível no aparelho.
5. Ligue a internet novamente; aguarde o indicador voltar para **Tudo sincronizado** e confirme que surgiu exatamente uma movimentação no banco.
6. Em outro navegador/dispositivo, entre com a mesma conta e confira se os produtos e o histórico são baixados.
7. Teste excluir uma movimentação sincronizada: o servidor deve registrar um estorno, não apagar fisicamente a trilha original.

## Limitações conhecidas desta fase

- Ainda não há sincronização de pedidos formais nas tabelas `purchases` e `purchase_items`, porque a lista de Compras atual é uma sugestão calculada a partir dos produtos abaixo do mínimo, não um pedido salvo no estado local.
- Ainda não há interface para restaurar os itens da `trash` do Supabase.
- A fila é processada enquanto o PWA está aberto/ativo. O navegador pode suspender timers quando o app está fechado; não há garantia de sincronização em segundo plano contínua em todos os Android/iOS.
- É necessário executar e validar a nova migração no projeto Supabase real. A validação local deste pacote não substitui o teste de integração na conta real.
