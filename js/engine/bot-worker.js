// CPU の判断を画面とは別のスレッドで行う（モンテカルロ計算で画面が止まらないように）
import { decide } from './bots.js';

self.onmessage = e => {
  const { id, ctx } = e.data;
  let d = null;
  try { d = decide(ctx); } catch { d = null; }
  self.postMessage({ id, d });
};
