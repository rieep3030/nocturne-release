// NOCTURNE スマホ単体版（PC 版 public/app.js を元に、通信を端末内サーバーに差し替えたもの）
import { createLocalServer } from './local-server.js';
import { sfx } from './sfx.js';
import { isOnlineReady, normalizeCode, isValidCode } from './online.js';
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const fmt = n => Number(n || 0).toLocaleString('en-US');
// ボタンの中身：Material Symbols Sharp のアイコン＋英語の表記（2026-11-19）
const icon = name => { const i = el('span', 'ms', name); i.setAttribute('aria-hidden', 'true'); return i; };
const btnIn = (b, name, text) => { b.textContent = ''; b.append(icon(name)); if (text) b.append(el('span', null, text)); return b; };
const local = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境では何もしない */ } },
};
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_JA = { s: 'スペード', h: 'ハート', d: 'ダイヤ', c: 'クラブ' };
const LEGEND = [
  { v: 5, shape: 'tetra', color: '#8fd6ff', name: '正四面体' }, { v: 25, shape: 'cube', color: '#3df0b2', name: '立方体' },
  { v: 100, shape: 'octa', color: '#ff4d6a', name: '正八面体' }, { v: 500, shape: 'dodeca', color: '#b57bff', name: '正十二面体' },
  { v: 1000, shape: 'icosa', color: '#ffc457', name: '正二十面体' },
];
const LEVEL_NOTE = {
  novice: '気前よくコールしてくれる新顔。',
  regular: '店の常連。堅実だが、癖は読みやすい。',
  shark: '隙を見せれば容赦しない勝負師。',
  proprietor: 'この店の主。あなたの打ち筋を覚えている。',
};
// 席の配置（自分が常に下中央。時計回り）
// 7人卓・左右対称（左に 140/195/245、右に 40/345/295。真向かいの 270° は空く）。chips-physics.js の SEAT_ANG と同じ値にする
const ANG = [90, 140, 195, 245, 295, 345, 40];
const SEATS = ANG.length;
// 席の下に出す行動の表示（エンジンの値は日本語のまま。表示だけ英語にする。2026-11-19）
const ACTION_EN = { 'フォールド': 'FOLD', 'チェック': 'CHECK', 'コール': 'CALL', 'ベット': 'BET', 'レイズ': 'RAISE', 'オールイン': 'ALL-IN', '退席': 'AWAY' };

const S = {
  ws: null, hello: null, retry: 0, kicked: false,
  me: null, meAt: 0, levels: {}, stakes: [], gameOverBelow: 0,
  lobby: [], table: null, recvAt: 0, screen: 'gate',
  seen: new Set(), seenHand: -1, raiseTo: 0, raiseKey: '', autoSit: false, logOpen: false,
};
let stage = null;

// ---------------- 通信（スマホ単体版：端末内サーバーとやり取りする） ----------------
const LOCAL = createLocalServer(m => onMsg(m));
function send(m) { LOCAL.send(m); }

function onMsg(m) {
  switch (m.t) {
    case 'gate':
      S.hello = null;
      showScreen('gate');
      $('#g-error').textContent = m.error || '';
      break;
    case 'welcome':
      // 招待リンク（?room=XXXXXX）から開いたら、入場後にその部屋へ入る
      if (S.inviteCode && isOnlineReady()) { const c = S.inviteCode; S.inviteCode = null; setTimeout(() => send({ t: 'joinRoom', code: c }), 0); }
      local.set('nocturne.token', m.token);
      if (S.hello) S.hello.token = m.token;
      Object.assign(S, { levels: m.levels, stakes: m.stakes, gameOverBelow: m.gameOverBelow });
      setMe(m.me);
      break;
    case 'me':
      setMe(m.me);
      break;
    case 'lobby':
      S.lobby = m.tables;
      S.table = null;
      showScreen('lobby');
      renderLobby();
      break;
    case 'table':
      onTable(m.table);
      break;
    case 'created':
      S.autoSit = true;
      break;
    case 'toast':
      toast(m.text, m.kind);
      break;
    case 'error':
      toast(m.text, 'err');
      if (S.table) renderActions(S.table);
      break;
    case 'unlocked':
      showInvite(m.botName);
      break;
    case 'gameover':
      showGameOver(m);
      break;
    case 'hostResume':
      // ホストとして開いていた卓が、アプリを閉じたあとも残っている：戻るかどうかを聞く（2026-11-24）
      dialog((box, close) => {
        box.append(el('p', 'eyebrow', 'Room ' + m.code), el('h3', null, '前の卓に戻りますか？'));
        box.append(el('p', 'note', `アプリを閉じる前に開いていた卓（${m.name}）が、まだ開いています。戻ると、途中だったハンドは無効になり、賭けたチップは各自に戻ります。戻らない場合、参加者のチップは60秒後にそれぞれの手持ちへ戻ります。`));
        const acts = el('div', 'dlg-actions');
        const no = btnIn(el('button', 'btn btn-ghost'), 'close', 'NOT NOW');
        no.onclick = () => { close(); send({ t: 'resumeHost', code: m.code, yes: false }); };
        const yes = btnIn(el('button', 'btn btn-primary'), 'replay', 'RETURN');
        yes.onclick = () => { close(); send({ t: 'resumeHost', code: m.code, yes: true }); };
        acts.append(no, yes);
        box.append(acts);
      });
      break;
    case 'room':
      // ネット対戦の部屋（ホスト／参加者）。code が null なら部屋を出た
      S.room = m.code ? { code: m.code, role: m.role } : null;
      renderRoomBadge();
      $('#r-name').textContent = tableLabel(S.room && S.room.code);
      if (S.table) renderActions(S.table);
      break;
    case 'kicked':
      S.kicked = true;
      showScreen('gate');
      $('#g-error').textContent = m.text;
      break;
  }
}

function setMe(me) {
  S.me = me;
  S.meAt = performance.now();
  renderMe();
}

// ---------------- 画面 ----------------
function showScreen(name) {
  if (S.screen === name && !$('#' + name).hidden) return;
  S.screen = name;
  for (const id of ['gate', 'lobby', 'room']) $('#' + id).hidden = id !== name;
  stage?.setMode(name === 'gate' ? 'showcase' : name === 'room' ? 'table' : 'lounge');
  if (name === 'room') computeLayout();
  if (name !== 'room') { $('#logpanel').hidden = true; S.pileKey = null; }
}

