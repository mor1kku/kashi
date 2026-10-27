/* ============================================================
   JIZURA — 写真PV: IndexedDB保存・ビットマップLRUキャッシュ・
   スケジューリング（行/カット/拍/均等）・背景としての描画
   ============================================================ */
(() => {
'use strict';

const DB_NAME = 'jizura', STORE = 'photos';
const LONG_SIDE = 3840, THUMB_SIDE = 240, MAX_BMP = 6;

/* ---------------- IndexedDB（ダメならメモリに退避） ---------------- */
let dbPromise = null, fallbackNotified = false;
// Only newly added records whose write failed live here. A failed write must
// not hide photos that were successfully persisted earlier in this session.
const memStore = new Map();
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-idb')); return; }
    let req, failed = false;
    const fail = error => { failed = true; reject(error); };
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { fail(e); return; }
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => {
      const db = req.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => fail(req.error || new Error('idb-open-failed'));
    req.onblocked = () => fail(new Error('idb-open-blocked'));
  }).catch(error => { dbPromise = null; throw error; }); // retry transient open failures
  return dbPromise;
}
function markMemFallback() {
  if (fallbackNotified) return;
  fallbackNotified = true;
  J.photoNotify && J.photoNotify('追加した写真の一部をブラウザに保存できなかったため、このタブの間だけ保持します。以前に保存した写真は引き続き使えます。');
}
async function recordTransaction(mode, operation, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let request, result;
    const fail = () => reject(tx.error || (request && request.error) || new Error('idb-transaction-failed'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = fail;
    tx.onabort = fail;
    request = tx.objectStore(STORE)[operation](value);
    request.onsuccess = () => { result = request.result; };
    request.onerror = fail;
    // A successful request is not a successful transaction: an abort can occur
    // afterwards. In particular, don't treat an aborted read as a missing ID.
  });
}
async function putRecord(rec) {
  try {
    await recordTransaction('readwrite', 'put', rec);
    memStore.delete(rec.id);
  } catch (e) { markMemFallback(); memStore.set(rec.id, rec); }
}
async function getRecord(id) {
  if (memStore.has(id)) return memStore.get(id);
  const record = await recordTransaction('readonly', 'get', id);
  return record || null; // null means a completed read confirmed absence
}
async function deleteRecord(id) {
  // IDs are generated for each import. Memory records never committed to disk,
  // so they can be removed even while the database is unavailable.
  if (memStore.has(id)) { memStore.delete(id); return; }
  await recordTransaction('readwrite', 'delete', id);
}

/* ---------------- 取り込み：縮小 → JPEG化 → 保存 ---------------- */
async function toJpeg(bmp, w, h, q) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const cv = new OffscreenCanvas(w, h), cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0, w, h);
    return cv.convertToBlob({ type: 'image/jpeg', quality: q });
  }
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d'); cx.drawImage(bmp, 0, 0, w, h);
  return new Promise(res => cv.toBlob(res, 'image/jpeg', q));
}
function fitSize(w, h, long) { const s = Math.min(1, long / Math.max(w, h)); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; }
async function processOne(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { throw new Error('decode-failed'); }
  try {
    const [ow, oh] = fitSize(bmp.width, bmp.height, LONG_SIDE);
    const [tw, th] = fitSize(bmp.width, bmp.height, THUMB_SIDE);
    const blob = await toJpeg(bmp, ow, oh, 0.88);
    const thumb = await toJpeg(bmp, tw, th, 0.82);
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await putRecord({ id, blob, thumb, w: ow, h: oh });
    return id;
  } finally { try { bmp.close(); } catch (e) {} }
}

