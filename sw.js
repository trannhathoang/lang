/* Chạy được khi không có mạng. Có mạng thì luôn lấy bản mới nhất (chờ tối đa 3 giây),
 * mất mạng hoặc mạng chậm thì dùng bản đã lưu. */
var CACHE = 'lang-v6';
var ASSETS = ['./', 'index.html', 'app.js', 'engine.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    var net = fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    var slow = new Promise(function (resolve) { setTimeout(resolve, 3000); });
    return Promise.race([net.catch(function () {}), slow]).then(function (res) {
      if (res) return res;
      return cache.match(req, { ignoreSearch: true }).then(function (hit) { return hit || net; });
    });
  }));
});
