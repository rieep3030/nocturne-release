// 卓の進行（PC 版 src/table.js をブラウザ用に移植）
// 相違点：ES モジュール化、乱数は Web Crypto、CPU の判断は opts.decider（Web Worker）で非同期に行える。
import { toStr, shuffledDeck, randomId } from './cards.js';
import { evaluate, handName, bestFive } from './evaluator.js';
import { LEVELS, decide } from './bots.js';

const N = 7; // スマホ版は7人卓（あなた＋CPU 6人。2026-11-18 決定）
const UNIT = 5;
const fmt = n => Number(n).toLocaleString('en-US');

class Table {
  /**
   * opts: { id, sb, bb, hostId, config, hooks, timing, allowBotsOnly, hold }
   * hooks: onChange(table), onCashOut(playerId, amount), onUnlock(playerId), onBotRebuy(amount)
   * hold：true なら begin() を呼ぶまで配らない（マルチプレイの開始待ち。2026-11-25 決定）
   */
  constructor(opts) {
    this.id = opts.id;
    this.sb = opts.sb;
    this.bb = opts.bb;
    this.hostId = opts.hostId;
    this.cfg = opts.config;
    this.hooks = opts.hooks || {};
    this.timing = Object.assign({
      nextHand: 2600, showdown: 5600, foldWin: 2400, street: 750, runout: 1500,
      actionMs: this.cfg.actionSeconds * 1000, absentMs: 1500, botDelay: null,
    }, opts.timing || {});
    this.allowBotsOnly = !!opts.allowBotsOnly;
    this.hold = !!opts.hold;
    this.decider = opts.decider || null;
    this.seats = new Array(N).fill(null);
    this.button = -1;
    this.hand = null;
    this.handNo = 0;
    this.log = [];
    this.stats = new Map();
    this.timer = null;
    this.startTimer = null;
    this.closed = false;
    this.emptySince = null;
  }

  get minBuyIn() { return this.bb * this.cfg.buyInMinBB; }
  get maxBuyIn() { return this.bb * this.cfg.buyInMaxBB; }

  // ---------- 席の管理 ----------
  seatOf(pid) { return this.seats.findIndex(s => s && s.id === pid); }
  humanCount() { return this.seats.filter(s => s && !s.isBot && !s.leaving).length; }

  newSeat(f) {
    return Object.assign({
      id: '', name: '', isBot: false, level: null, stack: 0,
      sittingOut: false, disconnected: false, leaving: false, timeouts: 0, pendingRebuy: 0,
      inHand: false, hole: [], folded: false, allIn: false, bet: 0, total: 0,
      acted: false, raiseLocked: false, lastAction: null, startStack: 0,
      pf: null, postAggr: 0, vpipFlag: false, pfrFlag: false,
    }, f);
  }

  sit(idx, player, amount) {
    if (this.seats[idx]) throw new Error('その席は埋まっています');
    this.seats[idx] = this.newSeat({ id: player.id, name: player.name, stack: amount });
    this.addLog(`${player.name} が着席（${fmt(amount)}）`);
    this.changed();
    this.maybeStart();
  }

  addBot(idx, level) {
    const name = this.placeBot(idx, level);
    this.addLog(`${name}（${LEVELS[level].label}）が着席`);
    this.changed();
    this.maybeStart();
  }

  // CPU を席に置くだけ（通知・ハンド開始はしない）。置いた CPU の名前を返す
  placeBot(idx, level) {
    const L = LEVELS[level];
    if (!L) throw new Error('CPU の種類が不正です');
    if (this.seats[idx]) throw new Error('その席は埋まっています');
    if (level === 'proprietor' && this.seats.some(s => s && s.level === 'proprietor')) throw new Error('支配人は一卓に一人だけです');
    const used = new Set(this.seats.filter(Boolean).map(s => s.name));
    const name = L.names.find(n => !used.has(n)) || `${L.names[0]} ${idx + 1}`;
    const stack = this.bb * this.cfg.botBuyInBB;
    this.seats[idx] = this.newSeat({ id: 'bot:' + randomId(), name, isBot: true, level, stack });
    return name;
  }

