const CACHE_NAME = 'baking-recipe-cache-v5';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './tfnd-nutrition.json',
  './tfnd-nutrition-full.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(err => console.warn('App shell 快取失敗', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // 只處理自己網站的資源；Firebase / Cloudinary 等外部 API 一律直接連網路
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') return;

  const isHtmlRequest = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHtmlRequest) {
    // 網頁本身一律先嘗試連網路，確保每次更新後使用者都能拿到最新版本；
    // 只有在離線時才退回快取的舊版本，避免舊版一直被快取卡住
    event.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // 其他靜態資源（圖示、manifest）維持快取優先，加快載入速度
  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
