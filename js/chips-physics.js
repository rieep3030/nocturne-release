// 3D 卓・物理演算チップ（正多面体）・テッセラクト
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// 額面と立体（面の数の順）
export const DENOMS = [
  { v: 1000, shape: 'icosa', color: '#ffc457' },
  { v: 500, shape: 'dodeca', color: '#b57bff' },
  { v: 100, shape: 'octa', color: '#ff4d6a' },
  { v: 25, shape: 'cube', color: '#3df0b2' },
  { v: 5, shape: 'tetra', color: '#8fd6ff' },
];
const MAX_PER_PILE = 30;
const G = 26;

// 卓の寸法（ワールド単位）。x が横、z が奥行き（+z が手前＝自分の席）
const TA = 10, TB = 4.875, RAIL = 0.95, RAIL_H = 0.3;
// 7人卓・左右対称。app.js の ANG と同じ値にする
const SEAT_ANG = [90, 140, 195, 245, 295, 345, 40];
// テッセラクトを卓の上から画面上部へ移したので、ボードとポットを卓の中央寄りに置く（2026-11-18）
const BOARD_Z = -0.8;
const POT_Z = 1.75;
const TESS_POS = new THREE.Vector3(0, 1.3, -1.05);
const TESS_SCALE = 1.1;

const GROUP_WORLD = 1, GROUP_CHIP = 2;

// スマホ（指で操作する端末）では描画を軽くする
const MOBILE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const PR_CAP = MOBILE ? 1.5 : 2;

function ring(deg, k) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return new THREE.Vector3(TA * k * Math.sign(c) * Math.abs(c) ** 0.6, 0, TB * k * Math.sign(s) * Math.abs(s) ** 0.6);
}

export function breakdown(amount) {
  const out = [];
  let a = Math.max(0, Math.round(amount));
  for (const d of DENOMS) {
    const k = Math.floor(a / d.v);
    if (k > 0) { out.push({ d, k }); a -= k * d.v; }
  }
  if (a > 0) out.push({ d: DENOMS[DENOMS.length - 1], k: 1 });
  return out;
}

function chipValues(amount, room) {
  const out = [];
  for (const { d, k } of breakdown(amount)) for (let i = 0; i < k; i++) out.push(d.v);
  return out.slice(0, Math.max(0, room));
}

function chipGeometry(shape) {
  switch (shape) {
    case 'tetra': return new THREE.TetrahedronGeometry(0.4);
    case 'cube': return new THREE.BoxGeometry(0.4, 0.4, 0.4);
    case 'octa': return new THREE.OctahedronGeometry(0.36);
    case 'dodeca': return new THREE.DodecahedronGeometry(0.33);
    default: return new THREE.IcosahedronGeometry(0.33);
  }
}

// 三角形分割された凸多面体から、面をまとめた cannon の凸多面体を作る
function toConvex(geo) {
  let g = geo.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g = mergeVertices(g, 1e-4);
  const pos = g.attributes.position;
  const idx = g.index.array;
  const V = [];
  for (let i = 0; i < pos.count; i++) V.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  const groups = new Map();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    const a = V[idx[t]], b = V[idx[t + 1]], c = V[idx[t + 2]];
    const n = ab.subVectors(b, a).clone().cross(ac.subVectors(c, a)).normalize();
    const key = [n.x, n.y, n.z, n.dot(a)].map(x => Math.round(x * 500)).join(',');
    if (!groups.has(key)) groups.set(key, { n, ids: new Set() });
    const s = groups.get(key).ids;
    s.add(idx[t]); s.add(idx[t + 1]); s.add(idx[t + 2]);
  }
  const faces = [];
  for (const { n, ids } of groups.values()) {
    const list = [...ids];
    const cen = list.reduce((s, i) => s.add(V[i]), new THREE.Vector3()).divideScalar(list.length);
    const u = new THREE.Vector3().subVectors(V[list[0]], cen).normalize();
    const w = new THREE.Vector3().crossVectors(n, u);
    const ang = i => { const p = new THREE.Vector3().subVectors(V[i], cen); return Math.atan2(p.dot(w), p.dot(u)); };
    list.sort((i, j) => ang(i) - ang(j));
    faces.push(list);
  }
  return new CANNON.ConvexPolyhedron({ vertices: V.map(p => new CANNON.Vec3(p.x, p.y, p.z)), faces });
}

function buildProtos() {
  const map = new Map();
  for (const d of DENOMS) {
    const col = new THREE.Color(d.color);
    const geo = chipGeometry(d.shape);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x0c0b10, metalness: 0.78, roughness: 0.26, emissive: col, emissiveIntensity: 0.08, envMapIntensity: 0.9,
    }));
    mesh.castShadow = true;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 10),
      new THREE.LineBasicMaterial({ color: col.clone().multiplyScalar(2.6), toneMapped: false }));
    mesh.add(edges);
    map.set(d.v, { mesh, shape: toConvex(geo) });
  }
  return map;
}

function stadiumShape(a, b) {
  const s = new THREE.Shape();
  const L = a - b;
  s.moveTo(-L, -b);
  s.lineTo(L, -b);
  s.absarc(L, 0, b, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-L, b);
  s.absarc(-L, 0, b, Math.PI / 2, Math.PI * 1.5, false);
  return s;
}