  // 席を立つ。ハンド中なら降りて、残りスタックを即時精算する（オールイン中は終了時に精算）
  removeSeat(idx) {
    const s = this.seats[idx];
    if (!s || s.leaving) return;
    const h = this.hand;
    if (h && !h.over && s.inHand && !s.folded) {
      s.leaving = true;
      if (!s.allIn) {
        s.folded = true;
        s.lastAction = '退席';
        this.cashOut(s);
        this.addLog(`${s.name} が退席`);
        if (h.toAct === idx) h.toAct = this.nextFrom(idx, i => this.needsToAct(i));
        h.seq++;
        this.progress();
      } else {
        this.addLog(`${s.name} は精算後に退席します`);
        this.changed();
      }
      return;
    }
    if (h && s.inHand) { // 降りた後 or ハンド終了表示中
      s.leaving = true;
      this.cashOut(s);
      this.changed();
      return;
    }
    this.cashOut(s);
    this.seats[idx] = null;
    this.addLog(`${s.name} が退席`);
    this.changed();
  }

  cashOut(s) {
    const amt = s.stack + s.pendingRebuy;
    s.stack = 0; s.pendingRebuy = 0;
    if (!s.isBot && amt > 0) this.hooks.onCashOut?.(s.id, amt);
  }

  rebuy(pid, amount) {
    const idx = this.seatOf(pid);
    const s = this.seats[idx];
    if (!s) throw new Error('着席していません');
    if (this.hand && s.inHand && !this.hand.over) {
      s.pendingRebuy += amount;
    } else {
      s.stack += amount;
      s.sittingOut = false;
      s.timeouts = 0;
    }
    this.addLog(`${s.name} がチップを追加（${fmt(amount)}）`);
    this.changed();
    this.maybeStart();
  }

  setDisconnected(pid, v) {
    const s = this.seats[this.seatOf(pid)];
    if (!s) return;
    s.disconnected = v;
    this.changed();
    // 手番の人が切れたら持ち時間を短くする。締め切りを延ばすことはしない（切断を繰り返して卓を止められないように。B-18）
    if (v && this.hand && this.hand.toAct === this.seatOf(pid)) {
      const h = this.hand;
      if (!h.deadline || Date.now() + this.timing.absentMs < h.deadline) this.promptActor();
    }
    if (!v) this.maybeStart();
  }

  sitBack(pid) {
    const s = this.seats[this.seatOf(pid)];
    if (!s) return;
    if (s.stack > 0) { s.sittingOut = false; s.timeouts = 0; }
    this.changed();
    this.maybeStart();
  }

  // ---------- タイマー（0ms は即時実行） ----------
  later(fn, ms) { return { t: setTimeout(fn, Math.max(0, ms)) }; }
  cancel(h) { if (h) clearTimeout(h.t); }

  // ---------- 進行 ----------
  // 開始待ちを解いて、配り始める
  begin() {
    if (!this.hold) return;
    this.hold = false;
    this.changed();
    this.maybeStart();
  }

  maybeStart() {
    if (this.closed || this.hold || this.hand || this.startTimer) return;
    if (this.readySeats().length < 2) return;
    if (!this.allowBotsOnly && !this.seats.some(s => s && !s.isBot && !s.disconnected && !s.sittingOut && s.stack > 0)) return;
    this.startTimer = this.later(() => { this.startTimer = null; this.startHand(); }, this.timing.nextHand);
  }

  readySeats() {
    const r = [];
    this.seats.forEach((s, i) => { if (s && !s.leaving && !s.sittingOut && !s.disconnected && s.stack > 0) r.push(i); });
    return r;
  }

  nextFrom(start, pred) {
    for (let k = 1; k <= N; k++) {
      const i = (start + k + N) % N;
      if (pred(i)) return i;
    }
    return -1;
  }

