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
// ホストが作った部屋は、作ってからこの日数がたち、閉じている（またはホストがいない）ものを、次に部屋を作るときに消す。
// 参加者が精算（payouts）を受け取るための猶予（2026-11-20 決定）
const ROOM_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// 受け取り済みの精算の記録（部屋ごと）は、部屋が消えるまでの期間より1日長く残す（B-01）
const PAID_KEEP_MS = ROOM_KEEP_MS + 24 * 60 * 60 * 1000;
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
      // 受け取り済みの精算の記録を、player.online から部屋ごとの記録へ移す（B-01）
      if (p.online && p.online.code && Array.isArray(p.online.paid)) {
        p.paidByRoom = { ...(p.paidByRoom || {}), [p.online.code]: { at: Date.now(), keys: p.online.paid } };
        delete p.online.paid;
      }
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

  // B-17（2026-11-24 再検討）：ほかのタブが記録を書き換えたら、このタブは古くなったとみなし、保存も操作もやめる。
  // 記録には保存のたびに増える通し番号（rev）を付け、保存の前にも確かめる（ロックは使わない＝再読み込みで止まらない）
  const STALE_MSG = '別のタブで遊んだ記録があります。このタブを読み込み直してください';
  let stale = false;
  let myRev = player ? (player.rev || 0) : 0;
  const goStale = () => {
    if (stale) return;
    stale = true;
    ending = true; // 以後、ゲームオーバーの判定もしない
    clearTimeout(saveTimer);
    // 卓とネット対戦を、何も書き込まずに止める（精算も「卓を閉じた」も書かない。新しいタブがすべてを引き継ぐ）
    if (table) { table.closed = true; table.cancel(table.timer); table.cancel(table.startTimer); table = null; }
    if (host) {
      const h = host; host = null;
      h.offs.forEach(o => o && o());
      for (const r of h.remotes.values()) { clearTimeout(r.timer); r.offInbox && r.offInbox(); }
      h.api.detach(); // このタブを閉じたときの「切断中」の予約を取り消す
    }
    if (guest) {
      const g = guest; guest = null;
      clearTimeout(g.hostTimer);
      g.offs.forEach(o => o && o());
      g.api.detach();
    }
    viewing = false;
    send({ t: 'room', code: null });
    send({ t: 'gate', error: STALE_MSG });
  };
  // 入場（hello）を済ませるまでは、ほかのページの書き込み（再読み込みで閉じていく前のページの保存など）は「古い」とせず、記録を読み直す
  let started = false;
  const adoptStored = () => { const p = loadPlayer(); if (p) { player = p; myRev = p.rev || 0; } };
  window.addEventListener('storage', e => { if (e.key !== KEY) return; if (started) goStale(); else adoptStored(); });


  const mySeat = () => (table && player ? table.seatOf(player.id) : -1);
  const chipsOnTable = () => {
    if (guest) {
      const st = guest.state;
      const s = st && st.mySeat >= 0 ? st.seats[st.mySeat] : null;
      // 拠出額 total はハンドが終わっていないときだけ数える（結果の表示中は配当が stack に入っている。B-08）
      const seat = s ? s.stack + (st.over ? 0 : (s.total || 0)) + (s.pendingRebuy || 0) : 0;
      return seat + (guest.pending || 0); // 送ったが、まだ座っていないバイインも卓上に数える（B-04）
    }
    const i = mySeat();
    if (i < 0) return 0;
    const s = table.seats[i];
    return s.stack + (table.hand && !table.hand.over ? s.total : 0) + s.pendingRebuy; // B-08（Table.close() と同じ条件）
  };
  // 卓に残したまま、まだ戻っていないチップ（前回の卓・精算待ちの部屋）。ゲームオーバーの判定に数える（B-07・B-10）
  const unsettled = () => {
    let n = 0;
    const o = player.online;
    if (o && o.code && !guest) n += o.left ? (o.awaiting || 0) : (o.chips || 0);
    for (const r of player.pendingRooms || []) n += r.left ? (r.awaiting || 0) : (r.chips || 0);
    return n;
  };
  const total = () => player.wallet + chipsOnTable() + unsettled();

  // 卓上のチップも保存しておき、次回起動時に手持ちへ戻す（アプリを閉じても失われないように）
  const write = () => {
    if (stale) return;
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* 読めなければ確かめない */ }
    if (stored && (stored.id !== player.id || (stored.rev || 0) > myRev)) { // ほかのページが書いた（B-17）
      if (started) goStale(); else adoptStored();
      return;
    }
    player.rev = myRev + 1;
    myRev = player.rev;
    if (guest) {
      player.tableStack = 0;
      player.online = { code: guest.code, uid: guest.api.uid, chips: chipsOnTable() };
    } else player.tableStack = chipsOnTable();
    if (host && table) player.hostTable = hostSnapshot(); // 開き直したときに同じ卓へ戻るため（2026-11-24）
    try { localStorage.setItem(KEY, JSON.stringify(player)); } catch { /* 保存できない環境 */ }
  };
  // ホストの卓の状態。ハンドの途中なら、そのハンドは無効にして拠出をチップに戻した額で残す（2026-11-24 決定）
  const hostSnapshot = () => ({
    code: host.code, stakeId: host.stakeId, name: table.name, at: Date.now(), button: table.button, handNo: table.handNo,
    seats: table.seats.map(s => (s ? {
      id: s.id, name: s.name, isBot: !!s.isBot, level: s.level || null, leaving: !!s.leaving,
      stack: s.stack + s.pendingRebuy + (table.hand && !table.hand.over && s.inHand ? s.total : 0),
    } : null)),
    queue: host.queue.map(q => ({ uid: q.uid, amount: q.amount })),
  });
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
    // ネット対戦の卓に残っていた分の精算は、あとから届いても足さない（オフラインの卓と同じ。B-16、2026-11-24 決定）
    for (const o of [player.online, ...(player.pendingRooms || [])]) if (o && o.code) paidBook(o.code).forfeit = true;
    player.online = null;
    player.pendingRooms = [];
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
      // ハンドの合間に席待ちの人がいなければ、空席（席0＝ホストの席を除く）を CPU で埋める（仕様「空席は CPU」。B-20）
      if (!table.hand && !host.queue.length) {
        for (let k = 1; k < SEATS; k++) if (!table.seats[k]) table.addBot(k, pick(LINEUP[host.stakeId] || LINEUP.low));
      }
      for (const [uid, r] of host.remotes) host.api.writeState(uid, { ...table.publicState(r.pid), room: host.code });
    });
  }

  // 空席がなければ、ハンドに参加していない CPU（いなければ誰か）に席を立ってもらい、空いたら座らせる
  function processSitQueue() {
    while (host.queue.length) {
      const q = host.queue[0];
      const r = host.remotes.get(q.uid);
      if (!r || table.seatOf(r.pid) >= 0) {
        host.queue.shift();
        if (r) host.api.payout(q.uid, q.amount, 'refund'); // すでに座っている人の2件目のバイインは返す（B-03）
        continue;
      }
      const free = table.seats.findIndex((x, k) => !x && k !== 0); // 席0はホストの席なので渡さない（B-21）
      if (free < 0) {
        if (!table.seats.some(x => x && x.isBot && x.leaving)) {
          const bots = table.seats.map((x, i) => (x && x.isBot ? i : -1)).filter(i => i >= 0);
          if (!bots.length) { host.queue.shift(); host.api.payout(q.uid, q.amount, 'nofree'); continue; }
          // 退いてもらうのは、ハンドに参加していないか、すでに降りた CPU だけ。いなければハンドが終わってから（B-19）
          const idle = bots.find(i => !table.seats[i].inHand || table.seats[i].folded);
          if (idle !== undefined) table.removeSeat(idle);
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
      if (!payout) { // 参加者が自分で手持ちに戻した（ハンド中の拠出額を含む）
        const x = table.seats[i];
        x.stack = 0; x.pendingRebuy = 0;
        // 拠出はポットから取り除き、残りの人でハンドを続ける（B-05、2026-11-24 決定）
        if (table.hand && !table.hand.over && x.inHand) { x.total = 0; x.bet = 0; x.allIn = false; }
      }
      table.removeSeat(i);
    }
    // 出た人には「席なし」の状態を書いておく。最後の「着席中」の状態が残らないように（B-06）
    if (table) host.api.writeState(uid, { ...table.publicState(null), room: host.code });
  }

  function handleRemote(uid, m) {
    const r = host && host.remotes.get(uid);
    if (!r) return;
    if (!table) { // 卓がないときに届いたバイイン・追加の額は返す（B-13）
      const amt = Math.round(int(m && m.amount) / UNIT) * UNIT;
      if ((m.t === 'sit' || m.t === 'rebuy') && amt > 0) host.api.payout(uid, amt, 'refund');
      return;
    }
    const i = table.seatOf(r.pid);
    try {
      switch (m.t) {
        case 'sit': {
          const amt = Math.round(int(m.amount) / UNIT) * UNIT;
          // 着席済み・席待ち中の2件目（B-03）・範囲外の額は返す
          if (i >= 0 || host.queue.some(q => q.uid === uid) || !(amt >= table.minBuyIn && amt <= table.maxBuyIn)) { if (amt > 0) host.api.payout(uid, amt, 'refund'); return; }
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
    const tb = table;
    const on = await loadOnline();
    const code = await on.createRoom({ name: tb.name, sb: stake.sb, bb: stake.bb, hostName: player.name });
    player.hostedRooms = [...(player.hostedRooms || []).filter(x => x.code !== code), { code, at: Date.now() }];
    saveNow();
    cleanupOldRooms(on, code).catch(() => {}); // 失敗しても次の機会にまた試す
    const api = on.hostApi(code);
    // 部屋を作っている間に、卓を離れた・別の部屋に入った・卓を作り直した：作った部屋は閉じる（B-13）
    if (table !== tb || guest || host || !viewing) { api.close(); return null; }
    attachHost(api, code, stake);
    return code;
  }

  // 部屋のホストとして、接続状態の見張り・参加者の一覧・受付箱の受け取りを始める（新しい部屋でも、戻った部屋でも）
  function attachHost(api, code, stake, queue = []) {
    host = { code, api, remotes: new Map(), queue, offs: [], stakeId: stake.id };
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
  }

  // 開き直したとき：前の卓の部屋がまだ閉じていなければ、戻るかどうかを画面に聞く
  async function offerHostResume() {
    const snap = player.hostTable;
    if (!snap || !snap.code) return;
    try {
      const on = await loadOnline();
      if (!on.isOnlineReady()) return;
      const meta = await on.readRoom(snap.code);
      if (player.hostTable !== snap) return;
      if (!meta || meta.closed) { delete player.hostTable; saveNow(); return; } // もう戻れない
      if (table || guest) return;
      send({ t: 'hostResume', code: snap.code, name: snap.name });
    } catch { /* 読めなければ今回は聞かない（次の起動でまた聞く） */ }
  }

  // 前の卓に戻る：同じ部屋コードで卓を作り直す。参加者の席は、部屋の参加者一覧に残っている人だけ戻す
  // （60秒が過ぎて自分でチップを戻して出た人は戻さない＝二重に払わない）
  async function resumeHost(snap) {
    const stake = CONFIG.stakes.find(s => s.id === snap.stakeId);
    if (!stake || !Array.isArray(snap.seats)) throw new Error('卓の記録が壊れています');
    const on = await loadOnline();
    const api = on.hostApi(snap.code);
    const members = (await api.readMembers()) || {};
    if (table || guest || host || player.hostTable !== snap) return;
    const mine = snap.seats.find(s => s && s.id === player.id && !s.leaving);
    const myAmt = mine ? mine.stack : 0;
    if (myAmt > player.wallet) throw new Error('手持ちが足りません');
    const tb = createTable(snap.name, stake);
    tb.button = snap.button;
    tb.handNo = snap.handNo || 0;
    // 自分の席を先に戻す（CPU を座らせる途中でゲームオーバーの判定が走っても、手持ち＋卓上が正しくなるように）
    snap.seats.forEach((s, i) => {
      if (s && s === mine && myAmt > 0) { player.wallet -= myAmt; tb.sit(i, player, myAmt); }
    });
    snap.seats.forEach((s, i) => {
      if (!s || s === mine || s.id === player.id) return;
      if (s.isBot) {
        if (!LEVELS[s.level]) return;
        tb.addBot(i, s.level);
        tb.seats[i].name = s.name;
        tb.seats[i].stack = s.stack;
        return;
      }
      const uid = String(s.id).replace(/^fb:/, '');
      if (s.leaving) { if (s.stack > 0) api.payout(uid, s.stack, 'cashout'); return; } // 出ていく途中だった人には精算を書く
      if (!members[uid] || !(s.stack > 0)) return;
      tb.sit(i, { id: s.id, name: s.name }, s.stack);
    });
    attachHost(api, snap.code, stake, (snap.queue || []).filter(q => members[q.uid]));
    viewing = true;
    send({ t: 'toast', text: '前の卓（部屋 ' + snap.code + '）に戻りました', kind: 'gold' });
    send({ t: 'created', tableId: tb.id });
    sendTable();
    saveNow();
    sendMe();
  }

  // 自分が作った部屋のうち、作ってから7日以上たち、閉じている（またはホストがいない・もう無い）ものを消す
  async function cleanupOldRooms(on, current) {
    const now = Date.now();
    const keep = [];
    for (const x of player.hostedRooms || []) {
      if (x.code === current || now - x.at < ROOM_KEEP_MS) { keep.push(x); continue; }
      try {
        const meta = await on.readRoom(x.code);
        if (meta && !meta.closed && meta.hostOnline !== false) { keep.push(x); continue; } // まだ使われている
        if (meta) await on.deleteRoom(x.code);
      } catch { keep.push(x); } // 消せなかったものは次回また試す
    }
    player.hostedRooms = keep;
    saveNow();
  }

  function closeHost() {
    if (!host) return;
    const h = host; host = null;
    delete player.hostTable; // 正しく閉じたので、戻る先はない
    h.offs.forEach(o => o && o());
    for (const r of h.remotes.values()) { clearTimeout(r.timer); r.offInbox && r.offInbox(); }
    for (const q of h.queue) h.api.payout(q.uid, q.amount, 'closed');
    h.api.close();
    send({ t: 'room', code: null });
  }

  // ================= ネット対戦：参加者側 =================
  // 精算を一度だけ受け取る。受け取り済みの記録は部屋ごとに残す（player.online が消えても、別の部屋に入っても消さない。B-01）。
  // 新しく受け取ったら true を返す
  function paidBook(code) {
    const book = player.paidByRoom || (player.paidByRoom = {});
    const now = Date.now();
    for (const c of Object.keys(book)) if (c !== code && !(now - (book[c].at || 0) < PAID_KEEP_MS)) delete book[c];
    const rec = book[code] || (book[code] = { at: now, keys: [] });
    rec.at = now;
    return rec;
  }
  function creditPayout(code, key, v) {
    const rec = paidBook(code);
    if (rec.keys.includes(key)) return false;
    rec.keys.push(key);
    if (rec.keys.length > 500) rec.keys = rec.keys.slice(-500);
    if (rec.forfeit) { saveNow(); return false; } // ゲームオーバーより前の卓の分は足さない（B-16）
    // 精算待ちの部屋の残りを減らす（B-10）
    const amtIn = Math.max(0, int(v && v.amount) || 0);
    for (const o of [player.online, ...(player.pendingRooms || [])]) {
      if (o && o.code === code && o.left && o.awaiting > 0) o.awaiting = Math.max(0, o.awaiting - amtIn);
    }
    // まだ座っていないバイインが返ってきた（B-04）
    if (guest && guest.code === code && guest.pending > 0 && !(guest.state && guest.state.mySeat >= 0)
      && ['refund', 'nofree', 'left', 'closed'].includes(v && v.reason)) guest.pending = 0;
    const amt = Math.max(0, int(v && v.amount) || 0);
    if (amt > 0) {
      player.wallet += amt;
      const why = { refund: '（席が用意できなかったため返金）', nofree: '（空席がなかったため返金）', closed: '（卓が閉じられました）' }[v.reason] || '';
      send({ t: 'toast', text: fmt(amt) + ' を手持ちに戻しました' + why, kind: 'gold' });
    }
    saveNow();
    sendMe();
    return true;
  }

  async function joinGuest(code, { quiet = false } = {}) {
    const on = await loadOnline();
    const { meta } = await on.joinRoom(code, player.name);
    // すでに部屋にいる：同じ部屋なら何もしない。別の部屋なら先に片付ける（B-12）
    if (guest) {
      if (guest.code === code) return;
      leaveGuest('switch');
    }
    if (table) { ending = true; table.close(); ending = false; table = null; closeHost(); }
    const api = on.guestApi(code);
    // ゲームオーバーより前にこの部屋に残っていた精算は、受け取り済みとして記録だけする（B-16）
    const rec = paidBook(code);
    if (rec.forfeit) {
      const old = await api.readPayouts().catch(() => ({}));
      for (const k of Object.keys(old)) if (!rec.keys.includes(k)) rec.keys.push(k);
      delete rec.forfeit;
    }
    if (guest) return; // 待っている間に別の参加が済んだ
    // 精算待ちの前の部屋は、別の部屋に入っても忘れない（B-11）
    const prev = player.online;
    player.pendingRooms = (player.pendingRooms || []).filter(r => r.code !== code && !(prev && r.code === prev.code));
    if (prev && prev.code && prev.code !== code) player.pendingRooms.push(prev);
    const me = { code, api, state: null, meta, offs: [], hostTimer: null, pending: 0 };
    guest = me;
    countedHand = -1;
    player.online = { code, uid: api.uid, chips: 0 };
    saveNow();
    guest.offs.push(api.startPresence());
    guest.offs.push(api.watchPayouts((key, v) => creditPayout(code, key, v)));
    guest.offs.push(api.watchState(st => {
      if (guest !== me) return; // 前の部屋の購読が残っていても、今の部屋の状態を上書きしない（B-12）
      guest.state = st;
      if (st.mySeat >= 0) guest.pending = 0; // バイインが席に反映された（B-04）
      countGuestHand(st);
      player.run.peak = Math.max(player.run.peak, total());
      save();
      if (!checkGameOver()) sendTable();
    }));
    guest.offs.push(api.watchMeta(m => {
      if (guest !== me || !m) return;
      guest.meta = m;
      if (m.closed) { send({ t: 'toast', text: 'ホストが卓を閉じました', kind: 'gold' }); leaveGuest('closed', 4000); return; }
      clearTimeout(guest.hostTimer);
      if (m.hostOnline === false) {
        send({ t: 'toast', text: 'ホストとの接続が切れています。60秒待っても戻らなければ卓を閉じます', kind: 'err' });
        guest.hostTimer = setTimeout(() => { if (guest === me) hostGone(); }, HOST_GONE_MS); // 今の部屋のときだけ（B-12）
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
    const awaiting = chipsOnTable(); // 精算で戻ってくるはずの額（B-10）
    const g = guest; guest = null;
    clearTimeout(g.hostTimer);
    if (reason !== 'hostGone' && reason !== 'closed') g.api.send({ t: 'leave' }).catch(() => {});
    setTimeout(() => { g.offs.forEach(o => o && o()); g.api.leave(); }, delay);
    if (reason === 'hostGone' || reason === 'closed') player.online = null;
    // 次回の起動では精算だけ受け取り、部屋には戻らない。届くまでは awaiting を手持ちの合計に数える
    else if (player.online) player.online = { code: player.online.code, uid: player.online.uid, chips: 0, left: true, awaiting };
    viewing = false;
    countedHand = -1;
    saveNow();
    send({ t: 'room', code: null });
    if (reason !== 'newTable' && reason !== 'gameover') { send({ t: 'lobby', tables: lobbyList() }); sendMe(); }
  }

  // 起動時：前回ネット対戦の途中で閉じていたら、精算を受け取り、卓が続いていれば戻る
  // 精算待ちの部屋（player.pendingRooms。B-11）もあわせて片付ける。並行して2回は動かさない（B-14）
  let resuming = false;
  async function resumeOnline() {
    if (resuming) return;
    const rooms = [player.online, ...(player.pendingRooms || [])].filter(x => x && x.code);
    if (!rooms.length) return;
    resuming = true;
    try {
      const on = await loadOnline();
      if (!on.isOnlineReady()) return;
      let rejoin = null;
      for (const o of rooms) {
        try {
          const meta = await on.readRoom(o.code);
          const api = on.guestApi(o.code);
          const pays = await api.readPayouts();
          // 閉じている間に席を外されて精算済み（cashout／left）なら、前回の卓上チップは自分で戻さない（B-02）
          let settled = false;
          for (const [k, v] of Object.entries(pays)) {
            if (creditPayout(o.code, k, v) && v && (v.reason === 'cashout' || v.reason === 'left')) settled = true;
          }
          // 卓が続いていれば戻る。ホストが一瞬切れているだけかもしれないので、切れていても戻って60秒のタイマーに任せる（B-15）
          if (!rejoin && o === player.online && !o.left && meta && !meta.closed) { rejoin = o.code; continue; }
          // 出た部屋の精算がまだ届いていない（オールインのハンドが続いている等）：部屋が閉じるまで記録を残し、次回また読む（B-11）
          if (o.left && o.awaiting > 0 && meta && !meta.closed) continue;
          // ホストが消えたまま、または部屋そのものがもう無い（7日たって消された）：前回の卓上チップを自分で戻す。
          // 卓が正しく閉じられていた（closed）場合は、精算（payouts）が正しい額なので、ここでは足さない
          if (!o.left && !settled && (!meta || !meta.closed) && o.chips > 0) {
            player.wallet += o.chips;
            send({ t: 'toast', text: '前回の卓（部屋 ' + o.code + '）のチップ ' + fmt(o.chips) + ' を手持ちに戻しました', kind: 'gold' });
            if (meta) api.send({ t: 'abandon' }).catch(() => {});
          }
          if (player.online === o) player.online = null;
          else player.pendingRooms = (player.pendingRooms || []).filter(r => r !== o);
        } catch { /* この部屋は次回また試す */ }
      }
      saveNow();
      if (rejoin) { await joinGuest(rejoin, { quiet: true }); return; }
      if (!checkGameOver()) sendMe(); // 後始末が済んだので判定し直す（B-07）
    } catch { /* つながらなければ次回また試す */ } finally { resuming = false; }
  }

  // 参加者のときの依頼：手持ちの出し入れはこの端末で行い、卓の操作はホストへ送る
  function guestHandle(msg) {
    const st = guest.state;
    switch (msg.t) {
      case 'sit': {
        const amt = Math.round(int(msg.amount) / UNIT) * UNIT;
        if (!st) throw new Error('卓の状態を受け取るまでお待ちください');
        if (st.mySeat >= 0) throw new Error('すでに着席しています');
        if (guest.pending > 0) throw new Error('席を用意しています。もうしばらくお待ちください'); // B-03
        if (!(amt >= st.minBuyIn && amt <= st.maxBuyIn)) throw new Error('バイインは ' + fmt(st.minBuyIn) + '〜' + fmt(st.maxBuyIn) + ' です');
        if (amt > player.wallet) throw new Error('手持ちが足りません');
        player.wallet -= amt;
        guest.pending = amt; // 席に反映されるまで卓上に数える（B-04）
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
      case 'leaveTable': // ホストとの接続が切れている間は、精算する相手がいないので自分で戻す（B-09）
        if (guest.meta && guest.meta.hostOnline === false) hostGone(); else leaveGuest('leave');
        return true;
      case 'joinTable': viewing = true; sendTable(); return true;
      default: return false; // hello・lobby などは通常の処理へ
    }
  }

  function safeHandle(msg) {
    try { handle(msg); } catch (e) { send({ t: 'error', text: e.message }); }
  }

  function handle(msg) {
    if (stale) { send({ t: 'gate', error: STALE_MSG }); return; } // 古くなったタブでは操作を受け付けない（B-17）
    if (msg.t !== 'hello' && !player) throw new Error('先に入場してください');
    if (guest && guestHandle(msg)) return;
    switch (msg.t) {
      case 'hello': {
        if (!table && !guest) adoptStored(); // 入場の時点の最新の記録を使う（B-17）
        const name = cleanName(msg.name) || (player && player.name);
        if (!name) { send({ t: 'gate', error: 'お名前を入力してください' }); return; }
        if (!player) {
          player = {
            id: 'me-' + Math.random().toString(36).slice(2, 10), name, wallet: CONFIG.startingWallet,
            unlocked: false, tableStack: 0, run: newRun(), best: newBest(), created: Date.now(),
          };
        }
        player.name = name;
        started = true; // ここから先のほかのページの書き込みは「別のタブ」とみなす
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
        if ((player.online || (player.pendingRooms || []).length) && !guest) resumeOnline();
        if (player.hostTable && !table && !guest) offerHostResume();
        return;
      }
      case 'resumeHost': { // 前の卓に戻るかどうかの答え
        const snap = player.hostTable;
        if (!snap || snap.code !== msg.code) return;
        if (!msg.yes) { delete player.hostTable; saveNow(); return; } // 戻らない：参加者は60秒で各自チップを戻す
        if (table || guest) throw new Error('いまの卓を離れてから戻ってください');
        resumeHost(snap).catch(e => send({ t: 'error', text: '前の卓に戻れませんでした：' + (e.message || e) }));
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
    send(msg) { safeHandle(msg); },
    hasPlayer: () => !!player,
    playerName: () => (player ? player.name : ''),
  };
}
