(function (root) {
'use strict';
const CACHE_VERSION = 'spm-1.2.1';
// 同じ製品版の修正でも、保存済みの古い動画送信処理を入れ替える。
const APP_CACHE = CACHE_VERSION + '-video-resume-1';
const APP_FILES = [
  './index.html', './help.html', './config.js', './css/common.css', './css/post.css',
  './js/util.js', './js/dom.js', './js/api.js', './js/exif.js', './js/coords.js',
  './js/export.js', './js/geo.js', './js/photo.js', './js/video.js', './js/outbox.js', './js/mapbase.js', './js/post.js',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png', './vendor/leaflet/images/marker-shadow.png',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon.png'
];
const scopeUrl = new URL('./', self.location.href);
const allowed = new Set(APP_FILES.map(function (path) { return new URL(path, scopeUrl).href; }));
self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(APP_FILES.map(function (path) { return new Request(new URL(path, scopeUrl), { cache: 'reload' }); }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(function (key) { return key.startsWith('spm-') && key !== APP_CACHE; }).map(function (key) { return caches.delete(key); }));
    await self.clients.claim();
  })());
});
async function networkFirst(request, key, timeoutMs) {
  const cache = await caches.open(APP_CACHE), controller = new AbortController();
  const timer = timeoutMs ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
  try {
    const response = await fetch(request, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('読み込めませんでした。');
    await cache.put(key, response.clone()); return response;
  } catch (e) {
    const saved = await cache.match(key); if (saved) return saved;
    return Response.error();
  } finally { if (timer) clearTimeout(timer); }
}
self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);
  // 許可した投稿用の同一オリジンのファイルだけを扱う。タイルとGASは素通し。
  if (event.request.method !== 'GET' || url.origin !== scopeUrl.origin) return;
  url.search = ''; url.hash = '';
  if (url.pathname === scopeUrl.pathname) url.pathname += 'index.html';
  if (!allowed.has(url.href)) return;
  if (url.href === new URL('config.js', scopeUrl).href) { event.respondWith(networkFirst(event.request, url.href, 3000)); return; }
  if (event.request.mode === 'navigate') { event.respondWith(networkFirst(event.request, url.href)); return; }
  event.respondWith((async function () {
    const cache = await caches.open(APP_CACHE), saved = await cache.match(url.href);
    if (saved) return saved;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(url.href, response.clone());
    return response;
  })());
});
root.SPM = root.SPM || {};
root.SPM.sw = { cacheVersion: CACHE_VERSION };
})(typeof window !== 'undefined' ? window : globalThis);
