// カード表現: 0..51 の整数。rank = c >> 2 (0=2 ... 12=A), suit = c & 3
export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';

export function toStr(c) { return RANKS[c >> 2] + SUITS[c & 3]; }
export function fromStr(s) { return RANKS.indexOf(s[0]) * 4 + SUITS.indexOf(s[1]); }

// 0 <= r < n の一様な乱数（暗号論的乱数、偏りなし）
function randomInt(n) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  let x;
  do { globalThis.crypto.getRandomValues(buf); x = buf[0]; } while (x >= limit);
  return x % n;
}

export function shuffledDeck() {
  const d = [];
  for (let i = 0; i < 52; i++) d.push(i);
  for (let i = 51; i > 0; i--) {
    const j = randomInt(i + 1);
    const t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}

export function randomId() {
  const b = new Uint8Array(4);
  globalThis.crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
