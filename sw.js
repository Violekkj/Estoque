// Service worker do Estoque no Bolso.
// Navegações sempre tentam buscar a versão mais recente; o cache é usado offline.
const VERSION = 'v4';
const CACHE = 'estoque-no-bolso-' + VERSION;
const CORE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png'
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
    await Promise.all(
      keys
        .filter((key) => key.startsWith('estoque-no-bolso-') && key !== CACHE)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isGoogleFont = /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== self.location.origin && !isGoogleFont) return;

  // Para abrir o app, prioriza a rede para evitar mostrar HTML antigo.
  // Se estiver sem internet, usa a última versão guardada.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response && response.ok) {
          await cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const rootUrl = new URL('./', self.registration.scope).href;
        const indexUrl = new URL('index.html', self.registration.scope).href;
        const fallback =
          await cache.match(request) ||
          await cache.match(rootUrl) ||
          await cache.match(indexUrl);
        if (fallback) return fallback;
        throw error;
      }
    })());
    return;
  }

  // Para recursos estáticos, usa o cache primeiro e busca na rede se necessário.
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
