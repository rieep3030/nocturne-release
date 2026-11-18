// 5〜7枚の役評価。数値が大きいほど強い。

const NAMES = ['ハイカード', 'ワンペア', 'ツーペア', 'スリーカード', 'ストレート', 'フラッシュ', 'フルハウス', 'フォーカード', 'ストレートフラッシュ'];
const B4 = 16 ** 4;
const B5 = 16 ** 5;

function straightHigh(mask) {
  for (let hi = 12; hi >= 4; hi--) {
    const m = 0x1f << (hi - 4);
    if ((mask & m) === m) return hi;
  }
  if ((mask & 0x100f) === 0x100f) return 3; // A-2-3-4-5
  return -1;
}

function pack(cat, ks) {
  let s = cat;
  for (let i = 0; i < 5; i++) {
    const k = ks[i];
    s = s * 16 + (k === undefined || k < 0 ? 0 : k);
  }
  return s;
}

function evaluate(cards) {
  const rc = new Uint8Array(13);
  const sc = new Uint8Array(4);
  const sm = [0, 0, 0, 0];
  let rm = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const r = c >> 2, s = c & 3;
    rc[r]++; sc[s]++; sm[s] |= 1 << r; rm |= 1 << r;
  }
  let fs = -1;
  for (let s = 0; s < 4; s++) if (sc[s] >= 5) fs = s;
  if (fs >= 0) {
    const h = straightHigh(sm[fs]);
    if (h >= 0) return pack(8, [h]);
  }
  let q = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1, p3 = -1;
  const singles = [];
  for (let r = 12; r >= 0; r--) {
    const n = rc[r];
    if (n === 4) q = r;
    else if (n === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
    else if (n === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; else if (p3 < 0) p3 = r; }
    else if (n === 1) singles.push(r);
  }
  if (q >= 0) {
    let k = -1;
    for (let r = 12; r >= 0; r--) if (r !== q && rc[r] > 0) { k = r; break; }
    return pack(7, [q, k]);
  }
  if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return pack(6, [t1, Math.max(t2, p1)]);
  if (fs >= 0) {
    const ks = [];
    for (let r = 12; r >= 0 && ks.length < 5; r--) if (sm[fs] & (1 << r)) ks.push(r);
    return pack(5, ks);
  }
  const st = straightHigh(rm);
  if (st >= 0) return pack(4, [st]);
  if (t1 >= 0) return pack(3, [t1, singles[0], singles[1]]);
  if (p2 >= 0) return pack(2, [p1, p2, Math.max(p3, singles.length ? singles[0] : -1)]);
  if (p1 >= 0) return pack(1, [p1, singles[0], singles[1], singles[2]]);
  return pack(0, singles.slice(0, 5));
}

function category(score) { return Math.floor(score / B5); }

function handName(score) {
  const c = category(score);
  if (c === 8 && Math.floor(score / B4) % 16 === 12) return 'ロイヤルフラッシュ';
  return NAMES[c];
}

// 役を構成する5枚（表示用）
function bestFive(cards) {
  if (cards.length <= 5) return cards.slice();
  const target = evaluate(cards);
  const n = cards.length;
  const idx = [0, 1, 2, 3, 4];
  const pick = () => idx.map(i => cards[i]);
  // 組み合わせを辞書順に列挙
  for (;;) {
    const five = pick();
    if (evaluate(five) === target) return five;
    let i = 4;
    while (i >= 0 && idx[i] === n - 5 + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < 5; j++) idx[j] = idx[j - 1] + 1;
  }
  return cards.slice(0, 5);
}

export { evaluate, category, handName, bestFive, NAMES };
