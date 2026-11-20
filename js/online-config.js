// ネット対戦の接続情報（Firebase）。docs/firebase-setup.md の手順 5 で表示される firebaseConfig をここに入れる。
// Firebase の説明では、この値はコードや設定ファイルに含めてよいとされている（データはセキュリティルールで守る）。
// null のままなら、ネット対戦のボタンは「準備中」と表示して使えないようにする。
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAF_mjw01802knIT0ASxydfIMTPYJauDQg",
  authDomain: "nocturne-online.firebaseapp.com",
  databaseURL: "https://nocturne-online-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "nocturne-online",
  storageBucket: "nocturne-online.firebasestorage.app",
  messagingSenderId: "935310816140",
  appId: "1:935310816140:web:57f1ab5825cf776e49dca9"
};