  canAct(i) { const s = this.seats[i]; return !!(s && s.inHand && !s.folded && !s.allIn); }
  needsToAct(i) { return this.canAct(i) && (!this.seats[i].acted || this.seats[i].bet < this.hand.currentBet); }
  liveIdx() { const r = []; this.seats.forEach((s, i) => { if (s && s.inHand && !s.folded) r.push(i); }); return r; }

  startHand() {
    if (this.closed || this.hold || this.hand) return;
    const ready = this.readySeats();
    if (ready.length < 2) return;
    if (!this.allowBotsOnly && !ready.some(i => !this.seats[i].isBot)) return;
    this.handNo++;
    const set = new Set(ready);
    this.seats.forEach((s, i) => {
      if (!s) return;
      Object.assign(s, {
        inHand: set.has(i), hole: [], folded: false, allIn: false, bet: 0, total: 0,
        acted: false, actedAt: 0, raiseLocked: false, lastAction: null, startStack: s.stack,
        pf: null, postAggr: 0, vpipFlag: false, pfrFlag: false,
      });
    });
    this.button = this.nextFrom(this.button, i => set.has(i));
    let sbI, bbI;
    if (ready.length === 2) { sbI = this.button; bbI = this.nextFrom(sbI, i => set.has(i)); }
    else { sbI = this.nextFrom(this.button, i => set.has(i)); bbI = this.nextFrom(sbI, i => set.has(i)); }

    const deck = shuffledDeck();
    this.hand = {
      no: this.handNo, street: 'preflop', deck, board: [], currentBet: 0, minRaise: this.bb,
      toAct: -1, sbI, bbI, seq: 0, over: false, revealAll: false, results: null, deadline: 0, promptFor: -1,
    };
    const h = this.hand;
    this.post(sbI, this.sb, 'SB');
    this.post(bbI, this.bb, 'BB');
    // BB がショートでオールインしても、コールに必要な額は BB の額（一般的なルール。B-25、2026-11-25 決定）
    h.currentBet = Math.max(this.seats[sbI].bet, this.seats[bbI].bet, this.bb);
    for (let round = 0; round < 2; round++) {
      let i = sbI;
      for (let k = 0; k < ready.length; k++) {
        this.seats[i].hole.push(deck.pop());
        i = this.nextFrom(i, j => set.has(j));
      }
    }
    for (const i of ready) {
      const st = this.statOf(this.seats[i].id);
      st.hands++;
    }
    this.addLog(`― ハンド #${this.handNo} ―`);
    h.toAct = this.nextFrom(bbI, i => this.needsToAct(i));
    this.progress();
  }

  post(i, amt, label) {
    const s = this.seats[i];
    const a = Math.min(s.stack, amt);
    s.stack -= a; s.bet += a; s.total += a;
    if (s.stack === 0) s.allIn = true;
    s.lastAction = label;
  }

  statOf(id) {
    if (!this.stats.has(id)) this.stats.set(id, { hands: 0, vpip: 0, pfr: 0, bets: 0, raises: 0, calls: 0 });
    return this.stats.get(id);
  }

  progress() {
    const h = this.hand;
    if (!h || h.over || this.closed) return;
    this.cancel(this.timer);
    const live = this.liveIdx();
    if (live.length === 1) return this.finishFoldWin(live[0]);
    if (live.length === 0) return this.finishFoldWin(-1);
    const actors = [];
    this.seats.forEach((s, i) => { if (this.canAct(i)) actors.push(i); });
    const pending = actors.filter(i => this.needsToAct(i));
    let roundOver = pending.length === 0;
    if (!roundOver && actors.length === 1 && this.seats[actors[0]].bet >= h.currentBet) roundOver = true;
    if (roundOver) return this.endStreet();
    if (h.toAct < 0 || !this.needsToAct(h.toAct)) {
      h.toAct = this.nextFrom(h.toAct < 0 ? this.button : h.toAct, i => this.needsToAct(i));
    }
    this.promptActor();
    this.changed();
  }