function toast(text, kind = '') {
  const t = el('div', 'toast ' + kind, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3900);
}

function crestSVG() {
  const cx = 60, cy = 58;
  let lines = '';
  for (let k = 1; k < 12; k++) {
    const a = (Math.PI * k) / 12;
    const p = r => `${(cx - Math.cos(a) * r).toFixed(1)} ${(cy - Math.sin(a) * r).toFixed(1)}`;
    lines += `<path d="M${p(22)} L${p(50)}"/>`;
  }
  return `<svg viewBox="0 0 120 64" fill="none" stroke="currentColor" stroke-width=".8">
    <path d="M8 58 A52 52 0 0 1 112 58"/><path d="M14 58 A46 46 0 0 1 106 58" opacity=".45"/>
    <path d="M38 58 A22 22 0 0 1 82 58"/>${lines}<path d="M0 58 H120"/><path d="M0 61.5 H120" opacity=".4"/>
    <path d="M60 41 l6 6 -6 6 -6 -6z" fill="currentColor" stroke="none"/></svg>`;
}

// 正多面体の線画アイコン（ロビーの額面一覧）
function polySVG(shape, color) {
  const reg = (n, r, rot, cx = 13, cy = 13) => Array.from({ length: n }, (_, i) => {
    const a = rot + (2 * Math.PI * i) / n;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  });
  const P = pts => pts.map(p => p.map(v => v.toFixed(2)).join(',')).join(' ');
  const L = (a, b) => `<line x1="${a[0].toFixed(2)}" y1="${a[1].toFixed(2)}" x2="${b[0].toFixed(2)}" y2="${b[1].toFixed(2)}"/>`;
  let body = '';
  if (shape === 'tetra') {
    const o = reg(3, 10.5, -Math.PI / 2, 13, 14), c = [13, 16.5];
    body = `<polygon points="${P(o)}"/>${o.map(p => L(p, c)).join('')}`;
  } else if (shape === 'cube') {
    const o = reg(6, 10.5, -Math.PI / 2), c = [13, 13];
    body = `<polygon points="${P(o)}"/>${[o[0], o[2], o[4]].map(p => L(p, c)).join('')}`;
  } else if (shape === 'octa') {
    const t = [13, 2], b = [13, 24], l = [3, 13], r = [23, 13], f = [10.5, 15];
    body = `<polygon points="${P([t, r, b, l])}"/>${[t, b, l, r].map(p => L(p, f)).join('')}`;
  } else if (shape === 'dodeca') {
    const o = reg(10, 11, -Math.PI / 2), i = reg(5, 6, -Math.PI / 2);
    body = `<polygon points="${P(o)}"/><polygon points="${P(i)}"/>${i.map((p, k) => L(p, o[k * 2])).join('')}`;
  } else {
    const o = reg(6, 11, -Math.PI / 2), i = reg(3, 6, -Math.PI / 2);
    body = `<polygon points="${P(o)}"/><polygon points="${P(i)}"/>` +
      i.map((p, k) => L(p, o[k * 2]) + L(p, o[(k * 2 + 1) % 6]) + L(p, o[(k * 2 + 5) % 6])).join('');
  }
  return `<svg viewBox="0 0 26 26" fill="none" stroke="${color}" stroke-width="1.1" stroke-linejoin="round" style="filter:drop-shadow(0 0 2.5px ${color})">${body}</svg>`;
}