function stadiumPoints(a, b, n, y) {
  const L = a - b, r = b;
  const per = 4 * L + 2 * Math.PI * r;
  const pts = [];
  for (let i = 0; i < n; i++) {
    let s = (i / n) * per, x, z;
    if (s < 2 * L) { x = -L + s; z = r; }
    else if ((s -= 2 * L) < Math.PI * r) { const t = Math.PI / 2 - s / r; x = L + r * Math.cos(t); z = r * Math.sin(t); }
    else if ((s -= Math.PI * r) < 2 * L) { x = L - s; z = -r; }
    else { s -= 2 * L; const t = -Math.PI / 2 - s / r; x = -L + r * Math.cos(t); z = r * Math.sin(t); }
    pts.push(new THREE.Vector3(x, y, z));
  }
  return pts;
}

function glowTube(a, b, y, radius, color, k) {
  const curve = new THREE.CatmullRomCurve3(stadiumPoints(a, b, 160, y), true, 'catmullrom', 0);
  return new THREE.Mesh(new THREE.TubeGeometry(curve, 480, radius, 6, true),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: false }));
}

function rand(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); }

function canvasStadium(ctx, x, y, w, h) {
  const r = Math.min(w, h) / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
}

const ease = k => 1 - Math.pow(1 - k, 3);
const easeIn = k => k * k * k;