  promptActor() {
    const h = this.hand;
    if (!h || h.over || h.toAct < 0) return;
    this.cancel(this.timer);
    const i = h.toAct;
    const s = this.seats[i];
    const seq = h.seq;
    if (s.isBot) {
      const L = LEVELS[s.level];
      const delay = this.timing.botDelay != null ? this.timing.botDelay : L.think[0] + Math.random() * (L.think[1] - L.think[0]);
      h.deadline = 0;
      this.timer = this.later(() => this.botAct(i, seq), delay);
      h.promptFor = -1;
    } else {
      const full = (s.disconnected || s.sittingOut || s.leaving) ? this.timing.absentMs : this.timing.actionMs;
      // 同じ人の手番のまま張り直すとき（ほかの人が席を立った等）は、残りの持ち時間を引き継ぐ（B-27）
      const ms = h.promptFor === i && h.deadline > 0 ? Math.min(full, Math.max(0, h.deadline - Date.now())) : full;
      h.promptFor = i;
      h.deadline = Date.now() + ms;
      this.timer = this.later(() => this.timeoutAct(i, seq), ms);
    }
  }

  timeoutAct(i, seq) {
    const h = this.hand;
    if (!h || h.over || h.seq !== seq || h.toAct !== i) return;
    const s = this.seats[i];
    if (!s.disconnected && !s.sittingOut) {
      s.timeouts++;
      if (s.timeouts >= 2) { s.sittingOut = true; this.addLog(`${s.name} は離席扱いになりました`); }
    }
    const toCall = h.currentBet - s.bet;
    this.applyAction(i, toCall > 0 ? 'fold' : 'check');
  }

  botAct(i, seq) {
    const h = this.hand;
    if (!h || h.over || h.seq !== seq || h.toAct !== i) return;
    const s = this.seats[i];
    const apply = d => {
      if (this.hand !== h || h.over || h.seq !== seq || h.toAct !== i) return; // 考えている間に状況が変わった
      try {
        this.applyAction(i, d.type, d.amount);
      } catch (e) {
        const toCall = h.currentBet - s.bet;
        this.applyAction(i, toCall > 0 ? 'call' : 'check');
      }
    };
    const fallback = () => ({ type: h.currentBet > s.bet ? 'fold' : 'check' });
    const ctx = this.botContext(i);
    if (this.decider) {
      this.decider(ctx).then(apply, () => apply(fallback()));
      return;
    }
    let d;
    try { d = decide(ctx); } catch (e) { d = fallback(); }
    apply(d);
  }

  botContext(i) {
    const h = this.hand;
    const s = this.seats[i];
    const ready = this.seats.map((x, j) => (x && x.inHand ? j : -1)).filter(j => j >= 0);
    const order = [];
    let j = this.button;
    for (let k = 0; k < ready.length; k++) { j = this.nextFrom(j, x => ready.includes(x)); order.push(j); }
    const pos = order.indexOf(i); // 0 = SB ... last = ボタン
    const opponents = this.liveIdx().filter(x => x !== i).map(x => {
      const o = this.seats[x];
      return { pf: o.pf, postAggr: o.postAggr, stats: this.statOf(o.id) };
    });
    const pot = this.seats.reduce((a, x) => a + (x ? x.total : 0), 0);
    return {
      level: s.level, hole: s.hole, board: h.board, street: h.street, bb: this.bb,
      pot, toCall: Math.max(0, h.currentBet - s.bet), currentBet: h.currentBet, myBet: s.bet,
      myStack: s.stack, minRaiseTo: h.currentBet + h.minRaise,
      canRaise: !s.raiseLocked && s.stack > h.currentBet - s.bet,
      position: ready.length > 1 ? (pos + 1) / ready.length : 1,
      opponents,
    };
  }