function fmtTime(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------- メンバー表示 ----------------
function renderMe() {
  const me = S.me;
  if (!me) return;
  $('#m-name').textContent = me.name;
  $('#m-no').textContent = 'No. ' + me.id.replace(/-/g, '').slice(0, 8).toUpperCase();
  $('#m-wallet').textContent = fmt(me.wallet);
  $('#m-table').textContent = fmt(me.onTable);
  $('#m-best').textContent = me.best && me.best.peak ? fmt(me.best.peak) : '—';
  $('#m-run').textContent = me.run ? `今回 ${fmt(me.run.hands)} ハンド・最高 ${fmt(me.run.peak)}` : '';
  $('#m-limit').textContent = `手持ちと卓上の合計が ${fmt(me.gameOverBelow)} を下回るとゲームオーバー`;
  $('#m-unlock').hidden = !me.unlocked;
  $('#r-wallet').textContent = `手持ち ${fmt(me.wallet)}`;
  const t = S.table;
  const seated = t && t.mySeat >= 0;
  $('#b-stand').hidden = !seated;
  $('#b-rebuy').hidden = !(seated && t.seats[t.mySeat].stack + (t.seats[t.mySeat].pendingRebuy || 0) < t.maxBuyIn); // B-30
}

// ---------------- ロビー ----------------
function renderLobby() {
  const ol = $('#table-list');
  ol.textContent = '';
  if (!S.lobby.length) {
    ol.append(el('li', 'empty', 'まだ卓は開かれていません。最初の一卓をどうぞ。'));
    return;
  }
  S.lobby.forEach((t, k) => {
    const li = el('li', 'trow');
    li.append(el('span', 'tnum', ROMAN[k] || String(k + 1)));
    const nm = el('div', 'tname');
    nm.append(el('strong', null, tableLabel(t.room)), el('small', null, t.hostName ? `主催 ${t.hostName}` : '')); // 卓の名前は廃止（2026-11-25）
    li.append(nm);
    li.append(el('span', 'tstakes', `${fmt(t.sb)} / ${fmt(t.bb)}`));
    const seats = el('span', 'tseats');
    seats.title = '◆ 人 ／ ◇ CPU';
    t.seats.forEach(s => seats.append(el('i', s ? (s.isBot ? 'bot' : 'human') : '')));
    li.append(seats);
    const b = btnIn(el('button', 'btn btn-small'), 'login', 'JOIN');
    b.onclick = () => send({ t: 'joinTable', tableId: t.id });
    li.append(b);
    ol.append(li);
  });
}

// 一覧と卓の上部に出す名前：シングルは SOLO、マルチは部屋コード（2026-11-25 決定）
const tableLabel = code => (code ? 'ROOM ' + code : 'SOLO');

// mode：'single'（CPU 戦。すぐ始まる）／'multi'（部屋を作る。ホストが START を押すまで始まらない）
function openCreate(mode) {
  const multi = mode === 'multi';
  dialog((box, close) => {
    box.append(el('p', 'eyebrow', multi ? 'Multi Play' : 'Single Play'), el('h3', null, multi ? '部屋を作る' : 'ひとりで遊ぶ'));
    const form = el('form', 'form-grid');
    const stakeF = el('div', 'field');
    stakeF.append(el('span', null, 'ステークス（SB / BB）'));
    const seg = el('div', 'seg');
    S.stakes.forEach((s, i) => {
      const lb = el('label');
      const r = el('input');
      r.type = 'radio'; r.name = 'stake'; r.value = s.id; r.checked = i === 0;
      lb.append(r, el('span', null, `${fmt(s.sb)} / ${fmt(s.bb)}`));
      seg.append(lb);
    });
    stakeF.append(seg);
    const note = el('p', 'note', multi
      ? '部屋コードを友達に送って招きます。2人以上が座ったら START で始めます。空席を CPU で埋めるかは、始めるときに選べます。'
      : 'CPU は卓のレートに合わせて自動で座ります。高いレートほど手強い相手が増えます。');
    const acts = el('div', 'dlg-actions');
    const cancel = btnIn(el('button', 'btn btn-ghost'), 'close', 'CANCEL');
    cancel.type = 'button';
    cancel.onclick = close;
    const ok = btnIn(el('button', 'btn btn-primary'), 'add', 'OPEN');
    ok.type = 'submit';
    acts.append(cancel, ok);
    form.append(stakeF, note, acts);
    form.onsubmit = e => {
      e.preventDefault();
      const stake = form.querySelector('input[name=stake]:checked').value;
      send({ t: 'createTable', stake, online: multi });
      close();
    };
    box.append(form);
  });
}

// ---------------- ネット対戦 ----------------
// MULTI：部屋を作るか、部屋に入るかを選ぶ
function openMulti() {
  if (!isOnlineReady()) { openJoin(); return; } // 準備中の案内は openJoin が出す
  dialog((box, close) => {
    box.append(el('p', 'eyebrow', 'Multi Play'), el('h3', null, 'マルチプレイ'));
    box.append(el('p', 'note', '部屋を作って友達を招くか、友達の部屋コードで入ります。'));
    const acts = el('div', 'dlg-actions');
    const c = btnIn(el('button', 'btn btn-ghost'), 'close', 'CANCEL');
    c.onclick = close;
    const mk = btnIn(el('button', 'btn btn-primary'), 'add', 'CREATE');
    mk.id = 'b-multi-create';
    mk.onclick = () => { close(); openCreate('multi'); };
    const jn = btnIn(el('button', 'btn'), 'login', 'JOIN');
    jn.id = 'b-multi-join';
    jn.onclick = () => { close(); openJoin(); };
    acts.append(c, jn, mk);
    box.append(acts);
  });
}

function openJoin(prefill = '') {
  dialog((box, close) => {
    box.append(el('p', 'eyebrow', 'Join Room'), el('h3', null, '部屋に入る'));
    if (!isOnlineReady()) {
      box.append(el('p', 'note', 'ネット対戦は準備中です（接続情報が未設定）。'));
      const acts = el('div', 'dlg-actions');
      const c = btnIn(el('button', 'btn btn-ghost'), 'close', 'CLOSE');
      c.onclick = close;
      acts.append(c);
      box.append(acts);
      return;
    }
    const form = el('form', 'form-grid');
    const f = el('label', 'field');
    const input = el('input');
    input.maxLength = 6;
    input.autocapitalize = 'characters';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'ABC234';
    input.value = typeof prefill === 'string' ? prefill : '';
    input.className = 'room-code-input';
    f.append(el('span', null, '部屋コード（6文字）'), input);
    const err = el('p', 'note');
    input.oninput = () => { input.value = normalizeCode(input.value); err.textContent = ''; };
    const acts = el('div', 'dlg-actions');
    const c = btnIn(el('button', 'btn btn-ghost'), 'close', 'CANCEL');
    c.type = 'button';
    c.onclick = close;
    const ok = btnIn(el('button', 'btn btn-primary'), 'login', 'JOIN');
    ok.type = 'submit';
    acts.append(c, ok);
    form.append(f, el('p', 'note', 'ホストから聞いた部屋コードを入れてください。卓では自分の手持ちからバイインします。'), err, acts);
    form.onsubmit = e => {
      e.preventDefault();
      const code = normalizeCode(input.value);
      if (!isValidCode(code)) { err.textContent = '部屋コードは英字と数字の6文字です'; return; }
      send({ t: 'joinRoom', code });
      close();
    };
    box.append(form);
  });
}

const inviteUrl = code => `${location.origin}${location.pathname}?room=${code}`;
async function copyInvite() {
  if (!S.room) return;
  const url = inviteUrl(S.room.code);
  try {
    if (navigator.share) { await navigator.share({ title: 'NOCTURNE', text: `部屋コード ${S.room.code}`, url }); return; }
    await navigator.clipboard.writeText(url);
    toast('招待リンクをコピーしました', 'gold');
  } catch {
    toast(`部屋コード ${S.room.code}`, 'gold');
  }
}

function renderRoomBadge() {
  const b = $('#b-invite');
  if (!S.room) { b.hidden = true; return; }
  b.hidden = false;
  btnIn(b, 'link', S.room.code);
  b.setAttribute('aria-label', `部屋コード ${S.room.code}（招待リンクを送る）`);
}

// ---------------- ダイアログ ----------------
function dialog(build) {
  const d = $('#dlg');
  if (d.open) d.close();
  d.textContent = '';
  const box = el('div', 'dlg-box framed');
  d.append(box);
  build(box, () => d.close());
  d.showModal();
}

function amountPicker(box, min, max, step, init) {
  const r = el('input');
  r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = init;
  const out = el('div', 'amount', fmt(r.value)); // 刻みに丸めたあとの、実際に送る額を出す（B-40）
  const ends = el('div', 'range-ends');
  ends.append(el('span', null, fmt(min)), el('span', null, fmt(max)));
  r.oninput = () => { out.textContent = fmt(r.value); };
  box.append(out, r, ends);
  return () => Number(r.value);
}

function brokeNote(box, need, close) {
  const me = S.me;
  box.append(el('p', 'note', `手持ちが足りません（必要 ${fmt(need)}／手持ち ${fmt(me.wallet)}）。`));
  box.append(el('p', 'note', 'もっと小さい卓なら座れるかもしれません。'));
  const acts = el('div', 'dlg-actions');
  const c = btnIn(el('button', 'btn btn-ghost'), 'close', 'CLOSE');
  c.onclick = close;
  acts.append(c);
  box.append(acts);
}

function openBuyIn(seat) {
  const t = S.table;
  dialog((box, close) => {
    box.append(el('p', 'eyebrow', seat >= 0 ? `Seat ${seat + 1}` : 'Buy-in'), el('h3', null, 'バイイン'));
    const max = Math.min(t.maxBuyIn, Math.floor(S.me.wallet / 5) * 5);
    if (max < t.minBuyIn) { brokeNote(box, t.minBuyIn, close); return; }
    const init = Math.min(max, t.bb * 100);
    const get = amountPicker(box, t.minBuyIn, max, t.sb, init);
    const acts = el('div', 'dlg-actions');
    const c = btnIn(el('button', 'btn btn-ghost'), 'close', 'CANCEL');
    c.onclick = close;
    const ok = btnIn(el('button', 'btn btn-primary'), 'chair', 'SIT');
    ok.onclick = () => { send({ t: 'sit', seat, amount: get() }); close(); };
    acts.append(c, ok);
    box.append(acts);
  });
}

function openRebuy() {
  const t = S.table;
  const s = t.seats[t.mySeat];
  dialog((box, close) => {
    box.append(el('p', 'eyebrow', 'Add-on'), el('h3', null, 'チップを追加'));
    const have = s.stack + (s.pendingRebuy || 0); // 追加待ちの分も含める（B-30）
    const room = t.maxBuyIn - have;
    const max = Math.min(room, Math.floor(S.me.wallet / 5) * 5);
    const min = Math.min(max, Math.max(t.sb, t.minBuyIn - have));
    if (max <= 0 || max < t.sb) { brokeNote(box, Math.max(t.sb, t.minBuyIn - have), close); return; }
    const get = amountPicker(box, min, max, t.sb, Math.min(max, Math.max(min, t.bb * 100 - have)));
    const acts = el('div', 'dlg-actions');
    const c = btnIn(el('button', 'btn btn-ghost'), 'close', 'CANCEL');
    c.onclick = close;
    const ok = btnIn(el('button', 'btn btn-primary'), 'add', 'ADD');
    ok.onclick = () => { send({ t: 'rebuy', amount: get() }); close(); };
    acts.append(c, ok);
    box.append(acts);
  });
}

function openAddBot(seat) {
  dialog((box, close) => {
    box.append(el('p', 'eyebrow', `Seat ${seat + 1}`), el('h3', null, 'CPU を招く'));
    const list = el('div', 'levels');
    for (const [k, L] of Object.entries(S.levels)) {
      if (L.hidden && !S.me.unlocked) continue;
      const b = el('button', 'level-opt' + (L.hidden ? ' secret' : ''));
      b.type = 'button';
      b.append(el('b', null, L.label), el('i', null, L.en), el('span', null, LEVEL_NOTE[k] || ''));
      b.onclick = () => { send({ t: 'addBot', seat, level: k }); close(); };
      list.append(b);
    }
    box.append(list);
    const acts = el('div', 'dlg-actions');
    const c = btnIn(el('button', 'btn btn-ghost'), 'close', 'CANCEL');
    c.onclick = close;
    acts.append(c);
    box.append(acts);
  });
}

// ゲームオーバー：今回の成績と自己ベストを出し、初期の手持ちからやり直す
function showGameOver(m) {
  const { run, best, records } = m;
  // 卓に座っていた時間（B-28）。それを記録する前の版から続く回は、開始からの経過時間
  const mins = Math.max(1, Math.round((run.playMs != null ? run.playMs : run.ended - run.started) / 60000));
  dialog((box, close) => {
    box.classList.add('invite', 'gameover');
    const cr = el('div', 'crest');
    cr.innerHTML = crestSVG();
    box.append(cr, el('p', 'eyebrow', 'Closing Time'), el('h3', null, 'ゲームオーバー'));
    box.append(el('p', null, '今夜の勝負はここまで。'));
    const dl = el('dl', 'go-stats');
    const row = (label, value, isRecord) => {
      const d = el('div', isRecord ? 'rec' : '');
      d.append(el('dt', null, label), el('dd', null, value));
      if (isRecord) d.append(el('span', 'go-new', 'NEW'));
      dl.append(d);
    };
    row('遊んだハンド', `${fmt(run.hands)}`, records.hands);
    row('勝ったハンド', `${fmt(run.won)}`, false);
    row('最高到達額', fmt(run.peak), records.peak);
    row('最大の獲得', fmt(run.bestWin), records.bestWin);
    row('プレイ時間', `約 ${fmt(mins)} 分`, false);
    const bl = el('dl', 'go-stats go-best');
    const brow = (label, value) => { const d = el('div'); d.append(el('dt', null, label), el('dd', null, value)); bl.append(d); };
    brow('最高到達額', fmt(best.peak));
    brow('ハンド数', fmt(best.hands));
    brow('挑戦回数', `${fmt(best.runs)} 回`);
    // 横画面では「今回の成績」と「自己ベスト」を左右に並べる
    const cols = el('div', 'go-cols');
    const left = el('div');
    left.append(el('p', 'eyebrow go-sub', 'This Night'), dl);
    const right = el('div');
    right.append(el('p', 'eyebrow go-sub', 'Personal Best'), bl);
    cols.append(left, right);
    box.append(cols);
    box.append(el('p', 'sign', `— 手持ち ${fmt(m.startingWallet)} から、もう一度`));
    const acts = el('div', 'dlg-actions');
    acts.style.justifyContent = 'center';
    const ok = btnIn(el('button', 'btn btn-primary'), 'replay', 'RESTART');
    ok.onclick = close;
    acts.append(ok);
    box.append(acts);
  });
}

function showInvite(botName) {
  dialog((box, close) => {
    box.classList.add('invite');
    const cr = el('div', 'crest');
    cr.innerHTML = crestSVG();
    box.append(cr, el('p', 'eyebrow', 'An Invitation'), el('h3', null, '奥の卓へ'));
    box.append(el('p', null, `${botName} を退けたあなたに、支配人が興味を示しています。`));
    box.append(el('p', null, '今夜から、卓に「支配人」を招けるようになりました。'));
    box.append(el('p', 'sign', '— M. Nocturne'));
    const acts = el('div', 'dlg-actions');
    acts.style.justifyContent = 'center';
    const ok = btnIn(el('button', 'btn btn-primary'), 'check', 'ACCEPT');
    ok.onclick = close;
    acts.append(ok);
    box.append(acts);
  });
  // 開いた直後にボタンへ移動してスクロールされるのを戻し、見出しから見せる
  requestAnimationFrame(() => { $('#dlg').scrollTop = 0; });
}

// ---------------- 卓 ----------------
function onTable(t) {
  const prev = S.table && S.table.id === t.id ? S.table : null;
  S.table = t;
  S.recvAt = performance.now();
  showScreen('room');
  renderRoom(prev);
  if (S.autoSit) {
    S.autoSit = false;
    if (t.mySeat < 0 && !t.seats[0]) openBuyIn(0);
  }
}

function heroSeat(t) { return t.mySeat >= 0 ? t.mySeat : 0; }
function disp(i, hero) { return (i - hero + SEATS) % SEATS; }
const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });

