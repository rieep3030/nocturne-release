// 端末内サーバー：PC 版 server.js の代わりに、同じ形式のメッセージをやり取りする。
// メンバー情報（手持ち・今回の成績・自己ベスト・解放状況）は端末の localStorage に保存する。
// スマホ単体版のルール：借金と補充はなし。手持ち＋卓上チップが最小卓の最低バイイン未満になったらゲームオーバー。
import { Table } from './engine/table.js';
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

// 卓のレートごとに座る CPU（席 1〜5。席 0 はあなた）。チップが尽きた CPU も同じ割合から選び直す
const LINEUP = {
  low: ['novice', 'novice', 'novice', 'regular', 'regular'],
  mid: ['novice', 'regular', 'regular', 'regular', 'shark'],
  high: ['regular', 'regular', 'shark', 'shark', 'shark'],
};
// 支配人を解放済みなら、最高レートの卓を開くたびにこの確率で勝負師1人が支配人に代わる
const PROPRIETOR_CHANCE = 1 / 3;
const pick = a => a[Math.floor(Math.random() * a.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

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

  const send = msg => queueMicrotask(() => onMessage(msg));

  const mySeat = () => (table && player ? table.seatOf(player.id) : -1);
  const chipsOnTable = () => {
    const i = mySeat();
    if (i < 0) return 0;
    const s = table.seats[i];
    return s.stack + s.total + s.pendingRebuy;
  };
  const total = () => player.wallet + chipsOnTable();

  // 卓上のチップも保存しておき、次回起動時に手持ちへ戻す（アプリを閉じても失われないように）
  const write = () => {
    player.tableStack = chipsOnTable();
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
  const lobbyList = () => (table ? [{ ...table.summary(), hostName: player.name }] : []);
  const sendTable = () => { if (table && viewing) send({ t: 'table', table: table.publicState(player.id) }); };

  // ハンドの結果を成績に数える（1ハンドにつき1回）
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
    if (total() >= GAMEOVER_BELOW) return false;
    ending = true;
    if (table) { table.close(); table = null; } // 残りの卓上チップは手持ちに戻る
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
    if (table) { ending = true; table.close(); ending = false; } // 前の卓は閉じて、卓上のチップを手持ちに戻す
    countedHand = -1;
    table = new Table({
      id: 'local', name, sb: stake.sb, bb: stake.bb, hostId: player.id, config: CONFIG, decider,
      hooks: {
        // チップが尽きた CPU は、同じレートの顔ぶれから選び直した CPU に入れ替える
        replaceBot: s => (s.level === 'proprietor' ? 'proprietor' : pick(LINEUP[stake.id] || LINEUP.low)),
        onChange: () => {
          countHand();
          player.run.peak = Math.max(player.run.peak, total());
          if (!checkGameOver()) { sendTable(); save(); }
        },
        onCashOut: (pid, amount) => {
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

  function handle(msg) {
    if (msg.t !== 'hello' && !player) throw new Error('先に入場してください');
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
        if (viewing && table) sendTable();
        else send({ t: 'lobby', tables: lobbyList() });
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
        return;
      }
      case 'joinTable':
        if (!table) throw new Error('卓が見つかりません');
        viewing = true;
        sendTable();
        return;
      case 'leaveTable':
        if (mySeat() >= 0) table.removeSeat(mySeat());
        viewing = false;
        send({ t: 'lobby', tables: lobbyList() });
        sendMe();
        return;
      case 'sit': {
        if (!table) throw new Error('卓に入っていません');
        if (mySeat() >= 0) throw new Error('すでに着席しています');
        const seat = int(msg.seat);
        if (!(seat >= 0 && seat < 6) || table.seats[seat]) throw new Error('その席には座れません');
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
        if (!(seat >= 0 && seat < 6)) throw new Error('席が不正です');
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
