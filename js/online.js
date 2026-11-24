// ネット対戦の土台（Firebase：匿名ログインと Realtime Database）。2026-11-20
// ・Firebase の SDK は vendor/firebase/ に同梱（13.2.0）。ネット対戦を使うときだけ読み込む。
// ・データの置き場所と読み書きの規則は database.rules.json と docs/firebase-setup.md を参照。
//   rooms/<部屋コード>/meta            卓の名前・レート・ホスト・閉じたか・ホストの接続状態（ホストが書く）
//   rooms/<部屋コード>/members/<uid>   参加者の名前と接続状態（本人が書く）
//   rooms/<部屋コード>/private/<uid>   その人向けの卓の状態（JSON 文字列）と精算（ホストが書く、本人だけが読む）
//   rooms/<部屋コード>/inbox/<uid>     その人からホストへの依頼（本人が書く、ホストが読む）
import { FIREBASE_CONFIG } from './online-config.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 読み間違えやすい I・O・0・1 は使わない
export const isOnlineReady = () => !!FIREBASE_CONFIG;
export const normalizeCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
export const isValidCode = s => /^[A-Z2-9]{6}$/.test(s);

let fb = null; // 読み込んだ SDK とログイン済みの情報

// SDK を読み込み、匿名ログインして uid を返す（2回目以降は同じものを返す）
export async function connect() {
  if (!FIREBASE_CONFIG) throw new Error('ネット対戦の準備ができていません（接続情報が未設定）');
  if (fb) return fb;
  const [appM, authM, dbM] = await Promise.all([
    import('../vendor/firebase/firebase-app.js'),
    import('../vendor/firebase/firebase-auth.js'),
    import('../vendor/firebase/firebase-database.js'),
  ]);
  const app = appM.initializeApp(FIREBASE_CONFIG);
  const auth = authM.getAuth(app);
  const cred = await authM.signInAnonymously(auth);
  const db = dbM.getDatabase(app);
  fb = { uid: cred.user.uid, db, ...dbM };
  return fb;
}

const roomRef = (code, path = '') => fb.ref(fb.db, `rooms/${code}${path ? '/' + path : ''}`);

// 使われていない部屋コードを作って、ホストとして部屋を作る
export async function createRoom({ name, sb, bb, hostName }) {
  await connect();
  for (let k = 0; k < 8; k++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    const snap = await fb.get(roomRef(code, 'meta'));
    if (snap.exists()) continue;
    await fb.set(roomRef(code, 'meta'), {
      host: fb.uid, hostName, name, sb, bb, createdAt: fb.serverTimestamp(), closed: false, hostOnline: true,
    });
    return code;
  }
  throw new Error('部屋コードを作れませんでした。もう一度お試しください');
}

// ホストが自分の部屋をまるごと消す（ルールで、消せるのはその部屋のホストだけ）
export async function deleteRoom(code) {
  await connect();
  await fb.remove(roomRef(code));
}

// 部屋の情報（meta）を一度だけ読む。なければ null
export async function readRoom(code) {
  await connect();
  const snap = await fb.get(roomRef(code, 'meta'));
  return snap.exists() ? snap.val() : null;
}

// 接続状態の見張り：つながるたびに「接続中」を書き、切れたときに「切断中」と切れた時刻を書くよう予約する
function presence(onlinePath, leftAtPath) {
  return fb.onValue(fb.ref(fb.db, '.info/connected'), s => {
    if (s.val() !== true) return;
    const on = fb.ref(fb.db, onlinePath);
    const od = fb.onDisconnect(on);
    od.set(false).then(() => fb.set(on, true)).catch(() => {});
    if (leftAtPath) fb.onDisconnect(fb.ref(fb.db, leftAtPath)).set(fb.serverTimestamp()).catch(() => {});
  });
}

// サーバーの時刻と端末の時刻のずれ（ミリ秒）
export function serverOffset(cb) {
  return fb.onValue(fb.ref(fb.db, '.info/serverTimeOffset'), s => cb(s.val() || 0));
}