// 3D が使えない環境向けの平面配置（卓の楕円上に置く）
function flatLayout(area) {
  const compact = area.height < 420;
  const padX = compact ? 70 : 110, padT = compact ? 34 : 70, padB = compact ? 30 : 70;
  const aw = area.width - padX * 2, ah = area.height - padT - padB;
  let w, h;
  if (aw / ah > 2.05) { h = ah; w = h * 2.05; } else { w = aw; h = w / 2.05; }
  const x0 = area.left + (area.width - w) / 2, y0 = area.top + padT + Math.max(0, (ah - h) / 2);
  const at = (px, py) => ({ x: x0 + (w * px) / 100, y: y0 + (h * py) / 100 });
  const sp = (d, k) => {
    const a = (ANG[d] * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return at(50 + 50 * k * Math.sign(c) * Math.abs(c) ** 0.6, 50 + 50 * k * Math.sign(s) * Math.abs(s) ** 0.6);
  };
  const ds = ANG.map((_, d) => d);
  return {
    seat: ds.map(d => sp(d, 1)), bet: ds.map(d => sp(d, 0.62)), win: ds.map(d => sp(d, 0.76)),
    dealer: ds.map(d => sp(d, 0.82)), pot: at(50, 66), board: at(50, 46), tess: { x: area.left + area.width / 2, y: area.top / 2 },
    cw: Math.max(compact ? 24 : 34, Math.min(70, w * 0.056, h * 0.19)),
  };
}

// 画面上の配置を計算する（#stage-area 基準の座標に直して保持）
function computeLayout() {
  const area = $('#stage-area').getBoundingClientRect();
  const L = stage ? stage.layout(area) : flatLayout(area);
  const rel = p => ({ x: p.x - area.left, y: p.y - area.top });
  S.L = {
    seat: L.seat.map(rel), bet: L.bet.map(rel), win: L.win.map(rel), dealer: L.dealer.map(rel),
    pot: rel(L.pot), board: rel(L.board), tess: rel(L.tess), cw: L.cw, area,
  };
  const felt = $('#felt');
  // 横向きのスマホ（高さが低い）では、ボードと自分の手札を約1.5倍にして見やすくする（2026-11-18）
  const compact = area.height < 420;
  const big = compact ? 1.5 : 1;
  felt.style.setProperty('--cw', L.cw * big + 'px');
  felt.style.setProperty('--cwb', Math.max(compact ? 30 : 44, L.cw * 1.02) * big + 'px');
}
const px = (elm, p, dy = 0) => { elm.style.left = p.x + 'px'; elm.style.top = p.y + dy + 'px'; };

function cardEl(code, key, extra = '') {
  const deal = key && !S.seen.has(key);
  if (key) S.seen.add(key);
  if (code === '??') return el('div', 'card back' + (deal ? ' pending' : ''));
  const r = code[0] === 'T' ? '10' : code[0];
  const s = code[1];
  const c = el('div', `card${s === 'h' || s === 'd' ? ' red' : ''}${deal ? ' pending' : ''} ${extra}`);
  const sym = SUIT[s] + '︎';
  c.append(el('span', 'cr', r), el('span', 'cs', sym), el('span', 'cb', sym));
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', `${SUIT_JA[s]}の${r}`);
  return c;
}

function bestSet(t) {
  const w = t.results && t.results.kind === 'showdown' && t.results.winners[0];
  return w && w.best ? new Set(w.best) : null;
}

function renderRoom(prev) {
  const t = S.table;
  if (!t) return;
  $('#r-name').textContent = tableLabel(S.room && S.room.code);
  $('#r-stakes').textContent = `${fmt(t.sb)} / ${fmt(t.bb)}`;
  if (S.seenHand !== t.handNo) { S.seen.clear(); S.seenHand = t.handNo; }
  if (!S.L) computeLayout();
  renderSeats(t);
  renderBoard(t);
  renderPotAndBets(t);
  renderActions(t);
  if (S.logOpen) renderLog(t);
  renderMe();
  update3D(prev, t);
  dealFromTesseract();
  tableSounds(prev, t);
}

// 状態の変化に合わせて効果音を鳴らす（再描画だけのとき prev は null なので鳴らない）
function tableSounds(prev, t) {
  if (!prev) return;
  if (prev.handNo !== t.handNo) sfx.play('shuffle');
  t.seats.forEach((s, i) => {
    const ps = prev.seats[i];
    if (!s || !ps || s.lastAction === ps.lastAction) return;
    if (s.lastAction === 'フォールド') sfx.play('shove');
    else if (s.lastAction === 'チェック') sfx.play('knock');
    else if (s.lastAction === 'オールイン') sfx.play('allin');
  });
  if (!prev.actions && t.actions) sfx.play('turn');
}

function renderSeats(t) {
  const box = $('#seats');
  box.textContent = '';
  const hero = heroSeat(t);
  const isHost = S.me && t.hostId === S.me.id;
  const best = bestSet(t);
  t.seats.forEach((s, i) => {
    const div = el('div', 'seat');
    px(div, S.L.seat[disp(i, hero)]);
    div.dataset.i = i;
    div.dataset.d = disp(i, hero);
    if (!s) {
      div.classList.add('empty');
      // 参加者は席を選べない（ホストが空いた席に座らせる）ので、空席の SIT は出さず、下の SIT だけにする（B-33）
      if (t.mySeat < 0 && !(S.room && S.room.role === 'guest')) {
        const b = btnIn(el('button', 'btn'), 'chair', 'SIT');
        b.onclick = () => openBuyIn(i);
        div.append(b);
      }
      if (!div.children.length) div.append(el('span', 'vacant', 'vacant'));
      box.append(div);
      return;
    }
    if (i === t.mySeat) div.classList.add('me');
    if (s.folded) div.classList.add('folded');
    if (s.sittingOut || s.disconnected || s.leaving) div.classList.add('away');
    if (t.toAct === i) div.classList.add('turn');
    if (s.won > 0) div.classList.add('win');
    if (s.cards.length) {
      const hole = el('div', 'hole');
      s.cards.forEach((c, k) => {
        const cls = best ? (best.has(c) ? 'hi' : '') : '';
        hole.append(cardEl(c, `${t.handNo}-${i}-${k}`, cls));
      });
      div.append(hole);
    }
    const pl = el('div', 'plaque');
    pl.append(el('div', 'pname', s.name));
    if (s.isBot) pl.append(el('span', 'plevel', S.levels[s.level] ? S.levels[s.level].label : ''));
    else if (s.id === t.hostId) pl.append(el('span', 'plevel', 'HOST'));
    else pl.append(el('span', 'plevel', 'MEMBER'));
    pl.append(el('div', 'pstack', fmt(s.stack)));
    const tm = el('div', 'ptimer');
    tm.append(el('i'));
    pl.append(tm);
    div.append(pl);
    const rib = s.disconnected ? '切断' : s.leaving ? '退席' : s.sittingOut ? '離席' : (s.allIn && !s.folded && s.inHand) ? 'ALL-IN' : null;
    if (rib) div.append(el('span', 'ribbon', rib));
    let txt = ACTION_EN[s.lastAction] || s.lastAction;
    if (s.handName) txt = s.handName;
    if (s.won > 0) txt = `${s.handName ? s.handName + '　' : ''}+${fmt(s.won)}`;
    if (txt) div.append(el('div', 'paction' + (s.won > 0 || s.handName ? ' hot' : ''), txt));
    box.append(div);
  });

  const d = $('#dealer');
  if (t.button >= 0 && t.seats[t.button]) {
    d.hidden = false;
    px(d, S.L.dealer[disp(t.button, hero)]);
  } else d.hidden = true;
}

function renderBoard(t) {
  const b = $('#board');
  b.textContent = '';
  px(b, S.L.board);
  const best = bestSet(t);
  for (let k = 0; k < 5; k++) {
    const c = t.board[k];
    if (c) b.append(cardEl(c, `${t.handNo}-b-${k}`, best ? (best.has(c) ? 'hi' : 'dim') : ''));
    else b.append(el('div', 'slot'));
  }
}

function renderPotAndBets(t) {
  const pot = $('#pot');
  pot.textContent = '';
  px(pot, S.L.pot);
  if (t.pot > 0) {
    pot.append(el('small', null, 'POT'), el('b', null, fmt(t.pot)));
  }
  const res = $('#result');
  res.textContent = '';
  px(res, S.L.pot);
  if (t.results) {
    for (const w of t.results.winners.slice(0, 3)) {
      const s = t.seats[w.seat];
      if (!s) continue;
      const line = el('div', 'r-line', `${s.name}${w.hand ? '　' + w.hand : ''}`);
      line.append(el('b', null, '+' + fmt(w.amount)));
      res.append(line, el('br'));
    }
  }
  const bets = $('#bets');
  bets.textContent = '';
  t.seats.forEach((s, i) => {
    if (!s || !(s.bet > 0)) return;
    const lb = el('div', 'betlabel', fmt(s.bet));
    px(lb, S.L.bet[disp(i, heroSeat(t))]);
    bets.append(lb);
  });
}

// 3D のチップを状態に合わせる（ベットは席から投げ、回収・配当はテッセラクトを経由）
function update3D(prev, t) {
  if (!stage) return;
  const hero = heroSeat(t);
  const key = `${t.id}:${hero}`;
  const bets = t.seats.map(s => (s ? s.bet : 0));
  if (!prev || S.pileKey !== key) {
    if (!prev && S.pileKey === key) return; // 画面サイズ変更などの再描画では物理状態を保つ
    S.pileKey = key;
    stage.clearPiles(false);
    bets.forEach((b, i) => { if (b > 0) stage.setBet(disp(i, hero), b, false); });
    if (t.pot > 0) stage.setPot(t.pot, false);
    return;
  }
  if (prev.handNo !== t.handNo) {
    stage.clearPiles(true);
    bets.forEach((b, i) => { if (b > 0) stage.setBet(disp(i, hero), b, true); });
    if (t.pot > 0) stage.setPot(t.pot, false);
    return;
  }
  bets.forEach((b, i) => {
    const pb = prev.seats[i] ? prev.seats[i].bet : 0;
    if (b !== pb) stage.setBet(disp(i, hero), b, b > pb);
  });
  if (t.pot !== prev.pot) stage.setPot(t.pot, t.pot > prev.pot);
  if (!prev.results && t.results) {
    for (const w of t.results.winners) if (w.amount > 0) stage.payout(disp(w.seat, hero), w.amount);
  }
}

// 新しく配られたカードを、テッセラクトから飛び出すように見せる
function dealFromTesseract() {
  const fresh = [...document.querySelectorAll('#felt .card.pending')];
  if (!fresh.length) return;
  const area = S.L.area;
  const tx = area.left + S.L.tess.x, ty = area.top + S.L.tess.y;
  fresh.forEach((c, k) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty('--fx', `${tx - (r.left + r.width / 2)}px`);
    c.style.setProperty('--fy', `${ty - (r.top + r.height / 2)}px`);
    c.style.setProperty('--dd', `${k * 70}ms`);
    c.classList.remove('pending');
    c.classList.add('deal');
    sfx.play(c.closest('#board') ? 'place' : 'slide', { delay: k * 70 + 250 }); // 札が着く頃に鳴らす
  });
  stage?.pulse(1);
}

