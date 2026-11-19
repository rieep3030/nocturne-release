// 効果音（Web Audio）。素材は Freesound の CC0 音源を切り分けた WAV（sfx/fs/、出典は sfx/fs/CREDITS.txt）。2026-11-19 に差し替え。
// （それまでの Kenney「Casino Audio」の OGG は sfx/ 直下に残っているが、もう読み込まない）
// - 最初に画面を触ったときに音を出せる状態にする（iPhone はタップ前は音を出せない）。
// - 読み込みや再生に失敗しても、エラーにせず無音で進める。
// - 消音の設定は localStorage の 'nocturne.mute'（'1' で消音）。

// 名前 → ファイル名の頭と個数（sw.js の SFX と同じ内容にする）
export const SFX_FILES = {
  shuffle: ['card-shuffle', 2], // ハンドの開始
  slide: ['card-deal', 6], // 手札を配る
  place: ['card-place', 4], // ボードをめくる
  shove: ['card-fold', 2], // 降りる
  lay: ['chip-roll', 6], // チップが卓に落ちて転がる（ダイスをフェルトに注ぐ鈍い音）
  collide: ['chip-tick', 3], // チップ同士がぶつかる
  handle: ['chip-handle', 3], // チップを投げる
  stack: ['chip-stack', 4], // テッセラクトへの回収
  payout: ['chip-payout', 0], // 配当
  allin: ['chip-allin', 0], // オールイン
  knock: ['knock', 2], // チェック（卓を2回ノック）
};
const VOL = { shuffle: 0.5, slide: 0.55, place: 0.6, shove: 0.45, lay: 0.42, collide: 0.3, handle: 0.5, stack: 0.5, payout: 0.55, allin: 0.6, knock: 0.55 };
const GAP = 45; // 同じ音を続けて鳴らすときの最短間隔（ms）。物理の衝突で鳴りすぎないようにする

let ctx = null, master = null, loading = null;
const buffers = new Map(); // 名前 → AudioBuffer の配列
const lastAt = new Map();
let muted = (() => { try { return localStorage.getItem('nocturne.mute') === '1'; } catch { return false; } })();
const log = []; // 確認用（#debug のときだけ外から見る）
// 診断用（#sound の診断表示が読む。2026-11-19）
const diag = { unlocks: 0, resumes: 0, errors: [], loadFailed: 0, session: 'unsupported' };
const noteError = (where, e) => { if (diag.errors.length < 8) diag.errors.push(`${where}: ${e && e.message ? e.message : e}`); };

// iPhone では Web Audio が既定で「周囲の音（ambient）」扱いになり、サイレントモードで消される。
// 対応している端末（Safari の Audio Session API）では「再生（playback）」扱いにして、サイレントモードでも鳴らす。
try {
  if (navigator.audioSession) { navigator.audioSession.type = 'playback'; diag.session = navigator.audioSession.type; }
} catch (e) { noteError('audioSession', e); }

function fileList(name) {
  const [head, n] = SFX_FILES[name];
  return n ? Array.from({ length: n }, (_, i) => `./sfx/fs/${head}-${i + 1}.wav`) : [`./sfx/fs/${head}.wav`];
}

function load() {
  if (loading) return loading;
  loading = Promise.all(Object.keys(SFX_FILES).map(async name => {
    const list = await Promise.all(fileList(name).map(async url => {
      try {
        const res = await fetch(url);
        if (!res.ok) { diag.loadFailed++; noteError('fetch', `${url} ${res.status}`); return null; }
        return await ctx.decodeAudioData(await res.arrayBuffer());
      } catch (e) { diag.loadFailed++; noteError('decode', e); return null; } // 読み込めない端末では無音
    }));
    buffers.set(name, list.filter(Boolean));
  }));
  return loading;
}

// 画面を触ったときに音を出せる状態にする。iPhone では指を離したとき（touchend・click）でないと
// 許可されないことがあるため、それらのたびに再開を試み、無音を一瞬鳴らして出力を開く
function unlock() {
  try {
    diag.unlocks++;
    if (!ctx || ctx.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { noteError('unlock', 'AudioContext なし'); return; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
      loading = null;
      load();
    }
    if (ctx.state !== 'running') { diag.resumes++; ctx.resume().catch(e => noteError('resume', e)); }
    const b = ctx.createBuffer(1, 1, ctx.sampleRate), src = ctx.createBufferSource();
    src.buffer = b; src.connect(ctx.destination); src.start(0);
  } catch (e) { noteError('unlock', e); }
}
for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) window.addEventListener(ev, unlock, { capture: true, passive: true });

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
// 自分の手番の合図：小さな鈴のような、落ち着いた金属の響き（倍音をずらした2音が重なって減衰する）
function turn(t, vol) {
  [[784, 0], [1174.7, 0.09]].forEach(([hz, dt]) => {
    for (const [mul, k, dec] of [[1, 1, 1.1], [2.76, 0.22, 0.45], [5.4, 0.07, 0.2]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = hz * mul;
      env(g, t + dt, 0.11 * vol * k, 0.004, dec);
      o.connect(g).connect(master);
      o.start(t + dt); o.stop(t + dt + dec + 0.05);
    }
  });
}
// ボタンを押したときの音：金属の小さなスイッチのような、短く乾いた音
function click(t, vol) {
  const n = noise(0.012), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = 'bandpass'; f.frequency.value = 4200; f.Q.value = 2.5;
  env(g, t, 0.16 * vol, 0.0008, 0.012);
  n.connect(f).connect(g).connect(master);
  n.start(t);
  const o = ctx.createOscillator(), go = ctx.createGain();
  o.type = 'sine'; o.frequency.value = 2350;
  env(go, t, 0.05 * vol, 0.001, 0.03);
  o.connect(go).connect(master);
  o.start(t); o.stop(t + 0.05);
}
const SYNTH = { turn, click };

export const sfx = {
  // name：SFX_FILES か SYNTH の名前。vol：0〜1。delay：ms
  play(name, { vol = 1, delay = 0 } = {}) {
    const now = performance.now();
    if (now - (lastAt.get(name) || 0) < GAP && delay === 0) return;
    lastAt.set(name, now);
    if (log.length < 500) log.push({ name, vol: Math.round(vol * 100) / 100, at: Math.round(now) });
    if (!ctx || muted) return;
    if (ctx.state !== 'running') { diag.resumes++; ctx.resume().catch(e => noteError('resume', e)); return; } // 止まっていたら再開を試み、今回は鳴らさない
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
  debug() {
    return {
      state: ctx ? ctx.state : 'none', sampleRate: ctx ? ctx.sampleRate : 0, muted,
      session: diag.session, unlocks: diag.unlocks, resumes: diag.resumes, loadFailed: diag.loadFailed, errors: diag.errors,
      loaded: [...buffers].map(([k, v]) => `${k}:${v.length}`), log,
    };
  },
  // 診断用：音を出せる状態にし直す
  unlock,
};
