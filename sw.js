// オフライン用 Service Worker
// 更新を公開するときは VERSION を変える（変えないと端末に古い版が残る）。
const VERSION = 'nocturne-mobile-v14';
const FONTS = 'nocturne-fonts-v1';

const CORE = [
  './', './index.html', './manifest.webmanifest',
  './css/style.css', './css/theme-future.css', './css/mobile-fit.css', './css/theme-champagne.css',
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
  './js/sfx.js', './js/sound-debug.js', './js/online.js', './js/online-config.js',
  './vendor/firebase/firebase-app.js', './vendor/firebase/firebase-auth.js', './vendor/firebase/firebase-database.js',
];
// 効果音（js/sfx.js の SFX_FILES と同じ内容にする。2026-11-19 から sfx/fs/ の WAV）
const SFX = { 'card-shuffle': 2, 'card-deal': 6, 'card-place': 4, 'card-fold': 2, 'chip-roll': 6, 'chip-tick': 3, 'chip-handle': 3, 'chip-stack': 4, 'chip-payout': 0, 'chip-allin': 0, 'knock': 2 };
for (const [head, n] of Object.entries(SFX)) {
  if (!n) CORE.push(`./sfx/fs/${head}.wav`);
  for (let i = 1; i <= n; i++) CORE.push(`./sfx/fs/${head}-${i}.wav`);
}

// アイコンのフォント（Material Symbols）。index.html の2つ目の <link> と同じ URL にする（アイコンを足したら両方を変える）。
// インストール時に CSS とフォントファイルを控えに取り、2回目以降をオフラインで開いてもアイコンが英単語にならないようにする（B-41）
const ICON_CSS = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Sharp:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&icon_names=add,arrow_back,bolt,chair,check,close,group_add,history,link,login,logout,north,replay,volume_off,volume_up&display=block';
async function precacheIcons() {
  const c = await caches.open(FONTS);
  if (await c.match(ICON_CSS, { ignoreVary: true })) return;
  const res = await fetch(ICON_CSS, { mode: 'cors' });
  if (!res.ok) return;
  const css = await res.clone().text();
  await c.put(ICON_CSS, res);
  const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map(m => m[1]);
  await Promise.all(urls.map(u => fetch(u, { mode: 'cors' }).then(r => (r.ok ? c.put(u, r) : null))));
}

self.addEventListener('install', e => {
  // ブラウザの HTTP キャッシュを通さずに取りにいく（前の版のファイルが新しい版の控えに入らないように。B-23）
  e.waitUntil(Promise.all([
    caches.open(VERSION).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))),
    precacheIcons().catch(() => {}), // 取れなくてもインストールは続ける
  ]).then(() => self.skipWaiting()));
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
      const hit = await c.match(req, { ignoreVary: true }); // Google Fonts の応答の Vary で一致しないことがあるため（B-41）
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