  // 人間のアクション（サーバーから）
  actBy(pid, type, amount) {
    const h = this.hand;
    if (!h || h.over) throw new Error('ハンド中ではありません');
    const i = this.seatOf(pid);
    if (i < 0 || h.toAct !== i) throw new Error('あなたの番ではありません');
    this.seats[i].timeouts = 0;
    this.applyAction(i, type, amount);
  }

  applyAction(i, type, amount) {
    const h = this.hand;
    const s = this.seats[i];
    const toCall = h.currentBet - s.bet;
    const pre = h.street === 'preflop';
    const st = this.statOf(s.id);
    if (type === 'allin') {
      if (s.bet + s.stack > h.currentBet && !s.raiseLocked) { type = 'raise'; amount = s.bet + s.stack; }
      else type = 'call';
    }
    if (type === 'call' && toCall <= 0) type = 'check';

    switch (type) {
      case 'fold':
        s.folded = true;
        s.lastAction = 'フォールド';
        this.addLog(`${s.name} フォールド`);
        break;
      case 'check':
        if (toCall > 0) throw new Error('チェックできません');
        s.lastAction = 'チェック';
        this.addLog(`${s.name} チェック`);
        break;
      case 'call': {
        const a = Math.min(toCall, s.stack);
        this.move(s, a);
        s.lastAction = s.allIn ? 'オールイン' : 'コール';
        this.addLog(`${s.name} ${s.lastAction} ${fmt(a)}`);
        if (pre) { s.vpipFlag = true; if (!s.pf) s.pf = 'call'; } else if (st) st.calls++;
        break;
      }
      case 'raise': {
        if (s.raiseLocked) throw new Error('レイズできません');
        const maxTo = s.bet + s.stack;
        let to = Math.round(Number(amount) / UNIT) * UNIT;
        if (!Number.isFinite(to)) throw new Error('金額が不正です');
        to = Math.min(to, maxTo);
        const minTo = h.currentBet + h.minRaise;
        if (to <= h.currentBet) throw new Error('金額が小さすぎます');
        if (to < minTo && to < maxTo) throw new Error(`最低 ${fmt(minTo)} までレイズしてください`);
        const wasBet = h.currentBet === 0;
        const size = to - h.currentBet;
        this.move(s, to - s.bet);
        if (size >= h.minRaise) {
          h.minRaise = size;
          this.seats.forEach((o, j) => { if (o && j !== i && this.canAct(j)) { o.acted = false; o.raiseLocked = false; } });
        } else {
          // 足りないオールイン：既にアクションした人は再レイズ不可。ただし、その人が最後にアクションしてからの
          // 増額の合計がフルレイズ以上になったら、再レイズできる（一般的なルール。B-26、2026-11-25 決定）
          this.seats.forEach((o, j) => { if (o && j !== i && this.canAct(j) && o.acted) o.raiseLocked = to - (o.actedAt || 0) < h.minRaise; });
        }
        h.currentBet = to;
        s.lastAction = s.allIn ? 'オールイン' : (wasBet ? 'ベット' : 'レイズ');
        this.addLog(`${s.name} ${s.lastAction} ${fmt(to)}`);
        if (pre) { s.vpipFlag = true; s.pfrFlag = true; s.pf = 'raise'; }
        else { s.postAggr++; if (st) { if (wasBet) st.bets++; else st.raises++; } }
        break;
      }
      default:
        throw new Error('不明なアクションです');
    }
    s.acted = true;
    s.actedAt = h.currentBet; // このときの賭け額（B-26）
    h.seq++;
    h.promptFor = -1; // 次の手番は持ち時間を最初から（B-27）
    h.toAct = this.nextFrom(i, j => this.needsToAct(j));
    this.progress();
  }

  move(s, a) {
    s.stack -= a; s.bet += a; s.total += a;
    if (s.stack === 0) s.allIn = true;
  }

