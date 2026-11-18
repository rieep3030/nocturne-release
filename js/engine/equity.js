import { evaluate } from './evaluator.js';

// ---- プリフロップのハンド強度（Chen 方式を全1326通りでパーセンタイル化） ----
let PF = null;

function chen(a, b) {
  const ra = a >> 2, rb = b >> 2;
  const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
  const pts = r => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
  let s = pts(hi);
  if (ra === rb) return Math.max(5, s * 2);
  if ((a & 3) === (b & 3)) s += 2;
  const gap = hi - lo - 1;
  s -= gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
  if (gap <= 1 && hi < 10) s += 1;
  return Math.ceil(s);
}

function buildPF() {
  const list = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) {
    list.push([a, b, chen(a, b) + ((a >> 2) + (b >> 2)) * 0.001]);
  }
  list.sort((x, y) => x[2] - y[2]);
  PF = new Float32Array(52 * 52);
  const n = list.length - 1;
  list.forEach(([a, b], i) => { PF[a * 52 + b] = i / n; PF[b * 52 + a] = i / n; });
}

// 0..1（1 が最強）
function preflopPct(a, b) {
  if (!PF) buildPF();
  return PF[a * 52 + b];
}

// ---- モンテカルロ勝率 ----
// filters[i] があれば i 番目の相手のハンドをその条件で絞る（棄却サンプリング）
function equity(hole, board, nOpp, sims, filters) {
  const known = new Set([...hole, ...board]);
  const deck = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  let win = 0;
  const full = new Array(5);
  const mine = new Array(7);
  const opp = new Array(7);
  const oh = new Array(nOpp * 2);
  for (let s = 0; s < sims; s++) {
    let top = deck.length;
    const draw = () => {
      const j = Math.floor(Math.random() * top);
      top--;
      const c = deck[j]; deck[j] = deck[top]; deck[top] = c;
      return c;
    };
    for (let o = 0; o < nOpp; o++) {
      const f = filters ? filters[o] : null;
      let c1, c2;
      for (let tries = 0; ; tries++) {
        c1 = draw(); c2 = draw();
        if (!f || tries >= 30 || f(c1, c2)) break;
        top += 2; // 引いた2枚を山に戻す
      }
      oh[o * 2] = c1; oh[o * 2 + 1] = c2;
    }
    for (let i = 0; i < 5; i++) full[i] = i < board.length ? board[i] : draw();
    mine[0] = hole[0]; mine[1] = hole[1];
    for (let i = 0; i < 5; i++) { mine[i + 2] = full[i]; opp[i + 2] = full[i]; }
    const my = evaluate(mine);
    let best = true, ties = 0;
    for (let o = 0; o < nOpp; o++) {
      opp[0] = oh[o * 2]; opp[1] = oh[o * 2 + 1];
      const sc = evaluate(opp);
      if (sc > my) { best = false; break; }
      if (sc === my) ties++;
    }
    if (best) win += 1 / (ties + 1);
  }
  return win / sims;
}

export { equity, preflopPct, chen };