function doAct(kind) {
  const t = S.table;
  const a = t && t.actions;
  if (!a) return;
  sfx.play('click');
  if (kind === 'fold') send({ t: 'action', type: 'fold' });
  else if (kind === 'call') send({ t: 'action', type: a.canCheck ? 'check' : 'call' });
  else if (kind === 'raise') {
    if (!a.canRaise) return;
    const amt = S.raiseTo >= a.maxRaiseTo ? a.maxRaiseTo : S.raiseTo;
    send({ t: 'action', type: amt >= a.maxRaiseTo ? 'allin' : 'raise', amount: amt });
  }
  t.actions = null;
  renderActions(t);
}

function renderActions(t) {
  const bar = $('#actionbar');
  bar.textContent = '';
  const me = t.mySeat >= 0 ? t.seats[t.mySeat] : null;
  const info = el('div', 'ab-info');
  bar.append(info);
  if (t.myHand) info.append(el('span', 'ab-hand', t.myHand));
  // マルチプレイの開始待ち：ホストは「空席を CPU で埋める」を選んで START（座った人が2人以上で押せる）。2026-11-25 決定
  if (t.waiting) {
    const n = t.seats.filter(s => s && !s.isBot && !s.leaving && s.stack > 0).length;
    const btns = el('div', 'ab-btns');
    if (S.room && S.room.role === 'host') {
      info.append(el('span', 'ab-note', `参加者を待っています（着席 ${n}人）。2人以上で開始できます。`));
      const opt = el('label', 'online-opt');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.id = 'fill-bots';
      cb.checked = S.fillBots !== false;
      cb.onchange = () => { S.fillBots = cb.checked; };
      opt.append(cb, el('span', null, '空席を CPU で埋める'));
      const b = btnIn(el('button', 'btn btn-primary'), 'check', 'START');
      b.id = 'b-start';
      b.disabled = n < 2;
      b.onclick = () => send({ t: 'startGame', fillBots: cb.checked });
      btns.append(opt, b);
    } else {
      info.append(el('span', 'ab-note', `ホストの開始を待っています（着席 ${n}人）。`));
      if (!me && S.room && S.room.role === 'guest') {
        const b = btnIn(el('button', 'btn btn-primary'), 'chair', 'SIT');
        b.onclick = () => openBuyIn(-1);
        btns.append(b);
      }
    }
    bar.append(btns);
    return;
  }
  if (!me) {
    if (S.room && S.room.role === 'guest') {
      info.append(el('span', 'ab-note', '座ると、次のハンドから CPU と入れ替わります。'));
      const btns = el('div', 'ab-btns');
      const b = btnIn(el('button', 'btn btn-primary'), 'chair', 'SIT');
      b.onclick = () => openBuyIn(-1);
      btns.append(b);
      bar.append(btns);
      return;
    }
    info.append(el('span', 'ab-note', '空いている席の「着席」から座れます。'));
    return;
  }
  if (me.sittingOut && !t.actions) {
    const btns = el('div', 'ab-btns');
    if (me.stack > 0) {
      info.append(el('span', 'ab-note', '離席中です。'));
      const b = btnIn(el('button', 'btn btn-primary'), 'login', 'RETURN');
      b.onclick = () => send({ t: 'sitBack' });
      btns.append(b);
    } else {
      info.append(el('span', 'ab-note', 'チップがありません。'));
      const b = btnIn(el('button', 'btn btn-primary'), 'add', 'ADD CHIPS');
      b.onclick = openRebuy;
      btns.append(b);
    }
    bar.append(btns);
    return;
  }
  const a = t.actions;
  if (!a) {
    let note = '';
    if (t.toAct >= 0 && t.seats[t.toAct]) note = `${t.seats[t.toAct].name} の番です`;
    else if (!t.inHand) note = '次のハンドを待っています';
    if (note) info.append(el('span', 'ab-note', note));
    return;
  }
  info.append(el('span', 'ab-clock', ''));
  info.lastChild.id = 'ab-clock';

  const key = `${t.handNo}-${t.street}-${a.currentBet}-${a.myBet}`;
  if (S.raiseKey !== key) {
    S.raiseKey = key;
    S.raiseTo = a.minRaiseTo;
  }
  const btns = el('div', 'ab-btns');
  if (!a.canCheck) {
    const f = el('button', 'act fold');
    f.append(icon('close'), el('span', null, 'FOLD'), el('kbd', null, 'F'));
    f.onclick = () => doAct('fold');
    btns.append(f);
  }
  const c = el('button', 'act call');
  if (a.canCheck) c.append(icon('check'), el('span', null, 'CHECK'));
  else if (a.toCall >= me.stack) c.append(icon('bolt'), el('span', null, 'ALL-IN'), el('small', null, fmt(a.toCall)));
  else c.append(icon('check'), el('span', null, 'CALL'), el('small', null, fmt(a.toCall)));
  c.append(el('kbd', null, 'C'));
  c.onclick = () => doAct('call');
  btns.append(c);

  if (a.canRaise && me.stack > a.toCall) {
    const verb = a.currentBet === 0 ? 'BET' : 'RAISE';
    const rb = el('div', 'raise-box');
    const pre = el('div', 'presets');
    const potAfter = a.totalPot + a.toCall;
    const clampR = v => Math.max(a.minRaiseTo, Math.min(a.maxRaiseTo, Math.round(v / 5) * 5));
    const row = el('div', 'raise-row');
    const range = el('input');
    range.type = 'range';
    range.min = a.minRaiseTo; range.max = a.maxRaiseTo; range.step = 5; range.value = S.raiseTo;
    range.setAttribute('aria-label', `${verb}額`);
    const out = el('output', null, fmt(S.raiseTo));
    const r = el('button', 'act raise');
    const rLabel = el('span', null, verb);
    const rAmt = el('small', null, fmt(S.raiseTo));
    const rIcon = icon('north');
    r.append(rIcon, rLabel, rAmt, el('kbd', null, 'R'));
    const sync = v => {
      S.raiseTo = clampR(v);
      range.value = S.raiseTo;
      out.textContent = fmt(S.raiseTo);
      rAmt.textContent = fmt(S.raiseTo);
      rLabel.textContent = S.raiseTo >= a.maxRaiseTo ? 'ALL-IN' : verb;
      rIcon.textContent = S.raiseTo >= a.maxRaiseTo ? 'bolt' : 'north';
    };
    for (const [label, frac] of [['½ POT', 0.5], ['¾ POT', 0.75], ['POT', 1], ['ALL-IN', 'max']]) {
      const b = el('button', null, label);
      if (frac === 'max') b.prepend(icon('bolt'));
      b.type = 'button';
      b.onclick = () => sync(frac === 'max' ? a.maxRaiseTo : a.currentBet + potAfter * frac);
      pre.append(b);
    }
    range.oninput = () => sync(Number(range.value));
    r.onclick = () => doAct('raise');
    row.append(range, out);
    rb.append(pre, row);
    btns.append(r);
    bar.append(btns, rb);
    sync(S.raiseTo);
  } else {
    bar.append(btns);
  }
}

