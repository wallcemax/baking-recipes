// Firebase Cloud Messaging 背景推播通知：整合進這支唯一的service worker裡，
// 不再另外用一支獨立的firebase-messaging-sw.js——之前拆成兩支各自獨立運作，
// 懷疑是造成同一則推播被重複顯示成兩則的原因，合併成一支徹底排除這個可能性
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
firebase.initializeApp({
    apiKey: "AIzaSyB2srYJRT8FqovYt_vCJh35h69H0W7cBLU",
    authDomain: "recipe-synchronization.firebaseapp.com",
    projectId: "recipe-synchronization",
    storageBucket: "recipe-synchronization.firebasestorage.app",
    messagingSenderId: "559668909743",
    appId: "1:559668909743:web:63dc34572b98839479265a"
});
firebase.messaging(); // 只要初始化就好，不用呼叫onBackgroundMessage，讓SDK用webpush.notification自動顯示

const CACHE_NAME = 'baking-recipe-cache-v9';
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
// 點擊系統通知（例如計時器時間到、或冰箱/採購提醒）時，把使用者帶回這個 PWA：
// 如果已經有視窗開著就直接切過去（因為網站本身已經會記住上次在看的食譜，
// 切回來會自動翻回原本那篇），沒有開著的視窗才另外開一個新的
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
