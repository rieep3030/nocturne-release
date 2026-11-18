// 効果音（Web Audio）。素材は Kenney「Casino Audio」(CC0)、sfx/ に同梱。
// - 最初に画面を触ったときに音を出せる状態にする（iPhone はタップ前は音を出せない）。
// - 読み込みや再生に失敗しても、エラーにせず無音で進める。
// - 消音の設定は localStorage の 'nocturne.mute'（'1' で消音）。

// 名前 → ファイル名の頭と個数（sw.js の SFX と同じ内容にする）
export const SFX_FILES = {
  shuffle: ['card-shuffle', 0],
  slide: ['card-slide', 8],
  place: ['card-place', 4],
  shove: ['card-shove', 4],
  lay: ['chip-lay', 3],
  collide: ['chips-collide', 4],
  handle: ['chips-handle', 6],
  stack: ['chips-stack', 6],
};
const VOL = { shuffle: 0.55, slide: 0.7, place: 0.8, shove: 0.6, lay: 0.5, collide: 0.45, handle: 0.6, stack: 0.55 };
const GAP = 45; // 同じ音を続けて鳴らすときの最短間隔（ms）。物理の衝突で鳴りすぎないようにする

let ctx = null, master = null, loading = null;
const buffers = new Map(); // 名前 → AudioBuffer の配列
const lastAt = new Map();
let muted = (() => { try { return localStorage.getItem('nocturne.mute') === '1'; } catch { return false; } })();
const log = []; // 確認用（#debug のときだけ外から見る）

function fileList(name) {
  const [head, n] = SFX_FILES[name];
  return n ? Array.from({ length: n }, (_, i) => `./sfx/${head}-${i + 1}.ogg`) : [`./sfx/${head}.ogg`];
}

function load() {
  if (loading) return loading;
  loading = Promise.all(Object.keys(SFX_FILES).map(async name => {
    const list = await Promise.all(fileList(name).map(async url => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await ctx.decodeAudioData(await res.arrayBuffer());
      } catch { return null; } // OGG を扱えない端末では無音
    }));
    buffers.set(name, list.filter(Boolean));
  }));
  return loading;
}

function unlock() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
      load();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch { /* 音を出せない環境では何もしない */ }
}
for (const ev of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(ev, unlock, { capture: true, passive: true });

// ---------- 合成音（パックにない音） ----------
function noise(dur) {
  const b = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource();
  s.buffer = b;
  return s;
}
function env(g, t, peak, attack, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}
// 卓を指で2回叩く（チェック）
function knock(t, vol) {
  for (const dt of [0, 0.12]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t + dt);
    o.frequency.exponentialRampToValueAtTime(55, t + dt + 0.09);
    env(g, t + dt, 0.55 * vol, 0.004, 0.11);
    o.connect(g).connect(master);
    o.start(t + dt); o.stop(t + dt + 0.16);
    const n = noise(0.04), f = ctx.createBiquadFilter(), gn = ctx.createGain();
    f.type = 'lowpass'; f.frequency.value = 900;
    env(gn, t + dt, 0.25 * vol, 0.002, 0.035);
    n.connect(f).connect(gn).connect(master);
    n.start(t + dt);
  }
}
// 自分の手番の合図（澄んだ2音）
function turn(t, vol) {
  [[659.3, 0], [987.8, 0.11]].forEach(([hz, dt]) => {
    for (const [mul, k] of [[1, 1], [2, 0.18]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = hz * mul;
      env(g, t + dt, 0.18 * vol * k, 0.006, 0.55);
      o.connect(g).connect(master);
      o.start(t + dt); o.stop(t + dt + 0.6);
    }
  });
}
// ボタンを押したときのごく小さな音
function click(t, vol) {
  const n = noise(0.02), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = 'bandpass'; f.frequency.value = 3200; f.Q.value = 1.2;
  env(g, t, 0.22 * vol, 0.001, 0.025);
  n.connect(f).connect(g).connect(master);
  n.start(t);
}
const SYNTH = { knock, turn, click };

export const sfx = {
  // name：SFX_FILES か SYNTH の名前。vol：0〜1。delay：ms
  play(name, { vol = 1, delay = 0 } = {}) {
    const now = performance.now();
    if (now - (lastAt.get(name) || 0) < GAP && delay === 0) return;
    lastAt.set(name, now);
    if (log.length < 500) log.push({ name, vol: Math.round(vol * 100) / 100, at: Math.round(now) });
    if (!ctx || muted || ctx.state !== 'running') return;
    try {
      const t = ctx.currentTime + delay / 1000;
      if (SYNTH[name]) { SYNTH[name](t, vol); return; }
      const list = buffers.get(name);
      if (!list || !list.length) return;
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = list[Math.floor(Math.random() * list.length)];
      src.playbackRate.value = 0.94 + Math.random() * 0.12; // 同じ音の繰り返しに聞こえないよう少し揺らす
      g.gain.value = (VOL[name] ?? 0.6) * Math.max(0, Math.min(1, vol));
      src.connect(g).connect(master);
      src.start(t);
    } catch { /* 無音で続ける */ }
  },
  isMuted() { return muted; },
  setMuted(v) {
    muted = !!v;
    try { localStorage.setItem('nocturne.mute', muted ? '1' : '0'); } catch { /* 保存できなくても続ける */ }
    if (master) master.gain.value = muted ? 0 : 1;
  },
  debug() { return { state: ctx ? ctx.state : 'none', loaded: [...buffers].map(([k, v]) => `${k}:${v.length}`), log }; },
};