  endStreet() {
    const h = this.hand;
    this.cancel(this.timer);
    this.seats.forEach(s => {
      if (!s) return;
      s.bet = 0; s.acted = false; s.actedAt = 0; s.raiseLocked = false;
      if (s.inHand && !s.folded && !s.allIn) s.lastAction = null;
    });
    h.currentBet = 0;
    h.minRaise = this.bb;
    h.toAct = -1;
    h.promptFor = -1;
    if (h.street === 'river') return this.showdown();
    const actors = this.seats.map((s, i) => i).filter(i => this.canAct(i));
    const runout = actors.length <= 1;
    if (runout) h.revealAll = true;
    const d = h.deck;
    if (h.street === 'preflop') { d.pop(); h.board.push(d.pop(), d.pop(), d.pop()); h.street = 'flop'; }
    else if (h.street === 'flop') { d.pop(); h.board.push(d.pop()); h.street = 'turn'; }
    else if (h.street === 'turn') { d.pop(); h.board.push(d.pop()); h.street = 'river'; }
    h.seq++;
    this.changed();
    const seq = h.seq;
    if (runout) {
      this.timer = this.later(() => { if (this.hand === h && h.seq === seq) this.endStreet(); }, this.timing.runout);
    } else {
      this.timer = this.later(() => {
        if (this.hand !== h || h.seq !== seq) return;
        h.toAct = this.nextFrom(this.button, i => this.needsToAct(i));
        this.progress();
      }, this.timing.street);
    }
  }

  refundUncalled() {
    const inH = this.seats.map((s, i) => i).filter(i => this.seats[i] && this.seats[i].inHand && this.seats[i].total > 0);
    if (inH.length < 2) return;
    inH.sort((a, b) => this.seats[b].total - this.seats[a].total);
    const top = this.seats[inH[0]], second = this.seats[inH[1]];
    const diff = top.total - second.total;
    if (diff > 0) { top.total -= diff; top.stack += diff; }
  }