/* ---------------- ビットマップLRUキャッシュ（最大6枚まで常駐） ---------------- */
const bmpCache = new Map(), bmpOrder = [], pending = new Map();
function touchLRU(id) {
  const i = bmpOrder.indexOf(id); if (i >= 0) bmpOrder.splice(i, 1);
  bmpOrder.push(id);
  while (bmpOrder.length > MAX_BMP) {
    const old = bmpOrder.shift(), b = bmpCache.get(old);
    if (b) { try { b.close(); } catch (e) {} bmpCache.delete(old); }
  }
}
function decodeBitmap(id) {
  if (!id) return Promise.resolve(null);
  if (bmpCache.has(id)) { touchLRU(id); return Promise.resolve(bmpCache.get(id)); }
  if (pending.has(id)) return pending.get(id);
  const p = (async () => {
    try {
      const rec = await getRecord(id);
      if (!rec || !rec.blob) return null;
      const bmp = await createImageBitmap(rec.blob);
      bmpCache.set(id, bmp); touchLRU(id);
      J.photoOnLoad && J.photoOnLoad(id);   // 一時停止中のプレビューも読み込み完了で描き直す
      return bmp;
    } catch (e) { return null; }
    finally { pending.delete(id); }
  })();
  pending.set(id, p);
  return p;
}
function evictBitmap(id) {
  const b = bmpCache.get(id); if (b) { try { b.close(); } catch (e) {} bmpCache.delete(id); }
  const i = bmpOrder.indexOf(id); if (i >= 0) bmpOrder.splice(i, 1);
}

/* ---------------- サムネイルのobject URLキャッシュ（UI用） ---------------- */
const thumbURLs = new Map();
async function thumbURL(id) {
  if (thumbURLs.has(id)) return thumbURLs.get(id);
  let rec;
  try { rec = await getRecord(id); } catch (e) { return null; }
  if (!rec || !rec.thumb) return null;
  const url = URL.createObjectURL(rec.thumb);
  thumbURLs.set(id, url);
  return url;
}
function revokeThumb(id) { const u = thumbURLs.get(id); if (u) { URL.revokeObjectURL(u); thumbURLs.delete(id); } }

/* ---------------- スケジューリング（純粋関数・plan単位でキャッシュ） ---------------- */
// 拍の並び：plan.beats があればそれを使い、無ければ設定のBPM、それも無ければ120BPM相当（0.5秒間隔）にする
function beatBoundaries(plan) {
  if (plan.beats && plan.beats.length) return plan.beats;
  const bpm = (plan.photo && plan.photo.bpm) || 0;
  const step = bpm > 0 ? 60 / bpm : 0.5;
  const out = []; for (let t = 0; t < plan.duration; t += step) out.push(t);
  return out;
}
// plan と project.photo から、時間軸上の写真の切り替わり区間 [{start, end, idx}] を組み立てる
function computeSegments(plan) {
  const ph = plan.photo || {};
  const ids = ph.ids || [];
  const n = ids.length;
  const dur = Math.max(0.001, plan.duration || 0);
  if (!n) return [];
  const unit = ph.unit || 'line';
  let segs = [];
  if (unit === 'even') {
    for (let i = 0; i < n; i++) segs.push({ start: dur * i / n, end: dur * (i + 1) / n, idx: i });
  } else if (unit === 'cut') {
    const cuts = (plan.cuts || []).slice().sort((a, b) => a.start - b.start);
    segs = cuts.map((c, i) => ({ start: c.start, end: c.end, idx: i % n }));
  } else if (unit === 'beat') {
    const beatsPer = Math.max(1, ph.beatsPer || 4);
    const beats = beatBoundaries(plan);
    const bounds = [0];
    for (let i = beatsPer; i < beats.length; i += beatsPer) bounds.push(beats[i]);
    if (bounds[bounds.length - 1] < dur - 1e-6) bounds.push(dur);
    for (let i = 0; i < bounds.length - 1; i++) if (bounds[i + 1] > bounds[i] + 1e-6) segs.push({ start: bounds[i], end: bounds[i + 1], idx: segs.length % n });
  } else { // 'line'（既定）：行の開始で区切る。頭の間や行間の余白は前後の区間に含める
    const lines = (plan.lines || []).slice().sort((a, b) => a.start - b.start);
    if (!lines.length) segs = [{ start: 0, end: dur, idx: 0 }];
    else segs = lines.map((ln, i) => ({ start: i === 0 ? 0 : ln.start, end: i === lines.length - 1 ? dur : lines[i + 1].start, idx: i % n }));
  }
  if (!segs.length) segs = [{ start: 0, end: dur, idx: 0 }];
  return segs;
}
const segCache = new WeakMap();
function getSegments(plan) {
  let s = segCache.get(plan);
  if (!s) { s = computeSegments(plan); segCache.set(plan, s); }
  return s;
}
function segAt(segs, t) {
  let lo = 0, hi = segs.length - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].start <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/* ---------------- Ken Burns（決定論的なゆっくりズーム＋パン） ---------------- */
