// 端末内サーバー：PC 版 server.js の代わりに、同じ形式のメッセージをやり取りする。
// メンバー情報（手持ち・今回の成績・自己ベスト・解放状況）は端末の localStorage に保存する。
// スマホ単体版のルール：借金と補充はなし。手持ち＋卓上チップが最小卓の最低バイイン未満になったらゲームオーバー。
// ネット対戦（2026-11-20）：卓を開いた端末（ホスト）がこの中で卓を進め、友達の端末（参加者）は Firebase 経由で
// 操作を送り、自分向けの卓の状態を受け取る。チップは各自の端末の手持ちから出し入れする（精算は js/online.js 参照）。
import { Table, N as SEATS } from './engine/table.js';
import { LEVELS } from './engine/bots.js';

export const CONFIG = {
  startingWallet: 5000,
  stakes: [
    { id: 'low', sb: 5, bb: 10 },
    { id: 'mid', sb: 25, bb: 50 },
    { id: 'high', sb: 100, bb: 200 },
  ],
  buyInMinBB: 40,
  buyInMaxBB: 200,
  actionSeconds: 30,
  disconnectGraceSeconds: 90,
  botBuyInBB: 100,
};

// 卓のレートごとに座る CPU（席 1〜6。席 0 はあなた）。チップが尽きた CPU も同じ割合から選び直す
const LINEUP = {
  low: ['novice', 'novice', 'novice', 'novice', 'regular', 'regular'],
  mid: ['novice', 'regular', 'regular', 'regular', 'regular', 'shark'],
  high: ['regular', 'regular', 'shark', 'shark', 'shark', 'shark'],
};
// 支配人を解放済みなら、最高レートの卓を開くたびにこの確率で勝負師1人が支配人に代わる
const PROPRIETOR_CHANCE = 1 / 3;
const pick = a => a[Math.floor(Math.random() * a.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const HOST_GONE_MS = 60000; // ホストの接続が切れてから卓を閉じたとみなすまで
const GUEST_GRACE_MS = CONFIG.disconnectGraceSeconds * 1000; // 参加者が切れてから席を外すまで
const loadOnline = () => import('./online.js');

const KEY = 'nocturne.mobile.v1';
const UNIT = 5;
const fmt = n => Number(n).toLocaleString('en-US');
const minStake = CONFIG.stakes.reduce((a, s) => (s.bb < a.bb ? s : a), CONFIG.stakes[0]);
// これを下回ると、どの卓にも座れない＝ゲームオーバー
const GAMEOVER_BELOW = minStake.bb * CONFIG.buyInMinBB;
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
const int = v => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : NaN);

const newRun = (peak = CONFIG.startingWallet) => ({ hands: 0, won: 0, peak, bestWin: 0, started: Date.now() });
const newBest = () => ({ peak: 0, hands: 0, bestWin: 0, runs: 0 });

function loadPlayer() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (p && p.id) {
      // 以前の版（借金・補充あり）のデータから移行する
      delete p.debt; delete p.refillAt;
      if (!p.run) p.run = newRun((p.wallet || 0) + (p.tableStack || 0)); // 移行時はその時点の額から数える
      if (!p.best) p.best = newBest();
      return p;
    }
  } catch { /* 読めなければ新規 */ }
  return null;
}

function makeDecider() {
  try {
    const worker = new Worker(new URL('./engine/bot-worker.js', import.meta.url), { type: 'module' });
    let seq = 0;
    const waiting = new Map();
    worker.onmessage = e => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      e.data.d ? w.res(e.data.d) : w.rej(new Error('decide failed'));
    };
    worker.onerror = () => { for (const w of waiting.values()) w.rej(new Error('worker error')); waiting.clear(); };
    return ctx => new Promise((res, rej) => {
      const id = ++seq;
      waiting.set(id, { res, rej });
      worker.postMessage({ id, ctx });
    });
  } catch {
    return null; // Worker が使えない環境では画面のスレッドで判断する
  }
}