function renderLog(t) {
  const ol = $('#log');
  ol.textContent = '';
  for (const e of t.log) ol.append(el('li', e.text.startsWith('―') ? 'sep' : '', e.text));
  ol.scrollTop = ol.scrollHeight;
}

// ---------------- タイマー表示 ----------------
function frame() {
  const t = S.table;
  if (t && S.screen === 'room' && t.toAct >= 0 && t.deadlineIn > 0) {
    // 参加者は、通信の遅れの分（1.5秒）だけ短く見せる。表示が残っていてもホストでは時間切れ、を防ぐ（B-44）
    const lag = S.room && S.room.role === 'guest' ? 1500 : 0;
    const rem = Math.max(0, t.deadlineIn - lag - (performance.now() - S.recvAt));
    const bar = $(`#seats .seat[data-i="${t.toAct}"] .ptimer i`);
    if (bar) {
      bar.style.width = (100 * rem) / t.actionMs + '%';
      bar.classList.toggle('low', rem < 8000);
    }
    const clock = $('#ab-clock');
    if (clock) clock.textContent = `残り ${Math.ceil(rem / 1000)} 秒`;
  }
  requestAnimationFrame(frame);
}

// ---------------- 初期化 ----------------
function bind() {
  // 拡大縮小を止める（iPhone の Safari は viewport の user-scalable=no を無視するため）
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
  // 1本指で引っぱったときにページごと動く（跳ね返る）のも止める。中身がスクロールする「記録」とダイアログ、
  // レイズ額などのスライダーは除く（2026-11-18）
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1) { e.preventDefault(); return; }
    if (e.target.closest && e.target.closest('#log, dialog, input[type=range]')) return;
    e.preventDefault();
  }, { passive: false });
  $('#crest').innerHTML = crestSVG();
  const lg = $('#chip-legend');
  for (const d of LEGEND) {
    const div = el('div');
    div.innerHTML = polySVG(d.shape, d.color);
    div.title = d.name;
    div.append(el('span', null, fmt(d.v)));
    lg.append(div);
  }
  $('#gate-form').onsubmit = e => {
    e.preventDefault();
    const name = $('#g-name').value.trim();
    if (!name) return;
    local.set('nocturne.name', name);
    S.kicked = false;
    $('#g-error').textContent = '';
    S.hello = { t: 'hello', name };
    send(S.hello);
  };
  $('#b-single').onclick = () => openCreate('single');
  $('#b-multi').onclick = openMulti;
  $('#b-invite').onclick = copyInvite;
  $('#b-back').onclick = () => send({ t: 'leaveTable' });
  $('#b-stand').onclick = () => send({ t: 'stand' });
  $('#b-rebuy').onclick = openRebuy;
  $('#b-log').onclick = () => {
    S.logOpen = !S.logOpen;
    $('#logpanel').hidden = !S.logOpen;
    if (S.logOpen && S.table) renderLog(S.table);
  };
  $('#b-log-close').onclick = () => { S.logOpen = false; $('#logpanel').hidden = true; };
  const sound = $('#b-sound');
  const syncSound = () => {
    btnIn(sound, sfx.isMuted() ? 'volume_off' : 'volume_up');
    sound.setAttribute('aria-label', sfx.isMuted() ? '音：オフ' : '音：オン');
    sound.setAttribute('aria-pressed', String(!sfx.isMuted()));
  };
  sound.onclick = () => { sfx.setMuted(!sfx.isMuted()); syncSound(); sfx.play('click'); };
  syncSound();
  document.addEventListener('keydown', e => {
    if (S.screen !== 'room' || !S.table || !S.table.actions || $('#dlg').open) return;
    if (e.target.matches('input:not([type=range]), select, textarea')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f' && !S.table.actions.canCheck) doAct('fold');
    else if (k === 'c') doAct('call');
    else if (k === 'r') doAct('raise');
  });
  let rz = 0;
  let lastW = 0, lastH = 0;
  setInterval(() => { // 背面タブなど resize が来ない場合の保険
    if (S.screen === 'room' && (innerWidth !== lastW || innerHeight !== lastH)) {
      lastW = innerWidth; lastH = innerHeight;
      computeLayout(); renderRoom(null);
    }
  }, 500);
  window.addEventListener('resize', () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => {
      if (S.screen === 'room') { computeLayout(); renderRoom(null); }
    });
  });
}