function kbParams(segIdx, segT, segDur, on) {
  if (!on) return { zoom: 1, panX: 0, panY: 0 };
  const p = segDur > 0 ? J.clamp(segT / segDur) : 0;
  const zoom = J.lerp(1.0, 1.08, p);
  const ang = J.r(segIdx, 5011) * J.TAU; // 区間indexのハッシュから向きを決める
  return { zoom, panX: Math.cos(ang) * p, panY: Math.sin(ang) * p };
}
function drawCover(ctx, bmp, W, H, alpha, zoom, panX, panY) {
  if (!bmp || alpha <= 0) return;
  const bw = bmp.width, bh = bmp.height;
  const scale = Math.max(W / bw, H / bh) * zoom;
  const dw = bw * scale, dh = bh * scale;
  const maxOffX = Math.max(0, (dw - W) / 2), maxOffY = Math.max(0, (dh - H) / 2);
  const dx = W / 2 - dw / 2 + panX * maxOffX, dy = H / 2 - dh / 2 + panY * maxOffY;
  ctx.globalAlpha = alpha; ctx.drawImage(bmp, dx, dy, dw, dh); ctx.globalAlpha = 1;
}

/* ---------------- 公開API ---------------- */
J.photo = {
  // 複数ファイルを順番に処理してIndexedDBへ保存し、追加できたidの配列を返す（進捗はonProgress(p,msg)）
  addFiles: async (files, onProgress) => {
    const list = Array.from(files || []).filter(f => f && (/^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || '')));
    const added = []; let skipped = 0;
    for (let i = 0; i < list.length; i++) {
      onProgress && onProgress(i / Math.max(1, list.length), `写真を処理中 ${i + 1}/${list.length}`);
      try { added.push(await processOne(list[i])); } catch (e) { skipped++; }
      await new Promise(r => setTimeout(r, 0)); // 1枚ずつ処理してUIをブロックしない
    }
    onProgress && onProgress(1, '完了');
    if (skipped) J.photoNotify && J.photoNotify(`読み込めなかった写真: ${skipped}枚（HEIC等、非対応の形式の可能性があります）`);
    return added;
  },
  remove: async (id) => { await deleteRecord(id); evictBitmap(id); revokeThumb(id); },
  removeAll: async (ids) => { for (const id of ids || []) await J.photo.remove(id); },
  thumbURL,
  // 保存済みプロジェクトのidのうち、IndexedDBに実体が無いものを取り除く
  filterExisting: async (ids) => {
    const out = []; let missing = 0, unavailable = 0;
    for (const id of ids || []) {
      try { if (await getRecord(id)) out.push(id); else missing++; }
      catch (e) { out.push(id); unavailable++; } // unknown is not missing
    }
    return { ids: out, missing, unavailable };
  },
  // 時刻tの前後で必要なビットマップの読み込みを（待たずに）開始する
  prefetch: (plan, t) => {
    const ph = plan.photo; if (!ph || !ph.on || !ph.ids || !ph.ids.length) return;
    const segs = getSegments(plan); if (!segs.length) return;
    const i = segAt(segs, t), ids = ph.ids;
    decodeBitmap(ids[segs[i].idx]);
    if (segs[i + 1]) decodeBitmap(ids[segs[i + 1].idx]);
  },
  // 書き出し用：時刻tの描画に要るビットマップの準備ができるまで待つ
  ready: async (plan, t) => {
    const ph = plan.photo; if (!ph || !ph.on || !ph.ids || !ph.ids.length) return;
    const segs = getSegments(plan); if (!segs.length) return;
    const i = segAt(segs, t), ids = ph.ids, cur = segs[i];
    const fade = Math.max(0, ph.fade != null ? ph.fade : 0.35);
    const tasks = [decodeBitmap(ids[cur.idx])];
    if (i > 0 && t - cur.start < fade) tasks.push(decodeBitmap(ids[segs[i - 1].idx]));
    if (segs[i + 1] && cur.end - t < fade) tasks.push(decodeBitmap(ids[segs[i + 1].idx]));
    await Promise.all(tasks);
  },
  // レンダラーから呼ぶ：現在の写真（＋切替中はクロスフェード）とKen Burns、暗さのオーバーレイを描く
  draw: (ctx, plan, t, W, H, sc) => {
    const ph = plan.photo; if (!ph || !ph.on) return false;
    const ids = ph.ids || []; if (!ids.length) return false;
    const segs = getSegments(plan); if (!segs.length) return false;
    J.photo.prefetch(plan, t);
    const i = segAt(segs, t), cur = segs[i];
    const kbOn = ph.kenBurns !== false;
    const fade = Math.max(0, ph.fade != null ? ph.fade : 0.35);
    const curDur = Math.max(0.001, cur.end - cur.start), curT = J.clamp(t - cur.start, 0, curDur);
    let curBmp = bmpCache.get(ids[cur.idx]) || null;
    if (curBmp) touchLRU(ids[cur.idx]);
    if (i > 0 && fade > 0 && curT < fade) {
      const prev = segs[i - 1], prevDur = Math.max(0.001, prev.end - prev.start);
      const prevBmp = bmpCache.get(ids[prev.idx]) || null;
      if (prevBmp) touchLRU(ids[prev.idx]);
      if (prevBmp) { const kb = kbParams(prev.idx, prevDur, prevDur, kbOn); drawCover(ctx, prevBmp, W, H, 1, kb.zoom, kb.panX, kb.panY); }
      if (curBmp) { const kb = kbParams(cur.idx, curT, curDur, kbOn); drawCover(ctx, curBmp, W, H, J.clamp(curT / fade), kb.zoom, kb.panX, kb.panY); }
    } else if (curBmp) {
      const kb = kbParams(cur.idx, curT, curDur, kbOn); drawCover(ctx, curBmp, W, H, 1, kb.zoom, kb.panX, kb.panY);
    } else if (i > 0) {
      // まだ現在の写真が読み込めていない場合は、直前の写真をそのまま出す（何も描かないよりまし・描画は止めない）
      const prev = segs[i - 1], prevBmp = bmpCache.get(ids[prev.idx]);
      if (prevBmp) { const prevDur = Math.max(0.001, prev.end - prev.start); const kb = kbParams(prev.idx, prevDur, prevDur, kbOn); drawCover(ctx, prevBmp, W, H, 1, kb.zoom, kb.panX, kb.panY); }
    }
    const dim = J.clamp(ph.dim != null ? ph.dim : 0.35, 0, 0.9);
    if (dim > 0 && sc && sc.bg) { ctx.globalAlpha = dim; ctx.fillStyle = sc.bg; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
    return true;
  },
  // テスト・デバッグ用：キャッシュを介さない純粋な区間計算
  _computeSegments: computeSegments,
};
// UIからトースト表示を差し込むためのフック（12_ui.js側で J.photoNotify = toast; のように設定する）
J.photoNotify = null;
// ビットマップの読み込み完了を知らせるフック（12_ui.js側で再描画要求をつなぐ）
J.photoOnLoad = null;
})();

