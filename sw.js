/* 귀가 조사 앱 저장 도우미 (서비스 워커)
 * - 화면 파일을 기기에 저장해 두어 앱을 빨리 열고, 인터넷이 없어도 화면이 뜨게 한다.
 * - 응답 저장(구글 Apps Script)과 글꼴 같은 다른 주소의 요청은 건드리지 않는다.
 * - 새 버전을 올리면 다음에 열 때 새 화면으로 바뀐다.
 */
var VERSION = '0177fc2609';
var CACHE = 'ride-' + VERSION;
var FILES = [
    "./",
    "./index.html",
    "./manifest.json",
    "./manifest-g1.json",
    "./manifest-g2.json",
    "./manifest-g3.json",
    "./manifest-teacher.json",
    "./icon-192.png",
    "./icon-512.png",
    "./icon-maskable-512.png",
    "./apple-touch-icon.png"
  ];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // GitHub Pages는 파일을 10분까지 브라우저에 남겨 두므로, 옛 파일을 저장하지 않게 서버에 새로 받는다
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('ride-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // 저장해 둔 화면을 바로 보여 주고, 뒤에서 새 화면을 받아 둔다 (인터넷이 없으면 저장해 둔 화면)
    e.respondWith(caches.open(CACHE).then(function (c) {
      return c.match('./index.html').then(function (hit) {
        var fresh = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
          if (res && res.ok) c.put('./index.html', res.clone());
          return res;
        });
        if (hit) { e.waitUntil(fresh.catch(function () {})); return hit; }
        return fresh;
      });
    }));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || fetch(req); }));
});
