# Estoque no Bolso — Fase 3 (Supabase e autenticação)

## O que esta entrega faz

- Adiciona módulos isolados para carregar o cliente Supabase somente quando o usuário abre **Mais → Conta e acesso**.
- Adiciona cadastro com e-mail/senha, login e logout.
- Após o login, cria/recupera um único estabelecimento do proprietário por meio da RPC `create_my_store`.
- Adiciona uma migração SQL com `stores`, `products`, `purchases`, `purchase_items`, `stock_movements`, `inventory_sessions`, `inventory_counts`, `trash` e `audit_logs`.
- Habilita RLS em todas as tabelas, com políticas de isolamento por estabelecimento.
- Não concede DELETE direto ao cliente; exclusões futuras devem usar soft delete/lixeira e estornos.
- Mantém o app local funcionando sem configuração Supabase.
- Atualiza o Service Worker para v13 e corrige o link de fallback antigo `/Planilha/` para `/Estoque/`.

## O que ainda NÃO está conectado

Esta entrega prepara o schema e a autenticação, mas não sincroniza produtos/histórico. A Fase 4 implementará a fila offline e a sincronização com o banco. O status "Conta autenticada" não significa que existe backup dos produtos na nuvem.

## Configurar o projeto Supabase

1. Crie um projeto Supabase. Se os termos do serviço exigirem que a pessoa responsável pela conta seja adulta, peça a um responsável para administrar essa conta; não tente contornar requisitos etários.
2. No SQL Editor do Supabase, execute `supabase/migrations/202611110001_initial_store_schema.sql`.
3. Em Authentication → Providers, habilite Email. Para uso real, mantenha confirmação por e-mail ativa.
4. Em Authentication → URL Configuration, defina Site URL como `https://violekkj.github.io/Estoque/` e adicione `http://localhost:8000/` à Redirect URLs.
5. Em Project Settings → API (ou API Keys), copie o Project URL e a chave publicável (Publishable key; em projetos antigos, anon public key).
6. Abra `src/config/supabase-config.js` e substitua os dois valores de exemplo:

```js
export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'SUA_CHAVE_PUBLICAVEL_DO_SUPABASE';
```

7. Nunca coloque `service_role`, secret key, senha do banco ou token administrativo no JavaScript do PWA. A chave publicável só pode ficar no navegador porque todas as tabelas têm RLS; valide as políticas antes de cadastrar dados reais.
8. Publique a pasta completa na raiz da branch `main` do GitHub Pages.

## Fluxo atual da autenticação

- Mais → Conta e acesso.
- Criar conta: e-mail, senha e nome do comércio.
- Se a confirmação por e-mail estiver habilitada, confirmar o link recebido e depois entrar.
- Entrar: chama `create_my_store` de modo idempotente e carrega os dados básicos do estabelecimento.
- Sair: encerra a sessão Supabase sem apagar o estoque local.

## Fase 4 necessária antes de uso comercial

A sincronização de produtos, compras e histórico ainda não está ativa. Antes de vender o app, implementar e testar:

- conversão do snapshot local para linhas relacionais;
- fila outbox idempotente;
- resolução de conflitos por versão/updated_at e rejeição de atualizações obsoletas;
- RPCs para aplicar movimentos e atualizar quantidades atomicamente;
- restauração inicial dos dados após login em um novo dispositivo;
- testes de isolamento entre duas contas e de perda de conexão.

## Abrir localmente

Na raiz do projeto, execute `INICIAR-LOCAL.bat` ou `py -m http.server 8000` e acesse `http://localhost:8000`.
