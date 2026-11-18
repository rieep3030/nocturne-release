import { equity, preflopPct } from './equity.js';

// CPU の強さ。proprietor は隠し要素（<勝負師> を破ったメンバーだけが呼べる）
const LEVELS = {
  novice: {
    label: '見習い', en: 'Novice', sims: 150, noise: 0.14, aggr: 0.25, bluff: 0.04,
    slack: 0.12, station: 0.45, ranges: null, trap: 0, overbet: false, think: [700, 1600],
    names: ['Pim', 'Odile', 'Rollo', 'Bettina', 'Ferris'],
  },
  regular: {
    label: '常連', en: 'Regular', sims: 400, noise: 0.06, aggr: 0.5, bluff: 0.08,
    slack: 0.04, station: 0.1, ranges: null, trap: 0.04, overbet: false, think: [800, 2000],
    names: ['Margaux', 'Callum', 'Ines', 'Laszlo', 'Noor'],
  },
  shark: {
    label: '勝負師', en: 'Shark', sims: 900, noise: 0.02, aggr: 0.72, bluff: 0.13,
    slack: 0.0, station: 0, ranges: 'fixed', trap: 0.1, overbet: false, think: [900, 2400],
    names: ['Ingram', 'Séverine', 'Dashiell', 'Isolde', 'Kasimir'],
  },
  proprietor: {
    label: '支配人', en: 'The Proprietor', sims: 1800, noise: 0, aggr: 0.8, bluff: 0.16,
    slack: 0.0, station: 0, ranges: 'model', trap: 0.18, overbet: true, think: [1100, 2800],
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
  const L = LEVELS[ctx.level] || LEVELS.regular;
  const nOpp = Math.max(1, ctx.opponents.length);
  const filters = buildFilters(L, ctx);
  let eq = equity(ctx.hole, ctx.board, nOpp, L.sims, filters);
  eq = clamp(eq + (R() * 2 - 1) * L.noise, 0, 1);

  // 人数差をならした強さ指標
  let hs = Math.pow(eq, 1 / Math.sqrt(nOpp));
  if (L.ranges) hs += (ctx.position - 0.5) * 0.06;

  const preflop = ctx.street === 'preflop';
  const toCall = ctx.toCall;
  const potOdds = toCall > 0 ? toCall / (ctx.pot + toCall) : 0;
  const maxTo = ctx.myBet + ctx.myStack;
  const strong = hs > 0.72;
  const good = hs > 0.58;
  const late = ctx.street === 'river' || ctx.street === 'turn';

  const sizeTo = frac => {
    let to;
    if (preflop) {
      if (ctx.currentBet <= ctx.bb) {
        const limpers = Math.max(0, Math.round((ctx.pot - ctx.bb * 1.5) / ctx.bb));
        to = ctx.bb * (2.4 + R() * 0.8 + limpers);
      } else {
        to = ctx.currentBet * (2.7 + R() * 0.6);
      }
      if (frac > 1) to *= 1.3;
    } else {
      to = ctx.currentBet + (ctx.pot + toCall) * frac;
    }
    to = Math.round(to / 5) * 5;
    to = clamp(to, ctx.minRaiseTo, maxTo);
    if (to >= maxTo * 0.82) to = maxTo;
    return to;
  };
  const raise = frac => ({ type: 'raise', amount: sizeTo(frac) });

  if (toCall <= 0) {
    if (strong && ctx.canRaise) {
      if (!preflop && !ctx.street.startsWith('river') && R() < L.trap) return { type: 'check' };
      if (L.overbet && hs > 0.86 && !preflop && R() < 0.3) return raise(1.25);
      return raise(0.55 + R() * 0.35);
    }
    if (good && ctx.canRaise && R() < L.aggr) return raise(0.4 + R() * 0.25);
    const bluffRate = L.bluff * (nOpp === 1 ? 1.5 : 0.6) * (preflop ? 0.5 : late ? 1.1 : 1);
    if (ctx.canRaise && R() < bluffRate) return raise(0.5 + R() * 0.3);
    return { type: 'check' };
  }

  // ベットを受けている
  if (strong && ctx.canRaise && R() < 0.45 + L.aggr * 0.5) return raise(0.7 + R() * 0.4);
  let need = potOdds - L.slack;
  if (L.ranges === 'model' && !preflop && ctx.street !== 'river' && toCall < ctx.myStack * 0.15) need -= 0.04; // インプライドオッズ
  if (eq >= need) {
    if (good && ctx.canRaise && R() < L.aggr * 0.25) return raise(0.6 + R() * 0.3);
    return { type: 'call' };
  }
  if (L.station && toCall <= ctx.bb * 3 && R() < L.station) return { type: 'call' };
  if (ctx.canRaise && nOpp === 1 && !preflop && R() < L.bluff * 0.4) return raise(0.8 + R() * 0.4);
  return { type: 'fold' };
}

export { LEVELS, decide };
