// Service worker do Estoque no Bolso — v14.
// Todos os caminhos são relativos ao diretório do próprio worker, compatíveis com /Estoque/.
const VERSION = 'v15';
const CACHE = 'estoque-no-bolso-' + VERSION;

const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './assets/styles/app.css',
  './src/app.js',
  './src/core/utils.js',
  './src/data/state-schema.js',
  './src/data/indexed-db.js',
  './src/data/storage.js',
  './src/config/supabase-config.js',
  './src/cloud/supabase-client.js',
  './src/cloud/auth.js',
  './src/cloud/sync-engine.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('estoque-no-bolso-') && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isGoogleFont =
  url.hostname === 'fonts.googleapis.com' ||
  url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !isGoogleFont) return;

  // Navegação: rede primeiro; cache como fallback offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response && response.ok) await cache.put(request, response.clone());
        return response;
      } catch (error) {
        const rootUrl = new URL('./', self.registration.scope).href;
        const indexUrl = new URL('./index.html', self.registration.scope).href;
        const fallback = await cache.match(request) || await cache.match(rootUrl) || await cache.match(indexUrl);
        if (fallback) return fallback;
        return new Response('Aplicativo indisponível offline. Conecte-se à internet e tente novamente.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // Recursos estáticos: cache primeiro; busca na rede se ainda não estiverem armazenados.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && (response.ok || response.type === 'opaque')) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      return Response.error();
    }
  })());
});
