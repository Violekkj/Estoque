# Estoque no Bolso — v13 | Fase 3 — Supabase e autenticação

## Correções e recursos desta versão

- Tela de carregamento usa a imagem `./icon-192.png` em vez da letra E.
- Em `file://`, o HTML apresenta um aviso claro: navegadores bloqueiam módulos ES nesse protocolo. Use `INICIAR-LOCAL.bat` ou `py -m http.server 8000`.
- Se os módulos não carregarem ou a inicialização demorar mais de 10 segundos, a tela apresenta uma orientação em vez de ficar presa indefinidamente.
- `src/data/storage.js` aplica limites de tempo às operações IndexedDB e mantém o fallback/migração via `localStorage`.
- O boot consulta snapshot, rascunho e disponibilidade do IndexedDB em paralelo para evitar esperas sequenciais desnecessárias.
- O estado já carregado não é substituído por dados de demonstração se uma etapa posterior da inicialização falhar.
- Todos os caminhos locais em HTML, manifest, imports e Service Worker são relativos (`./`), adequados para GitHub Pages em `/Estoque/`.
- Adicionado o `icon-maskable-512.png` que era referenciado pelo manifest e pelo cache do Service Worker, mas não existia no pacote v11. Sua ausência fazia `cache.addAll()` falhar e impedia a instalação do Service Worker novo.
- Service Worker atualizado para `v13` para forçar a instalação do cache corrigido.

## Como abrir localmente

**Não abra `index.html` diretamente pelo Explorer (`file://`)**: módulos ES nativos são bloqueados por política de segurança dos navegadores. O app agora explica isso em vez de ficar carregando para sempre.

Na pasta do projeto, dê dois cliques em `INICIAR-LOCAL.bat`, ou rode:

```powershell
py -m http.server 8000
```

Abra `http://localhost:8000`.

## GitHub Pages

Envie a estrutura completa para a raiz do repositório. Não envie apenas o HTML: o app precisa de `assets/`, `src/`, manifest e ícones.

O entrypoint e todos os imports usam caminhos relativos, por exemplo `./src/app.js`. Em `https://usuario.github.io/Estoque/`, eles resolvem dentro de `/Estoque/` e não na raiz do domínio.

## Testes recomendados antes da publicação

1. `file://`: confirmar que aparece o aviso de abertura local, sem spinner infinito.
2. `http://localhost:8000`: confirmar que o app inicia e lê os dados existentes.
3. GitHub Pages: confirmar que `index.html`, `src/app.js`, `assets/styles/app.css`, `sw.js`, `manifest.webmanifest` e todos os ícones respondem sem 404.
4. DevTools > Application > Service Workers: confirmar que a versão v12 foi instalada e ativada.
5. Testar que produtos e histórico antigos continuam presentes.

## Dados e limites

A chave antiga `estoque-no-bolso-v1` foi mantida. IndexedDB continua local ao navegador/dispositivo; esta versão ainda não ativa Supabase ou sincronização em nuvem. Faça backup manual antes de substituir a versão publicada.

## Fase 3 — Supabase e autenticação

Consulte `LEIA-ME-FASE3.md` para configurar o Supabase, executar a migração SQL e preencher `src/config/supabase-config.js`. A autenticação é opcional até essa configuração. A sincronização do estoque ainda NÃO está ativa e será implementada na Fase 4.
