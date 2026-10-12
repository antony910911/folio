// 離線快取：App 本身的檔案先從快取讀，背景再更新。
// 新增或改名檔案時請更新 FILES 並把 VERSION 加一。
const VERSION = 'v25';
const CACHE = `folio-${VERSION}`;
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/editor.js',
  './js/ink.js',
  './js/model.js',
  './js/store.js',
  './js/icons.js',
  './js/layout.js',
  './js/inkrender.js',
  './js/vendor.js',
  './js/recognize.js',
  './js/exporter.js',
  './js/pdfmodel.js',
  './js/pdfexport.js',
  './js/zip.js',
  './js/pptx.js',
  './js/importer.js',
  './js/mindmap.js',
  './js/mindmap-view.js',
  './js/syncmodel.js',
  './js/sync.js',
  './js/lock.js',
  './vendor/pptxgen-4.0.1.bundle.js',
  './vendor/docx-9.7.2.iife.js',
  './vendor/anthropic-sdk-0.128.0.mjs',
  './vendor/pdfjs-6.3.289/pdf.min.mjs',
  './vendor/pdfjs-6.3.289/pdf.worker.min.mjs',
  // 中文字型對照表等檔案很多，用到時才會存進快取（見下面的 fetch）
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('folio-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 字型：存一份在裝置上，離線也能用（版本更新時不清掉）
  if (e.request.method === 'GET' && (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com')) {
    e.respondWith(caches.open('fonts-v1').then(async (cache) => {
      const cached = await cache.match(e.request);
      if (cached) return cached;
      const res = await fetch(e.request);
      if (res.ok || res.type === 'opaque') cache.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
