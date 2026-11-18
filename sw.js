// オフライン用 Service Worker
// 更新を公開するときは VERSION を変える（変えないと端末に古い版が残る）。
const VERSION = 'nocturne-mobile-v1';
const FONTS = 'nocturne-fonts-v1';

const CORE = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css', './css/theme-future.css',
  './js/app.js', './js/local-server.js', './js/chips-physics.js',
  './js/engine/cards.js', './js/engine/evaluator.js', './js/engine/equity.js', './js/engine/bots.js',
  './js/engine/table.js', './js/engine/bot-worker.js',
  './vendor/three/build/three.module.js',
  './vendor/three/examples/jsm/postprocessing/EffectComposer.js',
  './vendor/three/examples/jsm/postprocessing/RenderPass.js',
  './vendor/three/examples/jsm/postprocessing/UnrealBloomPass.js',
  './vendor/three/examples/jsm/postprocessing/OutputPass.js',
  './vendor/three/examples/jsm/postprocessing/ShaderPass.js',
  './vendor/three/examples/jsm/postprocessing/MaskPass.js',
  './vendor/three/examples/jsm/postprocessing/Pass.js',
  './vendor/three/examples/jsm/shaders/CopyShader.js',
  './vendor/three/examples/jsm/shaders/LuminosityHighPassShader.js',
  './vendor/three/examples/jsm/shaders/OutputShader.js',
  './vendor/three/examples/jsm/environments/RoomEnvironment.js',
  './vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
  './vendor/three/examples/jsm/lines/LineSegments2.js',
  './vendor/three/examples/jsm/lines/LineSegmentsGeometry.js',
  './vendor/three/examples/jsm/lines/LineMaterial.js',
  './vendor/cannon-es/cannon-es.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts：手元の控えを先に使い、裏で更新する
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // アプリのファイル：手元の控えを優先し、なければ取りに行って控える
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return c.match('./index.html');
      throw err;
    }
  }));
});
