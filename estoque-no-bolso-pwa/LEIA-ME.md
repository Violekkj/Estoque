# Estoque no Bolso (PWA)

Esta pasta é o app completo. Para o cliente instalar no celular, ela precisa ficar
publicada num endereço com **https://**. Todas as hospedagens abaixo já dão isso.

## 1. Publicar (escolha uma)

Suba a pasta inteira, com todos os arquivos, sem mudar os nomes.

- **Netlify:** crie uma conta gratuita e use a opção de enviar uma pasta arrastando
  (Netlify Drop). É a mais rápida.
- **Cloudflare Pages:** crie um projeto e envie os arquivos pelo upload direto.
- **GitHub Pages:** coloque os arquivos num repositório e ative o Pages nas configurações.

No fim você recebe um endereço, algo como `https://seu-nome.netlify.app`.
Teste abrindo esse endereço no Chrome do seu celular.

## 2. Instalar no Android

1. Abra o endereço no **Chrome**.
2. Toque nos três pontinhos e escolha **Instalar app** (ou **Adicionar à tela inicial**).
3. O ícone aparece na tela inicial e o app abre em tela cheia.

Na primeira abertura é preciso estar com internet. Depois disso o app abre sem sinal.

## 3. Gerar o APK ou publicar na Google Play (opcional)

1. Com o app já publicado, abra **pwabuilder.com** e cole o endereço.
2. Escolha **Android** e baixe o pacote.
3. Para a Play Store é preciso uma conta de desenvolvedor Google (taxa única).
4. Mandar o APK direto pelo WhatsApp também funciona, mas o cliente precisa liberar
   "instalar de fontes desconhecidas".

## 4. iPhone

No **Safari**: botão Compartilhar, depois **Adicionar à Tela de Início**.
No iPhone o app instalado guarda os dados separados do Safari. Quem já cadastrou
produtos no navegador deve usar **Mais, Backup** antes e **Restaurar backup** depois
de abrir o app instalado.

## 5. Publicar uma atualização

Troque os arquivos na hospedagem e, no `sw.js`, aumente o número em
`const VERSION = 'v1'` (para `v2`, `v3`...). Sem isso, os celulares podem continuar
mostrando a versão antiga. O cliente vê a versão nova na segunda vez que abrir o app.

## 6. Testar no seu computador

Dentro desta pasta, rode `python3 -m http.server 8000` e abra `http://localhost:8000`.

## Importante para vender

- Os dados ficam **no celular de cada cliente** (não há login nem sincronização entre
  aparelhos). Se o cliente limpar os dados do navegador ou trocar de celular, perde tudo
  sem o backup. Oriente a usar **Mais, Copiar backup** de vez em quando.
- O app já abre com dados de exemplo. Peça ao cliente para tocar em **Começar do zero**.
