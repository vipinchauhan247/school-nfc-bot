// PWA Service Worker for MMM School ERP
const CACHE_NAME = 'mmmjhs-pwa-20260906-v269';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/cloudSync.js',
  '/js/erpV2ReadModel.js',
  '/js/erpOutbox.js',
  '/js/erpMarksBroadcast.js',
  '/js/question-paper-generator.js',
  '/js/lesson-plan-generator.js',
  '/js/erp-ai-assistant.js',
  '/js/erp-cloud-runtime.js',
  '/js/mockData.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => console.warn('PWA precache skipped item:', err));
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache API calls, Supabase requests, or live cloud sync
  if (url.pathname.startsWith('/api/') || url.hostname.includes('supabase.co') || event.request.method !== 'GET') {
    return;
  }

  // Network-first strategy with cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});