export class TableStage {
  constructor(canvas) {
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.pr = Math.min(window.devicePixelRatio || 1, PR_CAP);
    r.setPixelRatio(this.pr);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    const env = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
    // WebGL が一度失われて戻ったとき、環境マップ（描画で作るテクスチャ）は自動では戻らないので作り直す（B-42）
    r.domElement.addEventListener('webglcontextrestored', () => {
      const env2 = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
      if (this.ui) this.ui.environment = env2;
      if (this.s3) this.s3.environment = env2;
    });

    // 入口・ロビー用（画面座標の正投影）
    this.ui = new THREE.Scene();
    this.ui.environment = env;
    this.uiCam = new THREE.OrthographicCamera(0, 1, 0, -1, 0.1, 6000);
    this.uiCam.position.z = 1000;
    this.ui.add(new THREE.AmbientLight(0xffffff, 0.3));
    const dl = new THREE.DirectionalLight(0xfff0d8, 1.6);
    dl.position.set(-0.4, 1, 1.3);
    this.ui.add(dl);
    this.bgCanvas = document.createElement('canvas');
    this.bgTex = new THREE.CanvasTexture(this.bgCanvas);
    this.bgTex.colorSpace = THREE.SRGBColorSpace;
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.bgTex, toneMapped: false, depthWrite: false }));
    this.bg.position.z = -3000;
    this.ui.add(this.bg);

    // 卓
    this.s3 = new THREE.Scene();
    this.s3.environment = env;
    this.s3.background = new THREE.Color(0x050406);
    this.s3.fog = new THREE.Fog(0x050406, 28, 70);
    this.cam = new THREE.PerspectiveCamera(30, 1, 0.5, 200);
    this.s3.add(new THREE.AmbientLight(0xffffff, 0.05));
    this.s3.add(new THREE.HemisphereLight(0x9fb8ff, 0x0a0806, 0.1));
    const spot = new THREE.SpotLight(0xffe2b8, 1.0, 0, 0.55, 0.85, 0);
    spot.position.set(0, 17, 6);
    spot.castShadow = true;
    spot.shadow.mapSize.set(MOBILE ? 512 : 1024, MOBILE ? 512 : 1024);
    spot.shadow.camera.near = 6;
    spot.shadow.camera.far = 30;
    spot.shadow.bias = -0.0006;
    this.s3.add(spot, spot.target);
    this.tessLight = new THREE.PointLight(0xe6f2ff, 0.35, 6, 0);
    this.tessLight.position.copy(TESS_POS);
    this.s3.add(this.tessLight);
    // テッセラクトの置き場所（2026-11-18 から画面上部バーの中央。placeTesseract で毎回決め直す）
    this.tessBase = TESS_POS.clone();
    this.tessScale = 1;

    this.protos = buildProtos();
    this.buildTable();
    this.buildTesseract();
    this.initPhysics();

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: MOBILE ? 2 : 4 });
    this.composer = new EffectComposer(r, rt);
    this.renderPass = new RenderPass(this.ui, this.uiCam);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.42, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.anchors = {
      seat: SEAT_ANG.map(a => ring(a, 1.07)),
      bet: SEAT_ANG.map(a => ring(a, 0.6)),
      win: SEAT_ANG.map(a => ring(a, 0.76)),
      throwFrom: SEAT_ANG.map(a => ring(a, 0.9)),
      dealer: SEAT_ANG.map(a => ring(a + (a > 180 && a < 360 ? -14 : 14), 0.85)),
      pot: new THREE.Vector3(0, 0, POT_Z),
      board: new THREE.Vector3(0, 0, BOARD_Z),
    };
    this.piles = new Map();
    this.chips = [];
    this.fx = [];
    this.queue = [];
    this.showcase = [];
    this.mode = '';
    this.layoutArea = null;

    this.resize();
    this.setMode('showcase');
    window.addEventListener('resize', () => this.resize());
    if (document.fonts) document.fonts.ready.then(() => { this.redrawBg(); this.drawFelt(); });
    this.last = performance.now();
    const loop = now => { this.tick(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ---------------- 卓の構築 ----------------
  buildTable() {
    const outer = stadiumShape(TA + RAIL, TB + RAIL);
    outer.holes.push(stadiumShape(TA, TB));
    const railGeo = new THREE.ExtrudeGeometry(outer, {
      depth: RAIL_H, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 4, curveSegments: 48,
    });
    railGeo.rotateX(-Math.PI / 2);
    const rail = new THREE.Mesh(railGeo, new THREE.MeshPhysicalMaterial({
      color: 0x0e0c11, roughness: 0.3, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.18, envMapIntensity: 0.35,
    }));
    rail.receiveShadow = true;
    this.s3.add(rail);

    const baseGeo = new THREE.ExtrudeGeometry(stadiumShape(TA + RAIL - 0.05, TB + RAIL - 0.05), { depth: 0.6, bevelEnabled: false, curveSegments: 48 });
    baseGeo.rotateX(-Math.PI / 2);
    const base = new THREE.Mesh(baseGeo, new THREE.MeshStandardMaterial({ color: 0x08070a, roughness: 0.6, metalness: 0.4, envMapIntensity: 0.2 }));
    base.position.y = -0.62;
    this.s3.add(base);

    const feltGeo = new THREE.ShapeGeometry(stadiumShape(TA, TB), 64);
    const p = feltGeo.attributes.position, uv = feltGeo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + TA) / (2 * TA), (p.getY(i) + TB) / (2 * TB));
    feltGeo.rotateX(-Math.PI / 2);
    this.feltCanvas = document.createElement('canvas');
    this.feltCanvas.width = 2048;
    this.feltCanvas.height = Math.round(2048 * TB / TA);
    this.feltTex = new THREE.CanvasTexture(this.feltCanvas);
    this.feltTex.colorSpace = THREE.SRGBColorSpace;
    this.feltTex.anisotropy = 4;
    // フェルトは物理の卓面（y=0）より少し下に描き、重なったときは奥に回す（チップの底が隠れて、めり込んで見えるのを防ぐ）
    const felt = new THREE.Mesh(feltGeo, new THREE.MeshStandardMaterial({
      map: this.feltTex, roughness: 0.95, metalness: 0, envMapIntensity: 0.08,
      polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    }));
    felt.position.y = -0.004;
    felt.receiveShadow = true;
    this.s3.add(felt);
    this.drawFelt();

    // 縁に走る光のライン（真鍮色）
    const gold = 0xffbe6a;
    this.s3.add(glowTube(TA + RAIL / 2, TB + RAIL / 2, RAIL_H + 0.075, 0.014, gold, 1.35));
    this.s3.add(glowTube(TA + 0.03, TB + 0.03, 0.02, 0.01, gold, 0.6));
    this.s3.add(glowTube(TA + RAIL + 0.1, TB + RAIL + 0.1, -0.08, 0.018, gold, 1.05));

    // 床のグリッド
    const gc = document.createElement('canvas');
    gc.width = gc.height = 256;
    const gx = gc.getContext('2d');
    gx.strokeStyle = 'rgba(200,167,101,0.55)';
    gx.lineWidth = 1.5;
    gx.strokeRect(0.5, 0.5, 255, 255);
    const gt = new THREE.CanvasTexture(gc);
    gt.wrapS = gt.wrapT = THREE.RepeatWrapping;
    gt.repeat.set(40, 40);
    gt.anisotropy = 4;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(160, 160),
      new THREE.MeshBasicMaterial({ map: gt, transparent: true, opacity: 0.07, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.4;
    this.s3.add(floor);
  }

  drawFelt() {
    const c = this.feltCanvas, ctx = c.getContext('2d');
    const W = c.width, H = c.height;
    const g = ctx.createRadialGradient(W / 2, H * 0.48, 0, W / 2, H / 2, W * 0.62);
    g.addColorStop(0, '#12292b');
    g.addColorStop(0.55, '#0b1a1c');
    g.addColorStop(1, '#050c0d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 26000; i++) {
      const s = i * 1.618;
      ctx.fillStyle = rand(s) > 0.5 ? 'rgba(255,255,255,0.022)' : 'rgba(0,0,0,0.13)';
      ctx.fillRect(rand(s + 1) * W, rand(s + 2) * H, 1.4, 1.4);
    }
    // ベッティングライン
    const ins = H * 0.15;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(200,167,101,0.22)';
    canvasStadium(ctx, ins, ins, W - ins * 2, H - ins * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(200,167,101,0.08)';
    canvasStadium(ctx, ins + 10, ins + 10, W - ins * 2 - 20, H - ins * 2 - 20);
    ctx.stroke();
    // テッセラクトの投影台
    const px = W / 2, py = ((TESS_POS.z + TB) / (2 * TB)) * H, pr = (1.05 / (2 * TA)) * W;
    ctx.strokeStyle = 'rgba(230,240,255,0.16)';
    ctx.lineWidth = 2;
    for (const k of [1, 0.78, 0.5]) { ctx.beginPath(); ctx.arc(px, py, pr * k, 0, Math.PI * 2); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(230,240,255,0.12)';
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2, r1 = pr * (k % 4 === 0 ? 1.08 : 1.03), r2 = pr * 1.15;
      ctx.beginPath(); ctx.moveTo(px + Math.cos(a) * r1, py + Math.sin(a) * r1); ctx.lineTo(px + Math.cos(a) * r2, py + Math.sin(a) * r2); ctx.stroke();
    }
    // 紋章
    const size = H * 0.05;
    const ey = H * 0.2;
    ctx.font = `500 ${size}px "Oxanium", sans-serif`; // 読み込んでいるフォントで描く（B-32）
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${size * 0.55}px`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(200,167,101,0.3)';
    ctx.fillText('NOCTURNE', W / 2 + size * 0.27, ey);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const tw = size * 9.2;
    ctx.strokeStyle = 'rgba(200,167,101,0.22)';
    for (const sgn of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + sgn * (tw / 2 + 10), ey);
      ctx.lineTo(W / 2 + sgn * (tw / 2 + size * 2.6), ey);
      ctx.stroke();
    }
    this.feltTex.needsUpdate = true;
  }

  // ---------------- テッセラクト ----------------
  buildTesseract() {
    this.tv = [];
    for (let i = 0; i < 16; i++) this.tv.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
    this.te = [];
    for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
      const x = i ^ j;
      if (x && !(x & (x - 1))) this.te.push([i, j]);
    }
    this.tArr = new Float32Array(this.te.length * 6);
    this.tGeo = new LineSegmentsGeometry();
    this.tGeo.setPositions(this.tArr);
    this.tMat = new LineMaterial({ color: 0xffffff, linewidth: 1.3, worldUnits: false, toneMapped: false });
    this.tLines = new LineSegments2(this.tGeo, this.tMat);
    this.tLines.frustumCulled = false;
    this.tLines.position.copy(TESS_POS);
    this.s3.add(this.tLines);
    this.tPts = new THREE.Points(new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: new THREE.Color(1.1, 1.1, 1.1), size: 0.045, toneMapped: false }));
    this.tPts.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(48), 3));
    this.tPts.frustumCulled = false;
    this.tPts.position.copy(TESS_POS);
    this.s3.add(this.tPts);
    // 投影の光柱
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 1.0, TESS_POS.y, 40, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xd8e8ff, transparent: true, opacity: 0.018, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(TESS_POS.x, TESS_POS.y / 2, TESS_POS.z);
    beam.visible = false; // テッセラクトを画面上部へ移したので光柱は出さない
    this.s3.add(beam);
    this.tA = 0; this.tB = 0; this.tC = 0; this.tPulse = 0; this.tTime = 0;
  }

  updateTesseract(dt) {
    const sp = 0.22 + this.tPulse * 1.8;
    this.tA += dt * sp * 0.9;
    this.tB += dt * sp * 0.55;
    this.tC += dt * sp * 0.32;
    this.tTime += dt;
    this.tPulse = Math.max(0, this.tPulse - dt * 1.1);
    const [ca, sa, cb, sb, cc, sc] = [Math.cos(this.tA), Math.sin(this.tA), Math.cos(this.tB), Math.sin(this.tB), Math.cos(this.tC), Math.sin(this.tC)];
    const P = this.tv.map(([x0, y0, z0, w0]) => {
      let x = x0 * ca - w0 * sa, w = x0 * sa + w0 * ca; // XW
      const y = y0 * cb - w * sb; w = y0 * sb + w * cb; // YW
      const z = z0;
      const x2 = x * cc - z * sc, z2 = x * sc + z * cc; // XZ
      const k = (TESS_SCALE * 1.25) / (2.8 - w);
      return [x2 * k, y * k, z2 * k];
    });
    this.te.forEach(([i, j], n) => { this.tArr.set(P[i], n * 6); this.tArr.set(P[j], n * 6 + 3); });
    const inst = this.tGeo.attributes.instanceStart.data;
    inst.array.set(this.tArr);
    inst.needsUpdate = true;
    const pa = this.tPts.geometry.attributes.position;
    P.forEach((p, i) => pa.setXYZ(i, p[0], p[1], p[2]));
    pa.needsUpdate = true;
    const bob = Math.sin(this.tTime * 1.2) * 0.07 * this.tessScale;
    this.tLines.position.copy(this.tessBase);
    this.tLines.position.y += bob;
    this.tPts.position.copy(this.tLines.position);
    const glow = 0.96 + this.tPulse * 0.55;
    this.tMat.color.setRGB(glow, glow, glow);
    this.tessLight.intensity = 0.3 + this.tPulse * 0.9;
  }

  pulse(v = 1) { this.tPulse = Math.max(this.tPulse, v); }

  // ---------------- 物理 ----------------
  initPhysics() {
    const w = this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -G, 0) });
    w.broadphase = new CANNON.SAPBroadphase(w);
    w.allowSleep = true;
    w.solver.iterations = 10;
    this.matGround = new CANNON.Material('ground');
    this.matChip = new CANNON.Material('chip');
    w.addContactMaterial(new CANNON.ContactMaterial(this.matGround, this.matChip, { friction: 0.6, restitution: 0.12 }));
    w.addContactMaterial(new CANNON.ContactMaterial(this.matChip, this.matChip, { friction: 0.4, restitution: 0.1 }));
    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: this.matGround, collisionFilterGroup: GROUP_WORLD });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    w.addBody(ground);
    // レールの内側に沿った見えない壁
    const pts = stadiumPoints(TA, TB, 64, 0);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const len = dir.length();
      const out = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
      if (out.dot(mid) < 0) out.negate();
      const body = new CANNON.Body({
        mass: 0, material: this.matGround, collisionFilterGroup: GROUP_WORLD,
        shape: new CANNON.Box(new CANNON.Vec3(len / 2 + 0.08, 1.2, 0.25)),
      });
      body.position.set(mid.x + out.x * 0.25, 1.2, mid.z + out.z * 0.25);
      body.quaternion.setFromEuler(0, -Math.atan2(dir.z, dir.x), 0);
      w.addBody(body);
    }
  }

  makeChip(v, pos, opts = {}) {
    const P = this.protos.get(v);
    const mesh = P.mesh.clone();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
    mesh.position.copy(pos);
    mesh.quaternion.copy(q);
    this.s3.add(mesh);
    const body = new CANNON.Body({
      mass: 1, shape: P.shape, material: this.matChip, linearDamping: 0.32, angularDamping: 0.5,
      allowSleep: true, sleepSpeedLimit: 0.35, sleepTimeLimit: 0.3,
      collisionFilterGroup: GROUP_CHIP, collisionFilterMask: GROUP_WORLD,
    });
    body.position.set(pos.x, pos.y, pos.z);
    body.quaternion.set(q.x, q.y, q.z, q.w);
    if (opts.vel) body.velocity.set(opts.vel.x, opts.vel.y, opts.vel.z);
    const sp = opts.spin ?? 6;
    body.angularVelocity.set((Math.random() - 0.5) * sp, (Math.random() - 0.5) * sp, (Math.random() - 0.5) * sp);
    this.world.addBody(body);
    const chip = { mesh, body, born: performance.now(), grow: opts.grow || 0 };
    // 当たった瞬間に音を出す（cannon-es の collide は接触の始まりにだけ来る）
    body.addEventListener('collide', e => {
      if (!this.onSound || (opts.silent && performance.now() - chip.born < 700)) return;
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
      if (v < 1.2) return;
      this.onSound(e.body.mass === 0 ? 'lay' : 'collide', { vol: Math.min(1, v / 8) });
    });
    if (chip.grow) mesh.scale.setScalar(0.15);
    this.chips.push(chip);
    // 生成直後はチップ同士の衝突を切り、重なりによる弾けを防ぐ
    setTimeout(() => { body.collisionFilterMask = GROUP_WORLD | GROUP_CHIP; }, opts.ghostMs ?? 160);
    return chip;
  }

  ballistic(from, to, T) {
    return new THREE.Vector3((to.x - from.x) / T, (to.y - from.y + 0.5 * G * T * T) / T, (to.z - from.z) / T);
  }

  jitter(p, r) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
    return new THREE.Vector3(p.x + Math.cos(a) * d, p.y, p.z + Math.sin(a) * d);
  }

  schedule(ms, fn) { this.queue.push({ at: performance.now() + ms, fn }); }

  pile(key) {
    // gen は回収・消去のたびに進み、それ以前に予約された生成を無効にする
    if (!this.piles.has(key)) this.piles.set(key, { amount: 0, chips: [], gen: 0 });
    return this.piles.get(key);
  }

  removeChip(c) {
    this.world.removeBody(c.body);
    this.s3.remove(c.mesh);
    const i = this.chips.indexOf(c);
    if (i >= 0) this.chips.splice(i, 1);
  }

  // テッセラクトへ吸い込む
  absorb(p, delay = 0) {
    const list = p.chips.splice(0);
    p.amount = 0;
    p.gen++;
    p.pending = 0; // 前の世代の飛行中の分は数えない（B-31）
    list.forEach((c, k) => {
      this.world.removeBody(c.body);
      const i = this.chips.indexOf(c);
      if (i >= 0) this.chips.splice(i, 1);
      this.fx.push({ kind: 'absorb', mesh: c.mesh, from: c.mesh.position.clone(), t0: performance.now() + delay + k * 18, dur: 520 });
    });
    if (list.length) {
      // clearPiles は予約を消すので、遅れのないときはその場で鳴らす
      if (delay > 0) this.schedule(delay, () => this.onSound?.('stack', { vol: 0.8 }));
      else this.onSound?.('stack', { vol: 0.8 });
      this.schedule(delay + 250, () => this.pulse(0.8));
    }
  }

  vanish(p) {
    for (const c of p.chips.splice(0)) this.removeChip(c);
    p.amount = 0;
    p.gen++;
    p.pending = 0; // B-31
  }

  // 重ならない位置（六角配置を段ごとに積む）に置いて静かに落とす
  place(p, amount, anchor) {
    chipValues(amount, MAX_PER_PILE - p.chips.length).forEach((v, k) => {
      const layer = Math.floor(k / 7), i = k % 7;
      const a = (i / 6) * Math.PI * 2 + layer * 0.5;
      const r = i === 0 ? 0 : 0.86;
      const pos = new THREE.Vector3(anchor.x + Math.cos(a) * r, 0.42 + layer * 0.88, anchor.z + Math.sin(a) * r);
      p.chips.push(this.makeChip(v, pos, { spin: 0.5, ghostMs: 0, silent: true }));
    });
    p.amount = amount;
  }

  // 席から投げる
  throwTo(p, delta, from, to, total) {
    const gen = p.gen;
    chipValues(delta, MAX_PER_PILE - p.chips.length - (p.pending || 0)).forEach((v, k) => {
      p.pending = (p.pending || 0) + 1;
      this.schedule(k * 55, () => {
        if (p.gen !== gen) return; // 投げ終わる前に回収された（数は世代が変わったときに 0 に戻してある。B-31）
        p.pending--;
        if (k === 0) this.onSound?.('handle');
        const s = this.jitter(from, 0.2).setY(0.9);
        // 着地後に少し転がるので、目標の手前を狙う
        const aim = new THREE.Vector3().lerpVectors(from, to, 0.86);
        const t = this.jitter(aim, 0.35).setY(0.3);
        const c = this.makeChip(v, s, { vel: this.ballistic(s, t, 0.5 + Math.random() * 0.08), spin: 10 });
        p.chips.push(c);
      });
    });
    p.amount = total;
  }

  // テッセラクトから放出し、目標の真上まで運んでから物理演算で落とす
  emitTo(p, amount, to, delay = 0, radius = 0.5) {
    const gen = p.gen;
    chipValues(amount, MAX_PER_PILE - p.chips.length - (p.pending || 0)).forEach((v, k) => {
      p.pending = (p.pending || 0) + 1;
      this.schedule(delay + k * 70, () => {
        if (p.gen !== gen) return; // B-31
        this.pulse(1);
        const mesh = this.protos.get(v).mesh.clone();
        mesh.position.copy(this.tLines.position);
        mesh.scale.setScalar(0.15);
        this.s3.add(mesh);
        const t = this.jitter(to, radius);
        t.y = 1.5 + Math.random() * 0.9;
        this.fx.push({
          kind: 'emit', mesh, from: this.tLines.position.clone(), to: t, t0: performance.now(), dur: 440,
          done: () => {
            this.s3.remove(mesh);
            if (p.gen !== gen) return; // 飛んでいる間に片付けられた（B-31）
            p.pending--;
            const c = this.makeChip(v, t, { vel: new THREE.Vector3(0, -2.5, 0), spin: 5, ghostMs: 120 });
            c.mesh.quaternion.copy(mesh.quaternion);
            c.body.quaternion.set(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
            p.chips.push(c);
          },
        });
      });
    });
    p.amount += amount;
  }

  // ---------------- 外部から呼ぶ操作 ----------------
  setBet(d, amount, animate) {
    const p = this.pile('bet' + d);
    if (amount === p.amount) return;
    if (amount <= 0) { this.absorb(p); return; }
    if (animate && amount > p.amount) this.throwTo(p, amount - p.amount, this.anchors.throwFrom[d], this.anchors.bet[d], amount);
    else { this.vanish(p); this.place(p, amount, this.anchors.bet[d]); }
  }

  setPot(amount, emit) {
    const p = this.pile('pot');
    if (amount === p.amount) return;
    if (amount <= 0) { this.absorb(p); return; }
    if (emit && amount > p.amount) this.emitTo(p, amount - p.amount, this.anchors.pot, 620, 0.7);
    else { this.vanish(p); this.place(p, amount, this.anchors.pot); }
  }

  payout(d, amount) {
    const p = this.pile('win' + d);
    this.schedule(700, () => this.onSound?.('payout')); // テッセラクトからチップが出始める頃に鳴らす
    this.emitTo(p, amount, this.anchors.win[d], 700, 0.45);
  }

  clearPiles(animate) {
    for (const p of this.piles.values()) { animate ? this.absorb(p) : this.vanish(p); p.pending = 0; }
    this.queue = [];
  }

  // ---------------- 画面配置（3D の位置を画面座標へ） ----------------
  project(v) {
    const p = v.clone().project(this.cam);
    return { x: ((p.x + 1) / 2) * this.W, y: ((1 - p.y) / 2) * this.H };
  }

  fitCamera(area) {
    const cam = this.cam;
    cam.aspect = this.W / this.H;
    cam.clearViewOffset();
    const compact = area.height < 420;
    const padX = compact ? 70 : Math.min(120, area.width * 0.08);
    const padT = compact ? 30 : 56;
    const padB = compact ? 26 : 48;
    const availW = area.width - padX * 2, availH = area.height - padT - padB;
    const pitch = compact ? 0.78 : 0.86;
    const target = new THREE.Vector3(0, 0, 0.25);
    const dir = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch));
    const pts = [...stadiumPoints(TA + RAIL + 0.15, TB + RAIL + 0.15, 48, 0), ...stadiumPoints(TA + RAIL, TB + RAIL, 48, RAIL_H)];
    const box = () => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const v of pts) { const s = this.project(v); x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y); }
      return { x0, y0, x1, y1 };
    };
    const at = dist => {
      cam.position.copy(target).addScaledVector(dir, dist);
      cam.lookAt(target);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
    };
    let lo = 5, hi = 220;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      at(mid);
      const b = box();
      if (b.x1 - b.x0 <= availW && b.y1 - b.y0 <= availH) hi = mid; else lo = mid;
    }
    at(hi);
    const b = box();
    const offX = (b.x0 + b.x1) / 2 - (area.left + padX + availW / 2);
    const offY = (b.y0 + b.y1) / 2 - (area.top + padT + availH / 2);
    cam.setViewOffset(this.W, this.H, offX, offY, this.W, this.H);
    cam.updateMatrixWorld();
    this.placeTesseract(area);
  }

  // テッセラクトを画面上部の中央に置く：その画面位置へ向かう視線上、カメラから一定距離の点に置く。
  // 大きさは卓の画面の高さの24%（最小 56px）。上部バーから卓の奥の縁にかかる位置になる
  // （2026-11-26：PC の大きな画面で小さすぎたため、上限 80px を外した。携帯の横画面では今までどおり約70px）
  placeTesseract(area) {
    const cam = this.cam;
    const sizePx = Math.max(56, area.height * 0.24);
    const px = this.W / 2, py = Math.max(area.top / 2, sizePx / 2 + 4);
    const p = new THREE.Vector3((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1, 0.5).unproject(cam);
    const dir = p.sub(cam.position).normalize();
    const D = 8;
    this.tessBase.copy(cam.position).addScaledVector(dir, D);
    const worldPerPx = (2 * D * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / this.H;
    const s = (sizePx * worldPerPx) / 2.4; // 2.4 = 縮める前の見かけの高さ（ワールド単位）
    this.tessScale = s;
    this.tLines.scale.setScalar(s);
    this.tPts.scale.setScalar(s);
    this.tPts.material.size = 0.045 * s;
    this.tLines.position.copy(this.tessBase);
    this.tPts.position.copy(this.tessBase);
  }

  layout(area) {
    if (window.innerWidth !== this.W || window.innerHeight !== this.H) this.resize();
    this.layoutArea = { left: area.left, top: area.top, width: area.width, height: area.height };
    this.fitCamera(this.layoutArea);
    const A = this.anchors;
    const pr = v => this.project(v);
    const c1 = pr(new THREE.Vector3(-0.55, 0, BOARD_Z)), c2 = pr(new THREE.Vector3(0.55, 0, BOARD_Z));
    return {
      seat: A.seat.map(pr), bet: A.bet.map(pr), dealer: A.dealer.map(pr), win: A.win.map(pr),
      pot: pr(A.pot), board: pr(A.board), tess: pr(this.tessBase),
      cw: Math.max(22, Math.min(78, (c2.x - c1.x) * 0.92)),
    };
  }

  // ---------------- 入口のショーケース ----------------
  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    if (mode === 'table') {
      this.renderPass.scene = this.s3;
      this.renderPass.camera = this.cam;
      this.bloom.strength = 0.7;
      this.bloom.radius = 0.32;
      this.bloom.threshold = 0.92;
    } else {
      for (const p of this.piles.values()) { this.vanish(p); p.pending = 0; }
      this.queue = [];
      for (const f of this.fx) this.s3.remove(f.mesh);
      this.fx = [];
      this.renderPass.scene = this.ui;
      this.renderPass.camera = this.uiCam;
      this.bloom.strength = 0.85;
      this.bloom.radius = 0.42;
      this.bloom.threshold = 0.9;
    }
    if (mode === 'showcase') this.buildShowcase(); else this.clearShowcase();
    this.redrawBg();
  }

  buildShowcase() {
    this.clearShowcase();
    DENOMS.slice().reverse().forEach((d, i) => {
      const g = new THREE.Group();
      const m = this.protos.get(d.v).mesh.clone();
      g.add(m);
      g.userData = { i, phase: i * 1.3 };
      this.ui.add(g);
      this.showcase.push(g);
    });
    this.layoutShowcase();
  }

  clearShowcase() {
    for (const g of this.showcase) this.ui.remove(g);
    this.showcase = [];
  }

  layoutShowcase() {
    const n = this.showcase.length;
    if (!n) return;
    const R = Math.max(18, Math.min(46, Math.min(this.W, this.H) * 0.045));
    const span = Math.min(this.W * 0.82, R * 3 * n);
    this.showcase.forEach((g, i) => {
      g.userData.base = { x: this.W / 2 - span / 2 + (span * (i + 0.5)) / n, y: this.H - Math.max(R * 2.2, this.H * 0.11) };
      g.scale.setScalar(R / 0.36);
    });
  }

  // ---------------- 入口・ロビーの背景 ----------------
  redrawBg() {
    const W = this.W, H = this.H, pr = this.pr;
    if (!W || !H) return;
    const c = this.bgCanvas;
    const cw = Math.round(W * pr), ch = Math.round(H * pr);
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
      this.bgTex.dispose();
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(pr, 0, 0, pr, 0, 0);
    ctx.fillStyle = '#050406';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(200,167,101,0.024)';
    for (let x = 0; x < W; x += 9) ctx.fillRect(x, 0, 0.6, H);
    const lamp = ctx.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.max(W, H) * 0.65);
    lamp.addColorStop(0, 'rgba(214,176,108,0.09)');
    lamp.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = lamp;
    ctx.fillRect(0, 0, W, H);
    // 遠近のグリッド（床）
    const hy = H * 0.68;
    ctx.save();
    const fade = ctx.createLinearGradient(0, hy, 0, H);
    fade.addColorStop(0, 'rgba(200,167,101,0)');
    fade.addColorStop(1, 'rgba(200,167,101,0.16)');
    ctx.strokeStyle = fade;
    ctx.lineWidth = 1;
    for (let k = -24; k <= 24; k++) {
      ctx.beginPath(); ctx.moveTo(W / 2 + k * 18, hy); ctx.lineTo(W / 2 + k * W * 0.09, H); ctx.stroke();
    }
    for (let k = 1; k < 14; k++) {
      const y = hy + (H - hy) * Math.pow(k / 14, 2.2);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();
    // 二重罫と扇
    ctx.strokeStyle = 'rgba(200,167,101,0.16)';
    const m = Math.min(28, W * 0.04);
    ctx.strokeRect(m + 0.5, m + 0.5, W - 2 * m - 1, H - 2 * m - 1);
    ctx.strokeStyle = 'rgba(200,167,101,0.07)';
    ctx.strokeRect(m + 6.5, m + 6.5, W - 2 * m - 13, H - 2 * m - 13);
    const fx = W / 2, fy = H * 0.5, R = Math.max(W, H) * 0.62;
    ctx.strokeStyle = 'rgba(200,167,101,0.045)';
    for (let k = 0; k <= 24; k++) {
      const a = Math.PI + (Math.PI * k) / 24;
      ctx.beginPath(); ctx.moveTo(fx + Math.cos(a) * R * 0.18, fy + Math.sin(a) * R * 0.18); ctx.lineTo(fx + Math.cos(a) * R, fy + Math.sin(a) * R); ctx.stroke();
    }
    const vig = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
    this.bgTex.needsUpdate = true;
  }

  resize() {
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.pr = Math.min(window.devicePixelRatio || 1, PR_CAP);
    this.renderer.setPixelRatio(this.pr);
    this.renderer.setSize(this.W, this.H, false);
    this.composer.setPixelRatio(this.pr);
    this.composer.setSize(this.W, this.H);
    Object.assign(this.uiCam, { left: 0, right: this.W, top: 0, bottom: -this.H });
    this.uiCam.updateProjectionMatrix();
    this.bg.scale.set(this.W, this.H, 1);
    this.bg.position.set(this.W / 2, -this.H / 2, -3000);
    this.tMat.resolution.set(this.W, this.H);
    if (this.layoutArea) this.fitCamera(this.layoutArea);
    this.layoutShowcase();
    this.redrawBg();
  }

  // ---------------- 毎フレーム ----------------
  tick(now) {
    if (window.innerWidth !== this.W || window.innerHeight !== this.H) this.resize();
    if (!this.W || !this.H) return;
    // 描画が遅い端末でも物理は実時間で進める（最大 0.15 秒ぶん追いつく）
    const dt = Math.min(0.15, (now - this.last) / 1000);
    this.last = now;
    if (this.mode === 'table') {
      if (this.queue.length) {
        const due = this.queue.filter(q => q.at <= now);
        this.queue = this.queue.filter(q => q.at > now);
        for (const q of due) q.fn();
      }
      this.world.step(1 / 60, dt, 10);
      for (const c of this.chips.slice()) {
        const b = c.body;
        c.mesh.position.set(b.position.x, b.position.y, b.position.z);
        c.mesh.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        if (c.grow) {
          const k = Math.min(1, (now - c.born) / 260);
          c.mesh.scale.setScalar(0.15 + 0.85 * ease(k));
          if (k >= 1) c.grow = 0;
        }
        if (b.position.y < -4) {
          this.removeChip(c);
          for (const p of this.piles.values()) { const i = p.chips.indexOf(c); if (i >= 0) p.chips.splice(i, 1); }
        }
      }
      this.fx = this.fx.filter(f => {
        const k = (now - f.t0) / f.dur;
        if (k < 0) return true;
        const kk = Math.min(1, k);
        if (f.kind === 'emit') {
          // テッセラクトから目標の真上へ
          const e = ease(kk);
          f.mesh.position.lerpVectors(f.from, f.to, e);
          f.mesh.position.y += Math.sin(Math.PI * kk) * 0.5;
          f.mesh.scale.setScalar(0.15 + 0.85 * e);
          f.mesh.rotation.x += dt * 6;
          f.mesh.rotation.y += dt * 9;
          if (k >= 1) { f.done(); return false; }
          return true;
        }
        // テッセラクトへ吸い込まれる
        const e = easeIn(kk);
        f.mesh.position.lerpVectors(f.from, this.tLines.position, e);
        f.mesh.position.y += Math.sin(Math.PI * kk) * 0.6;
        f.mesh.scale.setScalar(1 - 0.9 * e);
        f.mesh.rotation.y += dt * 8;
        if (k >= 1) { this.s3.remove(f.mesh); return false; }
        return true;
      });
      this.updateTesseract(dt);
    } else {
      const t = now / 1000;
      for (const g of this.showcase) {
        const b = g.userData.base;
        if (!b) continue;
        const ph = g.userData.phase;
        g.position.set(b.x, -(b.y + Math.sin(t * 0.9 + ph) * 6), 0);
        g.rotation.set(t * 0.35 + ph, t * 0.5 * (g.userData.i % 2 ? 1 : -1) + ph, 0.3);
      }
    }
    this.composer.render();
  }
}