async function init() {
  bind();
  // 招待リンク（?room=XXXXXX）で開いたら覚えておき、URL からは消す
  const inv = normalizeCode(new URLSearchParams(location.search).get('room'));
  if (isValidCode(inv)) { S.inviteCode = inv; history.replaceState(null, '', location.pathname + location.hash); }
  try {
    const m = await import('./chips-physics.js');
    stage = new m.TableStage($('#stage'));
    stage.onSound = (name, opts) => sfx.play(name, opts);
    if (location.hash === '#debug') window.__nocturne = { stage, S, sfx };
    stage.setMode(S.screen === 'gate' ? 'showcase' : S.screen === 'room' ? 'table' : 'lounge');
    if (S.screen === 'room' && S.table) { computeLayout(); renderRoom(null); }
  } catch (e) {
    console.warn('3D 表示を使えません:', e);
  }
  requestAnimationFrame(frame);
  // #sound を付けて開いたときだけ、効果音の診断表示を出す（2026-11-19）
  if (location.hash.includes('sound')) import('./sound-debug.js').then(m => m.mountSoundDebug(sfx)).catch(e => console.warn('診断表示を出せません:', e));
  $('#g-key-wrap').hidden = true;
  const name = LOCAL.playerName() || local.get('nocturne.name');
  if (name) $('#g-name').value = name;
  // 2回目以降は名前の入力を省いてロビーへ
  if (LOCAL.hasPlayer()) { S.hello = { t: 'hello', name }; send(S.hello); }
  registerServiceWorker();
}

// オフラインで動くように Service Worker を登録する（https か localhost のときだけ有効）
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('Service Worker を登録できません:', e));
}

init();