// ---------- ホスト側 ----------
export function hostApi(code) {
  return {
    uid: fb.uid,
    // 参加者の一覧の変化を受け取る（追加・変更・削除）
    watchMembers(cb) {
      const r = roomRef(code, 'members');
      const offs = [
        fb.onChildAdded(r, s => cb('added', s.key, s.val())),
        fb.onChildChanged(r, s => cb('changed', s.key, s.val())),
        fb.onChildRemoved(r, s => cb('removed', s.key, s.val())),
      ];
      return () => offs.forEach(o => o());
    },
    // ある参加者からの依頼を受け取り、処理したものは消す
    watchInbox(uid, cb) {
      const r = roomRef(code, `inbox/${uid}`);
      return fb.onChildAdded(r, s => {
        const v = s.val();
        fb.remove(s.ref).catch(() => {});
        try { cb(JSON.parse(v.m)); } catch { /* 壊れた依頼は捨てる */ }
      });
    },
    // その人向けの卓の状態を書く（Realtime Database は空の配列などを保存しないため JSON 文字列で書く）
    writeState(uid, state) { return fb.set(roomRef(code, `private/${uid}/state`), JSON.stringify(state)).catch(() => {}); },
    // 精算：その人の手持ちに戻すチップを記録する（参加者側が一度だけ受け取る）
    payout(uid, amount, reason) { return fb.push(roomRef(code, `private/${uid}/payouts`), { amount, reason, at: fb.serverTimestamp() }).catch(() => {}); },
    setMeta(patch) { return fb.update(roomRef(code, 'meta'), patch).catch(() => {}); },
    startPresence() { return presence(`rooms/${code}/meta/hostOnline`, `rooms/${code}/meta/hostLeftAt`); },
    close() {
      fb.onDisconnect(roomRef(code, 'meta/hostOnline')).cancel().catch(() => {});
      return fb.update(roomRef(code, 'meta'), { closed: true, hostOnline: false, closedAt: fb.serverTimestamp() }).catch(() => {});
    },
  };
}

// ---------- 参加者側 ----------
export async function joinRoom(code, name) {
  await connect();
  const meta = await readRoom(code);
  if (!meta) throw new Error('その部屋コードの卓は見つかりません');
  if (meta.closed) throw new Error('その卓はもう閉じられています');
  const me = roomRef(code, `members/${fb.uid}`);
  await fb.set(me, { name, online: true, joinedAt: fb.serverTimestamp() });
  return { uid: fb.uid, meta };
}

export function guestApi(code) {
  const uid = fb.uid;
  return {
    uid,
    // ホストへ依頼を送る
    send(msg) { return fb.push(roomRef(code, `inbox/${uid}`), { m: JSON.stringify(msg), at: fb.serverTimestamp() }); },
    // 自分向けの卓の状態
    // 卓の席（seats）を持たない値は受け取らない（壊れた値や、拒否される前に端末内で一瞬反映された書き込みなど）
    watchState(cb) {
      return fb.onValue(roomRef(code, `private/${uid}/state`), s => {
        const v = s.val();
        if (!v) return;
        let st; try { st = JSON.parse(v); } catch { return; }
        if (st && Array.isArray(st.seats)) cb(st);
      });
    },
    // 精算（手持ちに戻すチップ）
    watchPayouts(cb) { return fb.onChildAdded(roomRef(code, `private/${uid}/payouts`), s => cb(s.key, s.val())); },
    async readPayouts() { const s = await fb.get(roomRef(code, `private/${uid}/payouts`)); return s.exists() ? s.val() : {}; },
    // 卓の情報（閉じた・ホストの接続状態）
    watchMeta(cb) { return fb.onValue(roomRef(code, 'meta'), s => cb(s.val())); },
    startPresence() { return presence(`rooms/${code}/members/${uid}/online`); },
    leave() { return fb.remove(roomRef(code, `members/${uid}`)).catch(() => {}); },
  };
}
