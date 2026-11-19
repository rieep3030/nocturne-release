// 効果音の診断表示（2026-11-19）。URL の末尾に #sound を付けて開いたときだけ、画面の左下に出す。
// 実機（iPhone）で音が出ない原因を切り分けるためのもの。ふだんのプレイでは読み込まない。
export function mountSoundDebug(sfx) {
  const box = document.createElement('div');
  box.id = 'sound-debug';
  box.setAttribute('style', [
    'position:fixed', 'left:6px', 'bottom:6px', 'z-index:9999', 'max-width:300px', 'padding:6px 8px',
    'background:rgba(0,0,0,.86)', 'border:1px solid #d9c08a', 'color:#f2e2b8',
    'font:11px/1.4 ui-monospace,Menlo,monospace', 'white-space:pre-wrap', 'pointer-events:auto',
  ].join(';'));
  const text = document.createElement('div');
  const row = document.createElement('div');
  row.setAttribute('style', 'display:flex;gap:4px;margin-top:4px;flex-wrap:wrap');
  const button = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('style', 'font:11px ui-monospace,Menlo,monospace;color:#111;background:#d9c08a;border:0;padding:3px 6px');
    b.addEventListener('click', fn);
    row.append(b);
  };
  // テスト音は指を離した直後（click）に鳴らす。音を出せる状態にし直してから、少し待って鳴らす
  button('TEST TONE', () => { sfx.unlock(); setTimeout(() => sfx.play('turn'), 120); });
  button('TEST WAV', () => { sfx.unlock(); setTimeout(() => sfx.play('knock', { delay: 0 }), 120); });
  button('RESUME', () => sfx.unlock());
  box.append(text, row);
  document.body.append(box);
  const render = () => {
    const d = sfx.debug();
    const last = d.log.slice(-3).map(e => e.name).join(', ');
    text.textContent = [
      `SOUND DEBUG`,
      `state: ${d.state}  rate: ${d.sampleRate}`,
      `session: ${d.session}  muted(app): ${d.muted}`,
      `unlocks: ${d.unlocks}  resumes: ${d.resumes}`,
      `loaded: ${d.loaded.reduce((a, s) => a + Number(s.split(':')[1] || 0), 0)} files  failed: ${d.loadFailed}`,
      `last: ${last || '-'}`,
      d.errors.length ? `errors:\n  ${d.errors.join('\n  ')}` : 'errors: none',
    ].join('\n');
  };
  render();
  setInterval(render, 500);
}