  buildPots() {
    const contrib = this.seats.map((s, i) => ({ i, s })).filter(x => x.s && x.s.inHand && x.s.total > 0);
    const levels = [...new Set(contrib.map(x => x.s.total))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const L of levels) {
      let amount = 0;
      for (const x of contrib) amount += Math.min(x.s.total, L) - Math.min(x.s.total, prev);
      const eligible = contrib.filter(x => !x.s.folded && x.s.total >= L).map(x => x.i);
      prev = L;
      if (amount <= 0) continue;
      const last = pots[pots.length - 1];
      if (!eligible.length) { if (last) last.amount += amount; else pots.push({ amount, eligible: [] }); continue; }
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    return pots;
  }

  orderFromButton(idxs) {
    return idxs.slice().sort((a, b) => ((a - this.button - 1 + N) % N) - ((b - this.button - 1 + N) % N));
  }

  showdown() {
    const h = this.hand;
    h.street = 'showdown';
    h.revealAll = true;
    this.refundUncalled();
    const live = this.liveIdx();
    const score = {};
    for (const i of live) score[i] = evaluate([...this.seats[i].hole, ...h.board]);
    const pots = this.buildPots();
    const won = {};
    const potResults = [];
    for (const p of pots) {
      let elig = p.eligible.filter(i => live.includes(i));
      if (!elig.length) elig = live;
      const best = Math.max(...elig.map(i => score[i]));
      const winners = this.orderFromButton(elig.filter(i => score[i] === best));
      const share = Math.floor(p.amount / winners.length / UNIT) * UNIT;
      let rem = p.amount - share * winners.length;
      for (const w of winners) {
        let a = share;
        if (rem > 0) { const x = Math.min(rem, UNIT); a += x; rem -= x; }
        if (w === winners[winners.length - 1] && rem > 0) { a += rem; rem = 0; }
        this.seats[w].stack += a;
        won[w] = (won[w] || 0) + a;
      }
      potResults.push({ amount: p.amount, winners, eligible: p.eligible });
    }
    const hands = {};
    for (const i of live) {
      hands[i] = { name: handName(score[i]), best: bestFive([...this.seats[i].hole, ...h.board]).map(toStr) };
    }
    h.results = {
      kind: 'showdown',
      winners: Object.keys(won).map(Number).map(i => ({ seat: i, amount: won[i], hand: hands[i].name, best: hands[i].best })),
      hands,
      pots: potResults.map(p => ({ amount: p.amount, winners: p.winners })),
    };
    for (const w of h.results.winners) this.addLog(`${this.seats[w.seat].name} が ${fmt(w.amount)} を獲得（${w.hand}）`);
    this.checkUnlock(potResults);
    this.finishHand(this.timing.showdown);
  }

  // <勝負師> をショーダウンで飛ばしたポットを人間が取ったら、隠しCPUを解放
  checkUnlock(potResults) {
    this.seats.forEach((s, i) => {
      if (!s || !s.isBot || s.level !== 'shark' || s.startStack <= 0 || s.stack > 0) return;
      for (const p of potResults) {
        if (!p.eligible.includes(i)) continue;
        for (const w of p.winners) {
          const ws = this.seats[w];
          if (ws && !ws.isBot && w !== i) this.hooks.onUnlock?.(ws.id, s.name);
        }
      }
    });
  }

  finishFoldWin(i) {
    const h = this.hand;
    const total = this.seats.reduce((a, s) => a + (s ? s.total : 0), 0);
    if (i >= 0) {
      this.seats[i].stack += total;
      h.results = { kind: 'fold', winners: [{ seat: i, amount: total }], hands: {}, pots: [{ amount: total, winners: [i] }] };
      this.addLog(`${this.seats[i].name} が ${fmt(total)} を獲得`);
    } else {
      h.results = { kind: 'fold', winners: [], hands: {}, pots: [] };
    }
    this.finishHand(this.timing.foldWin);
  }

  finishHand(delay) {
    const h = this.hand;
    this.cancel(this.timer);
    h.over = true;
    h.toAct = -1;
    this.seats.forEach(s => {
      if (!s || !s.inHand) return;
      s.bet = 0;
      const st = this.statOf(s.id);
      if (s.vpipFlag) st.vpip++;
      if (s.pfrFlag) st.pfr++;
    });
    this.changed();
    this.timer = this.later(() => this.cleanupHand(), delay);
  }

  cleanupHand() {
    if (this.closed) return;
    const replace = []; // チップが尽きて入れ替える CPU の席
    this.seats.forEach((s, i) => {
      if (!s) return;
      if (s.leaving) {
        this.cashOut(s);
        this.seats[i] = null;
        return;
      }
      if (s.pendingRebuy) { s.stack += s.pendingRebuy; s.pendingRebuy = 0; s.sittingOut = false; }
      s.inHand = false; s.hole = []; s.folded = false; s.allIn = false; s.bet = 0; s.total = 0;
      s.lastAction = null;
      if (s.stack <= 0) {
        // hooks.replaceBot があれば、別の CPU に入れ替える（なければ従来どおりリバイ）
        const next = s.isBot && this.hooks.replaceBot ? this.hooks.replaceBot(s) : null;
        if (next && LEVELS[next]) {
          replace.push({ i, level: next, old: s.name });
          this.seats[i] = null;
        } else if (s.isBot) {
          const a = this.bb * this.cfg.botBuyInBB;
          s.stack = a;
          this.hooks.onBotRebuy?.(a);
          this.addLog(`${s.name} がリバイ`);
        } else {
          s.sittingOut = true;
        }
      }
    });
    for (const r of replace) {
      let level = r.level;
      if (level === 'proprietor' && this.seats.some(s => s && s.level === 'proprietor')) level = 'shark';
      const name = this.placeBot(r.i, level);
      this.addLog(`${r.old} が席を立ち、${name}（${LEVELS[level].label}）が着席`);
    }
    this.hand = null;
    this.changed();
    this.maybeStart();
  }

  // ---------- 表示 ----------
  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 80) this.log.splice(0, this.log.length - 80);
  }

  changed() { this.hooks.onChange?.(this); }

  summary() {
    return {
      id: this.id, sb: this.sb, bb: this.bb, hostId: this.hostId, waiting: this.hold,
      seats: this.seats.map(s => (s ? { isBot: s.isBot, level: s.level, name: s.name } : null)),
    };
  }

  publicState(viewerId) {
    const h = this.hand;
    const me = this.seatOf(viewerId);
    const reveal = i => !!(h && h.revealAll && this.seats[i].inHand && !this.seats[i].folded);
    const winAmt = {};
    if (h && h.results) for (const w of h.results.winners) winAmt[w.seat] = w.amount;
    const seats = this.seats.map((s, i) => {
      if (!s) return null;
      let cards = [];
      if (s.inHand) cards = (i === me || reveal(i)) ? s.hole.map(toStr) : s.hole.map(() => '??');
      return {
        name: s.name, isBot: s.isBot, level: s.level, id: s.isBot ? null : s.id,
        stack: s.stack, bet: s.bet, total: s.total, pendingRebuy: s.pendingRebuy, folded: s.folded, allIn: s.allIn, inHand: s.inHand,
        sittingOut: s.sittingOut, disconnected: s.disconnected, leaving: s.leaving,
        lastAction: s.lastAction, cards, won: winAmt[i] || 0,
        handName: h && h.results && h.results.hands[i] ? h.results.hands[i].name : null,
      };
    });
    const totalPot = this.seats.reduce((a, s) => a + (s ? s.total : 0), 0);
    const betSum = this.seats.reduce((a, s) => a + (s ? s.bet : 0), 0);
    let actions = null;
    if (h && !h.over && h.toAct === me && me >= 0) {
      const s = this.seats[me];
      const toCall = Math.max(0, h.currentBet - s.bet);
      const maxTo = s.bet + s.stack;
      actions = {
        toCall: Math.min(toCall, s.stack), canCheck: toCall === 0,
        currentBet: h.currentBet, myBet: s.bet,
        minRaiseTo: Math.min(h.currentBet + h.minRaise, maxTo), maxRaiseTo: maxTo,
        canRaise: !s.raiseLocked && maxTo > h.currentBet, totalPot,
      };
    }
    let myHand = null;
    if (h && me >= 0 && this.seats[me].inHand && h.board.length >= 3) {
      myHand = handName(evaluate([...this.seats[me].hole, ...h.board]));
    }
    return {
      id: this.id, sb: this.sb, bb: this.bb, hostId: this.hostId, waiting: this.hold,
      minBuyIn: this.minBuyIn, maxBuyIn: this.maxBuyIn,
      handNo: h ? h.no : this.handNo, inHand: !!h, over: h ? h.over : true,
      street: h ? h.street : null, button: this.button,
      board: h ? h.board.map(toStr) : [],
      pot: h && h.results ? 0 : totalPot - betSum, totalPot,
      toAct: h ? h.toAct : -1,
      deadlineIn: h && h.deadline ? Math.max(0, h.deadline - Date.now()) : 0,
      actionMs: this.timing.actionMs,
      seats, mySeat: me, actions, myHand,
      results: h ? h.results : null,
      log: this.log.slice(-40),
    };
  }

  // 終了：人間の卓上チップ（ハンド中の拠出分を含む）を返す
  close() {
    this.closed = true;
    this.cancel(this.timer);
    this.cancel(this.startTimer);
    const h = this.hand;
    this.seats.forEach(s => {
      if (!s || s.isBot) return;
      const committed = h && !h.over && s.inHand ? s.total : 0;
      const amt = s.stack + s.pendingRebuy + committed;
      s.stack = 0; s.pendingRebuy = 0;
      if (amt > 0) this.hooks.onCashOut?.(s.id, amt);
    });
  }
}

export { Table, N, UNIT };
