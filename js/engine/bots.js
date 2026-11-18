import { equity, preflopPct } from './equity.js';

// CPU の強さ。proprietor は隠し要素（<勝負師> を破ったメンバーの前にだけ現れる）
// 2026-11-18 強化：プリフロップを「席の位置とハンドの強さの順位」で判断するようにし、
// フロップ以降はセミブラフ・リバーでの慎重さ・スタックを賭ける場面での締めを加えた。
//   open   : 誰も参加していないときに参加するハンドの割合（ボタンでこの約1.45倍、前の席で約0.55倍）
//   call   : レイズを受けたときにコールで続けるハンドの割合
//   three  : レイズを受けたときに、さらにレイズ（3ベット）するハンドの割合
//   limp   : レイズせずに参加（リンプ）するハンドの割合（弱い CPU の癖）
//   semi   : 引きのある手でベットする確率
//   margin : フロップ以降にコールするとき、ポットオッズに上乗せする勝率（大きいほど慎重）
const LEVELS = {
  novice: {
    label: '見習い', en: 'Novice', sims: 200, noise: 0.12, aggr: 0.3, bluff: 0.03,
    open: 0.42, call: 0.32, three: 0.03, limp: 0.3, semi: 0.08, margin: -0.02,
    slack: 0.1, station: 0.38, ranges: null, trap: 0, overbet: false, think: [700, 1600],
    names: ['Pim', 'Odile', 'Rollo', 'Bettina', 'Ferris'],
  },
  regular: {
    label: '常連', en: 'Regular', sims: 400, noise: 0.06, aggr: 0.45, bluff: 0.06,
    open: 0.34, call: 0.23, three: 0.04, limp: 0.1, semi: 0.15, margin: -0.01,
    slack: 0.04, station: 0.1, ranges: 'fixed', trap: 0.05, overbet: false, think: [800, 2000],
    names: ['Margaux', 'Callum', 'Ines', 'Laszlo', 'Noor'],
  },
  shark: {
    label: '勝負師', en: 'Shark', sims: 1000, noise: 0.015, aggr: 0.72, bluff: 0.12,
    open: 0.26, call: 0.13, three: 0.065, limp: 0, semi: 0.45, margin: 0.02,
    slack: 0, station: 0, ranges: 'fixed', trap: 0.12, overbet: false, think: [900, 2400],
    names: ['Ingram', 'Séverine', 'Dashiell', 'Isolde', 'Kasimir'],
  },
  proprietor: {
    label: '支配人', en: 'The Proprietor', sims: 1600, noise: 0, aggr: 0.85, bluff: 0.14,
    open: 0.3, call: 0.12, three: 0.085, limp: 0, semi: 0.55, margin: 0.025,
    slack: 0, station: 0, ranges: 'model', trap: 0.18, overbet: true, think: [1100, 2800],
    names: ['M. Nocturne'], hidden: true,
  },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const R = Math.random;

function buildFilters(L, ctx) {
  if (!L.ranges) return null;
  const filters = ctx.opponents.map(o => {
    let top = 1;
    if (L.ranges === 'fixed') {
      if (o.pf === 'raise') top = 0.22;
      else if (o.pf === 'call') top = 0.5;
      if (o.postAggr > 0) top *= 0.7;
    } else {
      const st = o.stats || { hands: 0 };
      const enough = st.hands >= 8;
      const h = Math.max(st.hands, 1);
      const vpip = enough ? clamp(st.vpip / h, 0.08, 0.9) : 0.35;
      const pfr = enough ? clamp(st.pfr / h, 0.04, 0.6) : 0.15;
      if (o.pf === 'raise') top = pfr;
      else if (o.pf === 'call') top = vpip;
      if (o.postAggr > 0) {
        const af = (st.bets + st.raises + 1) / (st.calls + 1);
        top *= af < 1 ? 0.5 : af < 2 ? 0.7 : 0.88;
      }
    }
    if (top >= 0.999) return null;
    const thr = 1 - clamp(top, 0.03, 1);
    return (a, b) => preflopPct(a, b) >= thr;
  });
  return filters.some(Boolean) ? filters : null;
}

/*
 ctx = {
   level, hole[2], board[], street, bb,
   pot        : 卓上の全チップ（今のストリートのベットを含む）
   toCall, currentBet, myBet, myStack, minRaiseTo, canRaise,
   position   : 0..1（1 がボタン）
   opponents  : [{ pf:'raise'|'call'|null, postAggr, stats }]
 }
 戻り値: { type:'fold'|'check'|'call'|'raise', amount?: レイズ後の合計額 }
*/
function decide(ctx) {
  let L = LEVELS[ctx.level] || LEVELS.regular;
  if (L.ranges === 'model') L = adapt(L, ctx);
  return ctx.street === 'preflop' ? preflop(L, ctx) : postflop(L, ctx);
}

// 支配人：相手の打ち方の記録（参加率・攻撃性）を見て、その場の戦い方を変える
function adapt(L, ctx) {
  const known = ctx.opponents.map(o => o.stats).filter(st => st && st.hands >= 12);
  if (!known.length) return L;
  const vpip = known.reduce((a, st) => a + st.vpip / st.hands, 0) / known.length;
  const af = known.reduce((a, st) => a + (st.bets + st.raises + 1) / (st.calls + 1), 0) / known.length;
  const A = { ...L };
  if (vpip < 0.25) { // 締まった相手：ブラインドを盗み、ブラフを増やす
    A.open = L.open * 1.3; A.bluff = L.bluff * 1.5; A.semi = Math.min(1, L.semi * 1.2);
  } else if (vpip > 0.42) { // 緩い相手：参加を絞り、強い手で大きく取る。ブラフは控える
    A.open = L.open * 0.85; A.call = L.call * 0.9; A.three = L.three * 1.3; A.bluff = L.bluff * 0.3; A.valueUp = 0.2;
  }
  if (af < 1) A.margin = L.margin + 0.03; // 受け身の相手がベットするのは強い手のときなので、慎重に付き合う
  else if (af > 2.5) A.margin = L.margin - 0.03; // 攻撃的な相手のベットには広く付き合う
  return A;
}

// レイズ後の合計額を、最小レイズ〜オールインの間に収める（残りがわずかならオールイン）
function fit(ctx, to) {
  const maxTo = ctx.myBet + ctx.myStack;
  to = Math.round(to / 5) * 5;
  to = clamp(to, ctx.minRaiseTo, maxTo);
  if (to >= maxTo * 0.7) to = maxTo;
  return { type: 'raise', amount: to };
}

// ---------- プリフロップ：ハンドの強さの順位（0..1）と席の位置で決める ----------
function preflop(L, ctx) {
  const bb = ctx.bb;
  const q = clamp(preflopPct(ctx.hole[0], ctx.hole[1]) + (R() * 2 - 1) * L.noise * 0.5, 0, 1);
  const pos = ctx.position;
  const toCall = ctx.toCall;
  const raisers = ctx.opponents.filter(o => o.pf === 'raise').length;
  const limpers = ctx.opponents.filter(o => o.pf === 'call').length;
  const odds = toCall > 0 ? toCall / (ctx.pot + toCall) : 0;
  const top = frac => q >= 1 - frac; // 上位 frac に入っているか

  // 誰もレイズしていない
  if (ctx.currentBet <= bb) {
    const openTop = L.open * (0.55 + 0.9 * pos) * (limpers ? 0.8 : 1);
    if (ctx.canRaise && top(openTop)) return fit(ctx, bb * (2.3 + R() * 0.6 + limpers));
    if (toCall <= 0) return { type: 'check' };
    if (L.limp && top(L.limp)) return { type: 'call' };
    if (toCall <= bb * 0.5 && top(openTop * 1.6)) return { type: 'call' }; // SB の残り半分
    return { type: 'fold' };
  }

  // レイズを受けている
  const bbs = ctx.currentBet / bb;
  const reraised = bbs > 7 || raisers >= 2; // 3ベット以上
  const valueTop = reraised ? L.three * 0.4 : L.three;
  const deep = toCall > ctx.myStack * 0.35; // スタックの大半を賭ける場面
  if (ctx.canRaise && top(valueTop)) {
    return fit(ctx, ctx.currentBet * (reraised ? 2.3 : pos > 0.7 ? 3 : 3.6));
  }
  let callTop = (reraised ? L.call * 0.3 : L.call) * (0.75 + 0.5 * pos);
  callTop *= clamp(0.28 / Math.max(odds, 0.05), 0.6, 1.8); // 安く入れるほど広く
  if (deep) callTop = Math.min(callTop, valueTop * 2.5);
  if (top(callTop)) return { type: 'call' };
  // 後ろの席からの軽い3ベット（強い CPU だけ）
  if (ctx.canRaise && !reraised && pos > 0.6 && q > 0.45 && R() < L.bluff * 0.5 * L.aggr) return fit(ctx, ctx.currentBet * 3);
  if (L.station && toCall <= bb * 3 && R() < L.station) return { type: 'call' };
  return { type: 'fold' };
}

// ---------- フロップ以降：相手の範囲を見積もった勝率で決める ----------
function postflop(L, ctx) {
  const nOpp = Math.max(1, ctx.opponents.length);
  const filters = buildFilters(L, ctx);
  let eq = equity(ctx.hole, ctx.board, nOpp, L.sims, filters);
  eq = clamp(eq + (R() * 2 - 1) * L.noise, 0, 1);

  // 人数差をならした強さ指標
  let hs = Math.pow(eq, 1 / Math.sqrt(nOpp));
  if (L.ranges) hs += (ctx.position - 0.5) * 0.05;

  const toCall = ctx.toCall;
  const odds = toCall > 0 ? toCall / (ctx.pot + toCall) : 0;
  const river = ctx.street === 'river';
  const strong = hs > 0.76;
  const good = hs > 0.6;
  // 引きのある手：まだ勝ってはいないが、カードが来れば逆転できる勝率帯（リバーにはない）
  const draw = !river && hs > 0.32 && hs < 0.55;
  const bet = frac => fit(ctx, ctx.currentBet + (ctx.pot + toCall) * frac);

  if (toCall <= 0) {
    if (strong && ctx.canRaise) {
      if (!river && R() < L.trap) return { type: 'check' };
      if (L.overbet && hs > 0.88 && R() < 0.3) return bet(1.2);
      return bet(0.6 + (L.valueUp || 0) + R() * 0.25);
    }
    if (good && ctx.canRaise && R() < L.aggr) return bet(0.4 + R() * 0.2);
    if (draw && ctx.canRaise && R() < L.semi * (nOpp === 1 ? 1 : 0.5)) return bet(0.5 + R() * 0.2);
    const bluffRate = L.bluff * (nOpp === 1 ? 1.4 : 0.4) * (river ? 1.1 : 1);
    if (ctx.canRaise && hs < 0.35 && R() < bluffRate) return bet(0.55 + R() * 0.25);
    return { type: 'check' };
  }

  // ベットを受けている
  const commit = toCall >= ctx.myStack * 0.5; // コールするとスタックの大半を失う
  if (strong && ctx.canRaise && R() < 0.4 + L.aggr * 0.5) return bet(0.75 + R() * 0.35);
  let need = odds - L.slack + L.margin * (river ? 1 : 0.5) + (commit ? L.margin * 2 : 0);
  if (L.ranges === 'model' && !river && toCall < ctx.myStack * 0.15) need -= 0.04; // インプライドオッズ
  if (eq >= need) {
    if (good && ctx.canRaise && !commit && R() < L.aggr * 0.25) return bet(0.6 + R() * 0.3);
    if (draw && ctx.canRaise && !commit && nOpp === 1 && R() < L.semi * 0.2) return bet(0.8 + R() * 0.3);
    return { type: 'call' };
  }
  if (L.station && toCall <= ctx.bb * 3 && R() < L.station) return { type: 'call' };
  if (ctx.canRaise && nOpp === 1 && !commit && R() < L.bluff * 0.3) return bet(0.8 + R() * 0.4);
  return { type: 'fold' };
}

export { LEVELS, decide };
