# Estoque no Bolso — v11 | Fases 0 e 1

## Auditoria e proteção (Fase 0)

- A versão v10 foi preservada integralmente no arquivo separado `Planilha-backup-pre-refatoracao-v10.zip`.
- A chave de dados antiga `estoque-no-bolso-v1` foi mantida.
- O formato de produtos e histórico foi mantido nesta etapa; a função `sanitize` continua validando e normalizando os dados legados.

## Modularização (Fase 1)

- `assets/styles/app.css`: estilos extraídos do HTML.
- `src/app.js`: inicialização, interface, renderização e eventos.
- `src/core/utils.js`: funções puras de formatação, datas, compras e utilitários.
- `src/data/state-schema.js`: validação, normalização e dados de demonstração.
- `src/data/indexed-db.js`: abertura do banco, transações e stores do IndexedDB.
- `src/data/storage.js`: repositório local, migração e compatibilidade.

O projeto usa módulos JavaScript nativos (`type="module"`), sem exigir etapa de build para publicar no GitHub Pages.

## IndexedDB e migração

O banco `estoque-no-bolso-db` cria quatro stores:

- `snapshots`: estado principal do estoque (`main`).
- `drafts`: dados guardados ao alternar para o modo de demonstração.
- `outbox`: estrutura inicial para uma futura fila de sincronização.
- `meta`: metadados e controle de versão.

Na primeira abertura, o aplicativo lê a chave antiga `estoque-no-bolso-v1` do `localStorage`, aplica a validação/normalização existente e grava o estado no IndexedDB. Durante a transição, mantém também uma cópia no `localStorage` como fallback e compatibilidade. As duas cópias recebem marcação de data/hora para selecionar a versão mais recente na inicialização.

O rascunho `estoque-no-bolso-v1-meus-dados` também é importado para o IndexedDB. Preferência de tema e marcação de primeira utilização continuam em `localStorage` por serem preferências pequenas do navegador.

## Limites desta versão

Esta versão ainda **não** possui Supabase, login, nuvem, sincronização entre dispositivos, backup remoto ou notificações push. A store `outbox` está preparada como estrutura, mas não envia operações. IndexedDB melhora o armazenamento local, mas continua pertencendo ao navegador/dispositivo; por isso, até implementarmos nuvem e recuperação, continue usando a exportação manual do backup.

## Como testar localmente no Windows

Como o projeto agora usa módulos JavaScript, não abra `index.html` diretamente por `file://` no Explorer. Os navegadores restringem módulos carregados dessa forma.

Opções:

1. Dê dois cliques em `INICIAR-LOCAL.bat` (requer Python instalado); ou
2. No terminal do VS Code, dentro da pasta do projeto, execute:

```powershell
py -m http.server 8000
```

Depois abra `http://localhost:8000`. Se o comando `py` não existir, tente `python -m http.server 8000` ou use a extensão Live Server do VS Code.

## Publicação no GitHub Pages

**Envie a estrutura completa**, não somente `index.html` e `sw.js`. Preserve as pastas `assets/` e `src/`, pois o HTML importa os módulos e o CSS desses caminhos.

No terminal, na pasta do projeto:

```bash
git add index.html sw.js assets src LEIA-ME.md INICIAR-LOCAL.bat
git commit -m "Refatora app e prepara IndexedDB"
git push
```

O Service Worker foi atualizado para `v11` e pré-armazena o HTML, o CSS e todos os módulos necessários para a abertura offline.

## Backup de segurança

O arquivo separado `Planilha-backup-pre-refatoracao-v10.zip` contém os arquivos v10 originais, antes da refatoração. Guarde esse arquivo fora da pasta do repositório.