export function createLocalServer(onMessage) {
  const decider = makeDecider();
  let player = loadPlayer();
  let table = null;
  let viewing = false;
  let saveTimer = null;
  let ending = false;
  let countedHand = -1;
  let host = null; // ネット対戦のホストのとき：{ code, api, remotes: Map(uid → { name, pid, online, timer, offInbox }), queue: [], offs }
  let guest = null; // ネット対戦の参加者のとき：{ code, api, state, meta, offs, hostTimer, leaving }

  const send = msg => queueMicrotask(() => onMessage(msg));

  const mySeat = () => (table && player ? table.seatOf(player.id) : -1);
  const chipsOnTable = () => {
    if (guest) {
      const st = guest.state;
      const s = st && st.mySeat >= 0 ? st.seats[st.mySeat] : null;
      return s ? s.stack + (s.total || 0) + (s.pendingRebuy || 0) : 0;
    }
    const i = mySeat();
    if (i < 0) return 0;
    const s = table.seats[i];
    return s.stack + s.total + s.pendingRebuy;
  };
  const total = () => player.wallet + chipsOnTable();

  // 卓上のチップも保存しておき、次回起動時に手持ちへ戻す（アプリを閉じても失われないように）
  const write = () => {
    if (guest) {
      player.tableStack = 0;
      player.online = { code: guest.code, uid: guest.api.uid, chips: chipsOnTable(), paid: player.online?.paid || [] };
    } else player.tableStack = chipsOnTable();
    try { localStorage.setItem(KEY, JSON.stringify(player)); } catch { /* 保存できない環境 */ }
  };
  const save = () => {
    if (!player) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(write, 150);
  };
  const saveNow = () => {
    if (!player) return;
    clearTimeout(saveTimer);
    write();
  };
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

  const meOf = () => ({
    id: player.id, name: player.name, wallet: player.wallet, unlocked: player.unlocked,
    onTable: chipsOnTable(), seatedAt: mySeat() >= 0 ? table.id : null,
    run: player.run, best: player.best, gameOverBelow: GAMEOVER_BELOW,
  });
  const sendMe = () => send({ t: 'me', me: meOf() });
  const lobbyList = () => {
    if (guest && guest.state) return [{ id: 'remote', name: guest.state.name, sb: guest.state.sb, bb: guest.state.bb, hostName: guest.meta?.hostName || '', room: guest.code, seats: guest.state.seats.map(x => (x ? { isBot: x.isBot } : null)) }];
    return table ? [{ ...table.summary(), hostName: player.name, room: host?.code || null }] : [];
  };
  const sendTable = () => {
    if (!viewing) return;
    if (guest) { if (guest.state) send({ t: 'table', table: guest.state }); return; }
    if (table) send({ t: 'table', table: table.publicState(player.id) });
  };

  // ハンドの結果を成績に数える（1ハンドにつき1回）
  function countGuestHand(st) {
    if (!st || !st.results || st.handNo === countedHand) return;
    countedHand = st.handNo;
    const me = st.mySeat;
    if (me < 0 || !st.seats[me] || !st.seats[me].inHand) return;
    player.run.hands++;
    const w = st.results.winners.find(x => x.seat === me);
    if (w) { player.run.won++; player.run.bestWin = Math.max(player.run.bestWin, w.amount); }
  }

  function countHand() {
    const h = table && table.hand;
    if (!h || !h.results || h.no === countedHand) return;
    countedHand = h.no;
    const i = mySeat();
    if (i < 0 || !table.seats[i].inHand) return;
    player.run.hands++;
    const w = h.results.winners.find(x => x.seat === i);
    if (w) {
      player.run.won++;
      player.run.bestWin = Math.max(player.run.bestWin, w.amount);
    }
  }

  // ゲームオーバーの判定：ハンドの合間（または卓にいないとき）だけ行う
  function checkGameOver() {
    if (!player || ending) return false;
    if (table && table.hand && mySeat() >= 0) return false;
    if (guest && guest.state && guest.state.inHand && guest.state.mySeat >= 0) return false;
    if (total() >= GAMEOVER_BELOW) return false;
    ending = true;
    if (guest) leaveGuest('gameover');
    if (table) { table.close(); table = null; closeHost(); } // 残りの卓上チップは手持ちに戻る（友達の分は精算を書く）
    viewing = false;
    const run = { ...player.run, end: player.wallet, ended: Date.now() };
    const prev = { ...player.best };
    const best = player.best;
    best.runs++;
    best.peak = Math.max(best.peak, run.peak);
    best.hands = Math.max(best.hands, run.hands);
    best.bestWin = Math.max(best.bestWin, run.bestWin);
    const records = {
      peak: run.peak > prev.peak, hands: run.hands > prev.hands, bestWin: run.bestWin > prev.bestWin,
    };
    // 最初からやり直す（支配人の解放状況と自己ベストは残す）
    player.wallet = CONFIG.startingWallet;
    player.run = newRun();
    player.tableStack = 0;
    countedHand = -1;
    saveNow();
    ending = false;
    send({ t: 'gameover', run, best: { ...best }, records, startingWallet: CONFIG.startingWallet });
    send({ t: 'lobby', tables: lobbyList() });
    sendMe();
    return true;
  }

  function createTable(name, stake) {
    if (table) { ending = true; table.close(); ending = false; closeHost(); } // 前の卓は閉じて、卓上のチップを手持ちに戻す
    if (guest) leaveGuest('newTable');
    countedHand = -1;
    table = new Table({
      id: 'local', name, sb: stake.sb, bb: stake.bb, hostId: player.id, config: CONFIG, decider,
      hooks: {
        // チップが尽きた CPU は、同じレートの顔ぶれから選び直した CPU に入れ替える
        replaceBot: s => (s.level === 'proprietor' ? 'proprietor' : pick(LINEUP[stake.id] || LINEUP.low)),
        onChange: () => {
          countHand();
          player.run.peak = Math.max(player.run.peak, total());
          if (host) hostSync();
          if (!checkGameOver()) { sendTable(); save(); }
        },
        onCashOut: (pid, amount) => {
          if (host && String(pid).startsWith('fb:')) { host.api.payout(pid.slice(3), amount, 'cashout'); return; }
          if (pid !== player.id) return;
          player.wallet += amount;
          save();
          setTimeout(() => { if (!checkGameOver()) sendMe(); });
        },
        onUnlock: (pid, botName) => {
          if (pid !== player.id || player.unlocked) return;
          player.unlocked = true;
          save();
          send({ t: 'unlocked', botName });
          sendMe();
        },
      },
    });
    return table;
  }


  // ================= ネット対戦：ホスト側 =================
  // 友達はそれぞれ「fb:<uid>」という ID で席に座る。卓が変わるたびに、各自向けの状態（自分の手札だけ見える）を書く
  let syncQueued = false;
  function hostSync() {
    if (!host || syncQueued) return;
    syncQueued = true;
    queueMicrotask(() => {
      syncQueued = false;
      if (!host || !table) return;
      processSitQueue();
      for (const [uid, r] of host.remotes) host.api.writeState(uid, { ...table.publicState(r.pid), room: host.code });
    });
  }

  // 空席がなければ、ハンドに参加していない CPU（いなければ誰か）に席を立ってもらい、空いたら座らせる
  function processSitQueue() {
    while (host.queue.length) {
      const q = host.queue[0];
      const r = host.remotes.get(q.uid);
      if (!r || table.seatOf(r.pid) >= 0) { host.queue.shift(); continue; }
      const free = table.seats.findIndex(x => !x);
      if (free < 0) {
        if (!table.seats.some(x => x && x.isBot && x.leaving)) {
          const bots = table.seats.map((x, i) => (x && x.isBot ? i : -1)).filter(i => i >= 0);
          if (!bots.length) { host.queue.shift(); host.api.payout(q.uid, q.amount, 'nofree'); continue; }
          const idle = bots.find(i => !table.seats[i].inHand);
          table.removeSeat(idle !== undefined ? idle : bots[bots.length - 1]);
        }
        return; // 席が空くのは次のハンドの前
      }
      host.queue.shift();
      table.sit(free, { id: r.pid, name: r.name }, q.amount);
    }
  }

  function removeRemote(uid, payout = true) {
    const r = host && host.remotes.get(uid);
    if (!r) return;
    clearTimeout(r.timer);
    r.offInbox && r.offInbox();
    host.remotes.delete(uid);
    host.queue = host.queue.filter(q => { if (q.uid === uid && payout) host.api.payout(uid, q.amount, 'left'); return q.uid !== uid; });
    const i = table ? table.seatOf(r.pid) : -1;
    if (i >= 0) {
      if (!payout) { const x = table.seats[i]; x.stack = 0; x.pendingRebuy = 0; } // 参加者が自分で手持ちに戻した
      table.removeSeat(i);
    }
  }

  function handleRemote(uid, m) {
    const r = host && host.remotes.get(uid);
    if (!r || !table) return;
    const i = table.seatOf(r.pid);
    try {
      switch (m.t) {
        case 'sit': {
          const amt = Math.round(int(m.amount) / UNIT) * UNIT;
          if (i >= 0 || !(amt >= table.minBuyIn && amt <= table.maxBuyIn)) { if (amt > 0) host.api.payout(uid, amt, 'refund'); return; }
          host.queue.push({ uid, amount: amt });
          processSitQueue();
          hostSync();
          return;
        }
        case 'stand': if (i >= 0) table.removeSeat(i); return;
        case 'rebuy': {
          const amt = Math.round(int(m.amount) / UNIT) * UNIT;
          const x = i >= 0 ? table.seats[i] : null;
          if (!x || !(amt > 0) || amt > table.maxBuyIn - (x.stack + x.pendingRebuy)) { if (amt > 0) host.api.payout(uid, amt, 'refund'); return; }
          table.rebuy(r.pid, amt);
          return;
        }
        case 'action': table.actBy(r.pid, String(m.type), m.amount); return;
        case 'sitBack': table.sitBack(r.pid); return;
        case 'leave': removeRemote(uid, true); return;
        case 'abandon': removeRemote(uid, false); return; // ホストが消えたと判断して、自分で手持ちに戻した
      }
    } catch { /* 番が違うなどの依頼は無視する（状態は次の送信で正しくなる） */ }
  }

  async function startHost(stake) {
    const on = await loadOnline();
    const code = await on.createRoom({ name: table.name, sb: stake.sb, bb: stake.bb, hostName: player.name });
    const api = on.hostApi(code);
    host = { code, api, remotes: new Map(), queue: [], offs: [] };
    host.offs.push(api.startPresence());
    host.offs.push(api.watchMembers((kind, uid, v) => {
      if (!host) return;
      if (kind === 'removed') { removeRemote(uid, true); return; }
      let r = host.remotes.get(uid);
      if (!r) {
        r = { name: cleanName(v && v.name) || 'Guest', pid: 'fb:' + uid, online: true, timer: null };
        host.remotes.set(uid, r);
        r.offInbox = api.watchInbox(uid, m => handleRemote(uid, m));
        if (table) { table.addLog(r.name + ' が卓に来ました'); table.changed(); }
      }
      const online = !(v && v.online === false);
      if (online !== r.online || kind === 'added') {
        r.online = online;
        if (table && table.seatOf(r.pid) >= 0) table.setDisconnected(r.pid, !online);
        clearTimeout(r.timer);
        if (!online) r.timer = setTimeout(() => removeRemote(uid, true), GUEST_GRACE_MS); // 戻らなければ席を外して精算
      }
      hostSync();
    }));
    send({ t: 'room', code, role: 'host' });
    hostSync();
    return code;
  }

  function closeHost() {
    if (!host) return;
    const h = host; host = null;
    h.offs.forEach(o => o && o());
    for (const r of h.remotes.values()) { clearTimeout(r.timer); r.offInbox && r.offInbox(); }
    for (const q of h.queue) h.api.payout(q.uid, q.amount, 'closed');
    h.api.close();
    send({ t: 'room', code: null });
  }

  // ================= ネット対戦：参加者側 =================
  function creditPayout(key, v) {
    const paid = (player.online && player.online.paid) || [];
    if (paid.includes(key)) return;
    paid.push(key);
    player.online = { ...(player.online || {}), paid: paid.slice(-200) };
    const amt = Math.max(0, int(v && v.amount) || 0);
    if (amt > 0) {
      player.wallet += amt;
      const why = { refund: '（席が用意できなかったため返金）', nofree: '（空席がなかったため返金）', closed: '（卓が閉じられました）' }[v.reason] || '';
      send({ t: 'toast', text: fmt(amt) + ' を手持ちに戻しました' + why, kind: 'gold' });
    }
    saveNow();
    sendMe();
  }

  async function joinGuest(code, { quiet = false } = {}) {
    const on = await loadOnline();
    const { meta } = await on.joinRoom(code, player.name);
    if (table) { ending = true; table.close(); ending = false; table = null; closeHost(); }
    const api = on.guestApi(code);
    guest = { code, api, state: null, meta, offs: [], hostTimer: null };
    countedHand = -1;
    player.online = { code, uid: api.uid, chips: 0, paid: (player.online && player.online.code === code && player.online.paid) || [] };
    saveNow();
    guest.offs.push(api.startPresence());
    guest.offs.push(api.watchPayouts((key, v) => creditPayout(key, v)));
    guest.offs.push(api.watchState(st => {
      if (!guest) return;
      guest.state = st;
      countGuestHand(st);
      player.run.peak = Math.max(player.run.peak, total());
      save();
      if (!checkGameOver()) sendTable();
    }));
    guest.offs.push(api.watchMeta(m => {
      if (!guest || !m) return;
      guest.meta = m;
      if (m.closed) { send({ t: 'toast', text: 'ホストが卓を閉じました', kind: 'gold' }); leaveGuest('closed', 4000); return; }
      clearTimeout(guest.hostTimer);
      if (m.hostOnline === false) {
        send({ t: 'toast', text: 'ホストとの接続が切れています。60秒待っても戻らなければ卓を閉じます', kind: 'err' });
        guest.hostTimer = setTimeout(() => hostGone(), HOST_GONE_MS);
      }
    }));
    viewing = true;
    send({ t: 'room', code, role: 'guest' });
    if (!quiet) send({ t: 'toast', text: '部屋 ' + code + ' に入りました', kind: 'gold' });
    send({ t: 'created', tableId: 'remote' });
  }

  // ホストが戻らない：卓上にあった自分のチップを自分で手持ちに戻し、ホストにはそのことを伝えておく
  function hostGone() {
    if (!guest) return;
    const chips = chipsOnTable();
    if (chips > 0) {
      player.wallet += chips;
      send({ t: 'toast', text: 'ホストが戻らないため、卓上の ' + fmt(chips) + ' を手持ちに戻しました', kind: 'gold' });
    }
    guest.api.send({ t: 'abandon' }).catch(() => {});
    leaveGuest('hostGone');
  }

  // 部屋を出る。しばらくは精算の受け取りを続ける
  function leaveGuest(reason, delay = 3000) {
    if (!guest) return;
    const g = guest; guest = null;
    clearTimeout(g.hostTimer);
    if (reason !== 'hostGone' && reason !== 'closed') g.api.send({ t: 'leave' }).catch(() => {});
    setTimeout(() => { g.offs.forEach(o => o && o()); g.api.leave(); }, delay);
    if (reason === 'hostGone' || reason === 'closed') player.online = null;
    else if (player.online) player.online = { ...player.online, chips: 0, left: true }; // 次回の起動では精算だけ受け取り、部屋には戻らない
    viewing = false;
    countedHand = -1;
    saveNow();
    send({ t: 'room', code: null });
    if (reason !== 'newTable' && reason !== 'gameover') { send({ t: 'lobby', tables: lobbyList() }); sendMe(); }
  }

  // 起動時：前回ネット対戦の途中で閉じていたら、精算を受け取り、卓が続いていれば戻る
  async function resumeOnline() {
    const o = player.online;
    if (!o || !o.code) return;
    try {
      const on = await loadOnline();
      if (!on.isOnlineReady()) return;
      const meta = await on.readRoom(o.code);
      const api = on.guestApi(o.code);
      const pays = await api.readPayouts();
      for (const [k, v] of Object.entries(pays)) creditPayout(k, v);
      if (!o.left && meta && !meta.closed && meta.hostOnline !== false) { await joinGuest(o.code, { quiet: true }); return; }
      if (!o.left && meta && !meta.closed && o.chips > 0) { // ホストが消えたまま：前回の卓上チップを自分で戻す
        player.wallet += o.chips;
        send({ t: 'toast', text: '前回の卓（部屋 ' + o.code + '）のチップ ' + fmt(o.chips) + ' を手持ちに戻しました', kind: 'gold' });
        api.send({ t: 'abandon' }).catch(() => {});
      }
      player.online = null;
      saveNow();
      sendMe();
    } catch { /* つながらなければ次回また試す */ }
  }

  // 参加者のときの依頼：手持ちの出し入れはこの端末で行い、卓の操作はホストへ送る
  function guestHandle(msg) {
    const st = guest.state;
    switch (msg.t) {
      case 'sit': {
        const amt = Math.round(int(msg.amount) / UNIT) * UNIT;
        if (!st) throw new Error('卓の状態を受け取るまでお待ちください');
        if (st.mySeat >= 0) throw new Error('すでに着席しています');
        if (!(amt >= st.minBuyIn && amt <= st.maxBuyIn)) throw new Error('バイインは ' + fmt(st.minBuyIn) + '〜' + fmt(st.maxBuyIn) + ' です');
        if (amt > player.wallet) throw new Error('手持ちが足りません');
        player.wallet -= amt;
        saveNow(); sendMe();
        guest.api.send({ t: 'sit', amount: amt });
        send({ t: 'toast', text: '席を用意しています（空き次第、次のハンドから座ります）', kind: 'gold' });
        return true;
      }
      case 'rebuy': {
        const amt = Math.round(int(msg.amount) / UNIT) * UNIT;
        if (!(amt > 0) || amt > player.wallet) throw new Error('手持ちが足りません');
        player.wallet -= amt;
        saveNow(); sendMe();
        guest.api.send({ t: 'rebuy', amount: amt });
        return true;
      }
      case 'stand': guest.api.send({ t: 'stand' }); return true;
      case 'action': guest.api.send({ t: 'action', type: String(msg.type), amount: msg.amount }); return true;
      case 'sitBack': guest.api.send({ t: 'sitBack' }); return true;
      case 'leaveTable': leaveGuest('leave'); return true;
      case 'joinTable': viewing = true; sendTable(); return true;
      default: return false; // hello・lobby などは通常の処理へ
    }
  }

  function handle(msg) {
    if (msg.t !== 'hello' && !player) throw new Error('先に入場してください');
    if (guest && guestHandle(msg)) return;
    switch (msg.t) {
      case 'hello': {
        const name = cleanName(msg.name) || (player && player.name);
        if (!name) { send({ t: 'gate', error: 'お名前を入力してください' }); return; }
        if (!player) {
          player = {
            id: 'me-' + Math.random().toString(36).slice(2, 10), name, wallet: CONFIG.startingWallet,
            unlocked: false, tableStack: 0, run: newRun(), best: newBest(), created: Date.now(),
          };
        }
        player.name = name;
        if (player.tableStack > 0 && !table) { // 前回、卓に置いたまま閉じたチップを戻す
          player.wallet += player.tableStack;
          send({ t: 'toast', text: `前回の卓のチップ ${fmt(player.tableStack)} を手持ちに戻しました`, kind: 'gold' });
          player.tableStack = 0;
        }
        saveNow();
        const levels = Object.fromEntries(Object.entries(LEVELS).map(([k, L]) => [k, { label: L.label, en: L.en, hidden: !!L.hidden }]));
        send({
          t: 'welcome', token: 'local', me: meOf(), levels,
          stakes: CONFIG.stakes, buyIn: [CONFIG.buyInMinBB, CONFIG.buyInMaxBB], gameOverBelow: GAMEOVER_BELOW,
        });
        if (checkGameOver()) return;
        if (viewing && (table || guest)) sendTable();
        else send({ t: 'lobby', tables: lobbyList() });
        if (player.online && !guest) resumeOnline();
        return;
      }
      case 'joinRoom': {
        const code = String(msg.code || '').toUpperCase();
        if (!/^[A-Z2-9]{6}$/.test(code)) throw new Error('部屋コードは6文字です');
        joinGuest(code).catch(e => send({ t: 'error', text: e.message || '部屋に入れませんでした' }));
        return;
      }
      case 'lobby':
        send({ t: 'lobby', tables: lobbyList() });
        return;
      case 'createTable': {
        const stake = CONFIG.stakes.find(s => s.id === msg.stake);
        if (!stake) throw new Error('ステークスが不正です');
        // CPU は自動で満席にする（席 0 はあなた）
        const levels = shuffle([...(LINEUP[stake.id] || LINEUP.low)]);
        if (stake.id === 'high' && player.unlocked && Math.random() < PROPRIETOR_CHANCE) {
          levels[levels.indexOf('shark')] = 'proprietor';
        }
        const tb = createTable(cleanName(msg.name) || 'Salon', stake);
        levels.forEach((level, k) => tb.addBot(k + 1, level));
        viewing = true;
        send({ t: 'created', tableId: tb.id });
        sendTable();
        sendMe();
        if (msg.online) startHost(stake).catch(e => send({ t: 'error', text: 'ネット対戦の部屋を作れませんでした：' + (e.message || e) }));
        return;
      }
      case 'joinTable':
        if (!table) throw new Error('卓が見つかりません');
        viewing = true;
        sendTable();
        return;
      case 'leaveTable':
        if (host) { ending = true; table.close(); ending = false; table = null; closeHost(); } // ホストが卓を離れたら部屋を閉じる
        else if (mySeat() >= 0) table.removeSeat(mySeat());
        viewing = false;
        send({ t: 'lobby', tables: lobbyList() });
        sendMe();
        return;
      case 'sit': {
        if (!table) throw new Error('卓に入っていません');
        if (mySeat() >= 0) throw new Error('すでに着席しています');
        const seat = int(msg.seat);
        if (!(seat >= 0 && seat < SEATS) || table.seats[seat]) throw new Error('その席には座れません');
        const amt = Math.round(int(msg.amount) / UNIT) * UNIT;
        if (!(amt >= table.minBuyIn && amt <= table.maxBuyIn)) throw new Error(`バイインは ${fmt(table.minBuyIn)}〜${fmt(table.maxBuyIn)} です`);
        if (amt > player.wallet) throw new Error('手持ちが足りません');
        player.wallet -= amt;
        table.sit(seat, player, amt);
        saveNow();
        sendMe();
        return;
      }
      case 'stand':
        if (mySeat() >= 0) table.removeSeat(mySeat());
        sendMe();
        return;
      case 'rebuy': {
        if (!table || mySeat() < 0) throw new Error('着席していません');
        const s = table.seats[mySeat()];
        const amt = Math.round(int(msg.amount) / UNIT) * UNIT;
        const room = table.maxBuyIn - (s.stack + s.pendingRebuy);
        if (!(amt > 0)) throw new Error('金額が不正です');
        if (amt > room) throw new Error(`追加できるのは ${fmt(Math.max(0, room))} までです`);
        if (amt > player.wallet) throw new Error('手持ちが足りません');
        player.wallet -= amt;
        table.rebuy(player.id, amt);
        saveNow();
        sendMe();
        return;
      }
      case 'sitBack':
        if (table) table.sitBack(player.id);
        return;
      case 'addBot': {
        if (!table) throw new Error('卓に入っていません');
        if (!LEVELS[msg.level]) throw new Error('CPU の種類が不正です');
        if (msg.level === 'proprietor' && !player.unlocked) throw new Error('支配人にはまだ招かれていません');
        const seat = int(msg.seat);
        if (!(seat >= 0 && seat < SEATS)) throw new Error('席が不正です');
        table.addBot(seat, msg.level);
        return;
      }
      case 'removeBot': {
        if (!table) throw new Error('卓に入っていません');
        const seat = int(msg.seat);
        if (!table.seats[seat] || !table.seats[seat].isBot) throw new Error('CPU の席ではありません');
        table.removeSeat(seat);
        return;
      }
      case 'action':
        if (!table) throw new Error('卓に入っていません');
        table.actBy(player.id, String(msg.type), msg.amount);
        return;
      default:
        throw new Error('不明な要求です');
    }
  }

  return {
    send(msg) {
      try { handle(msg); } catch (e) { send({ t: 'error', text: e.message }); }
    },
    hasPlayer: () => !!player,
    playerName: () => (player ? player.name : ''),
  };
}
