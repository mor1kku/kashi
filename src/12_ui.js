/* ============================================================
   JIZURA — editor UI
   ============================================================ */
(() => {
'use strict';
if (!document.getElementById('app')) return;          // engine-only pages (tests)
const $ = id => document.getElementById(id);
const LS_KEY = 'jizura.project.v1';
const RECOVERY_KEY = LS_KEY + '.recovery';
const HUD_CHARS = '0123456789:./-_()【】・No.LYRICRECUNTITLEDXYlinebpminterlude—─／ ';
const ICON = {
  dice: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/><circle cx="10.5" cy="10.5" r="1" fill="currentColor"/><circle cx="10.5" cy="5.5" r="1" fill="currentColor"/><circle cx="5.5" cy="10.5" r="1" fill="currentColor"/></svg>',
  lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>',
};

const S = { project: null, plan: null, audio: null, renderer: new J.Renderer(), playing: false, t: 0, t0: 0, loop: true, need: true, exporting: null, tap: null, slow: false, lineEls: [], curLine: -2 };

/* WebAudio player (works inside sandboxed pages where blob media may be blocked) */
const AP = {
  ctx: null, src: null, startAt: 0,
  play(buffer, offset) {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.stop();
    const s = this.ctx.createBufferSource(); s.buffer = buffer; s.connect(this.ctx.destination);
    const off = Math.max(0, Math.min(offset, buffer.duration - 0.01));
    s.start(0, off); this.src = s; this.startAt = this.ctx.currentTime - off;
  },
  stop() { if (this.src) { try { this.src.stop(); } catch (e) {} try { this.src.disconnect(); } catch (e) {} this.src = null; } },
  time() { return this.ctx ? this.ctx.currentTime - this.startAt : 0; },
};

/* ---------------- project persistence ---------------- */
function mergeProject(p) {
  const d = J.defaultProject();
  const o = Object.assign(d, p || {});
  o.fx = Object.assign(J.defaultProject().fx, (p && p.fx) || {});
  o.timing = Object.assign(J.defaultProject().timing, (p && p.timing) || {});
  const en = J.defaultProject().enabled;
  for (const g of Object.keys(en)) en[g] = Object.assign(en[g], ((p && p.enabled) || {})[g] || {});
  o.enabled = en;
  o.overrides = (p && p.overrides) || {};
  o.colors = Object.assign({ enabled: false }, (p && p.colors) || {});
  o.fonts = (p && p.fonts) || {};
  o.userFonts = (p && p.userFonts) || [];
  for (const uf of o.userFonts) if (!J.FONTS[uf.key]) J.addUserFont(uf.key, uf.label, uf.family, uf.weight || 400);
  o.photo = Object.assign(J.defaultProject().photo, (p && p.photo) || {});
  return o;
}
// 保存されたプロジェクトが参照している写真idのうち、IndexedDBに実体が無いものを取り除く
async function reconcilePhotos() {
  const ids = S.project.photo.ids; if (!ids || !ids.length) return;
  const { ids: kept, missing } = await J.photo.filterExisting(ids);
  if (missing) { S.project.photo.ids = kept; phSyncUI(); replan(); toast(`写真 ${missing}枚が見つかりませんでした`); }
}
function loadLocal() {
  for (const key of [LS_KEY, RECOVERY_KEY]) {
    try {
      const raw = localStorage.getItem(key); if (!raw) continue;
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || typeof p.lyrics !== 'string') continue;
      return mergeProject(p);
    } catch (e) {}
  }
  return mergeProject(null);
}
let saveTimer = 0;
function saveNow(recovery = false) {
  clearTimeout(saveTimer);
  const json = JSON.stringify(S.project);
  try {
    localStorage.setItem(LS_KEY, json);
    if (recovery) localStorage.setItem(RECOVERY_KEY, json);
    return true;
  } catch (e) {
    toast('ブラウザに編集を保存できません。「編集データを保存」でバックアップしてください。');
    return false;
  }
}
function autosave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow(), 700); }
let recoveryDownload = null;
function prepareRecovery() {
  saveNow(true);
  if (recoveryDownload) recoveryDownload.dispose();
  recoveryDownload = J.prepareDownload(baseName() + '.jizura.json', new Blob([JSON.stringify(S.project, null, 1)], { type: 'application/json' }));
  $('recoveryLink').href = recoveryDownload.url;
  $('recoveryLink').download = recoveryDownload.filename;
  $('exportRecovery').hidden = false;
}

/* ---------------- planning ---------------- */
function audioLike() {
  const T = S.project.timing;
  if (S.audio) {
    const a = Object.assign({}, S.audio);
    if (T.bpm > 0) a.beats = J.beatGrid(T.bpm, T.beatOffset || 0, S.audio.duration);
    return a;
  }
  if (T.bpm > 0) return { beats: J.beatGrid(T.bpm, T.beatOffset || 0, 600) };
  return null;
}
function replan() {
  S.plan = J.plan(S.project, audioLike());
  if (S.t > S.plan.duration) S.t = 0;
  renderLines(); sizeViewport(); drawTimeline(); updateTimeUI();
  S.need = true; autosave(); ensureFonts(); drawSwatch(); showNow();
  clearTimeout(warmTimer); warmTimer = setTimeout(warm, 450);
}
/* pre-decompose glyphs used by piece animations while the editor is idle, so playback does not hitch */
let warmTimer = 0, warmJob = 0;
function warm() {
  const job = ++warmJob;
  const cuts = S.plan.cuts.filter(c => c.enter === 'assemble' || ['explode', 'fall', 'drift'].includes(c.exit));
  const src = $('view');
  const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
  const ctx = cv.getContext('2d');
  let i = 0;
  const idle = window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 400 }) : (f) => setTimeout(() => f(null), 40);
  const step = (deadline) => {
    if (job !== warmJob || S.exporting) return;
    do {
      const c = cuts[i++]; if (!c) break;
      const ts = [];
      if (c.enter === 'assemble') ts.push(c.start + Math.min(c.inDur * 0.3, c.dur * 0.2));
      if (c.outDur > 0) ts.push(c.end - c.outDur * 0.5);
      for (const t of ts) { try { S.renderer.frame(ctx, S.plan, t, { scale: cv.width / S.plan.W, fast: true, noHud: true, noGhost: true }); } catch (e) {} }
    } while (i < cuts.length && deadline && deadline.timeRemaining() > 10);
    if (i < cuts.length) idle(step);
  };
  idle(step);
}
let replanTimer = 0;
const replanSoon = (ms = 220) => { clearTimeout(replanTimer); replanTimer = setTimeout(replan, ms); };
let fontKey = '';
async function ensureFonts() {
  const txt = S.project.lyrics + (S.project.title || '') + (S.project.artist || '') + HUD_CHARS;
  const key = txt + '|' + Object.keys(J.FONTS).length;
  if (key === fontKey) return;
  fontKey = key;
  showMsg('フォントを読み込み中…');
  try { await J.ensureFonts(txt, null); } catch (e) {}
  showMsg(null); S.need = true; drawStyleGrid();
}
function showMsg(m) { const el = $('viewMsg'); if (!m) { el.hidden = true; return; } el.textContent = m; el.hidden = false; }

/* ---------------- viewport & drawing ---------------- */
function sizeViewport() {
  const vp = $('viewport'), c = $('view');
  const ar = S.plan.W / S.plan.H;
  let cssW = vp.clientWidth || 800, cssH = cssW / ar;
  const maxH = Math.max(220, window.innerHeight * 0.68);
  if (cssH > maxH) { cssH = maxH; cssW = cssH * ar; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(Math.min(S.plan.W, cssW * dpr)), ph = Math.round(pw / ar);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
  S.need = true;
}
function draw() {
  const c = $('view'), ctx = c.getContext('2d');
  const t0 = performance.now();
  S.renderer.frame(ctx, S.plan, S.t, { scale: c.width / S.plan.W, fast: S.playing && S.slow });
  const dt = performance.now() - t0;
  S.slow = S.playing ? (dt > 30 ? true : dt < 14 ? false : S.slow) : false;
  updateTimeUI(); drawTimeline(); updateCutInfo();
}
function tick(now) {
  requestAnimationFrame(tick);
  if (S.exporting) return;
  if (S.playing) {
    // rAF timestamps can precede the moment play()/seek() stamped t0 → clamp so t never goes negative
    let t = Math.max(0, S.audio ? AP.time() : (now - S.t0) / 1000);
    if (t >= S.plan.duration - 1e-3) {
      if (S.loop && !S.tap) { seek(0); t = 0; }
      else { pause(); t = S.plan.duration - 1e-3; if (S.tap) stopTap(); }
    }
    S.t = t; S.need = true;
  }
  if (S.need) { S.need = false; draw(); }
}
function updateTimeUI() {
  $('timeNow').textContent = J.fmtTime(S.t);
  $('timeDur').textContent = J.fmtTime(S.plan.duration);
  if (!S.scrubbing) $('scrub').value = String(Math.round(S.t / Math.max(0.001, S.plan.duration) * 10000));
}
function play() {
  if (S.audio) AP.play(S.audio.buffer, S.t);
  else S.t0 = performance.now() - S.t * 1000;
  S.playing = true; $('btnPlay').textContent = '❚❚'; $('btnPlay').setAttribute('aria-label', '一時停止');
}
function pause() {
  S.playing = false; AP.stop();
  $('btnPlay').textContent = '▶'; $('btnPlay').setAttribute('aria-label', '再生'); S.need = true;
}
function seek(t) {
  S.t = J.clamp(t, 0, Math.max(0, S.plan.duration - 1e-3));
  if (S.audio) { if (S.playing) AP.play(S.audio.buffer, S.t); }
  else S.t0 = performance.now() - S.t * 1000;
  S.need = true;
}

/* ---------------- timeline ---------------- */
const layoutHue = k => (J.LAYOUT_ORDER.indexOf(k) * 37 + 30) % 360;
function drawTimeline() {
  const c = $('timeline'), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, Math.round(c.clientWidth * dpr)), h = Math.max(10, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d'), D = Math.max(0.001, S.plan.duration), X = t => t / D * w;
  x.fillStyle = '#131316'; x.fillRect(0, 0, w, h);
  if (S.audio && S.audio.peaks) {
    const pk = S.audio.peaks, n = pk.length, sd = S.audio.duration;
    x.fillStyle = '#2b2b33';
    for (let i = 0; i < w; i += 2) { const t = i / w * D; if (t > sd) break; const v = pk[Math.min(n - 1, Math.floor(t / sd * n))]; const hh = v * h * 0.8; x.fillRect(i, h * 0.6 - hh / 2, 1.5, hh); }
  }
  const beats = S.plan.beats || [];
  x.fillStyle = '#3a3a44';
  for (const b of beats) { if (b > D) break; x.fillRect(Math.round(X(b)), h - 6 * dpr, 1, 6 * dpr); }
  const top = h * 0.3, bot = h - 8 * dpr;
  for (const cut of S.plan.cuts) {
    const x0 = X(cut.start), x1 = X(cut.end);
    const hue = layoutHue(cut.layout);
    x.fillStyle = `hsla(${hue},70%,58%,0.28)`; x.fillRect(x0, top, Math.max(1, x1 - x0 - 1), bot - top);
    x.fillStyle = `hsla(${hue},80%,62%,0.95)`; x.fillRect(x0, top, Math.max(1, 2 * dpr), bot - top);
    if (x1 - x0 > 34 * dpr) {
      x.fillStyle = 'rgba(236,231,225,0.85)'; x.font = `${10 * dpr}px ${getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace'}`;
      x.save(); x.beginPath(); x.rect(x0, top, x1 - x0 - 3, bot - top); x.clip();
      x.fillText((J.LAYOUTS[cut.layout] || {}).name || cut.layout, x0 + 5 * dpr, top + 13 * dpr); x.restore();
    }
  }
  x.font = `${10 * dpr}px monospace`;
  for (const ln of S.plan.lines) {
    const lx = X(ln.start);
    x.fillStyle = '#5d5a63'; x.fillRect(lx, 0, 1, top);
    x.fillStyle = '#8e8a94'; x.fillText(String(ln.index + 1).padStart(2, '0'), lx + 3 * dpr, 12 * dpr);
  }
  const px = X(S.t);
  x.fillStyle = '#f5a50c'; x.fillRect(Math.round(px) - dpr, 0, 2 * dpr, h);
}
function timelineSeek(ev) {
  const r = $('timeline').getBoundingClientRect();
  seek((ev.clientX - r.left) / r.width * S.plan.duration);
}

/* ---------------- cut info ---------------- */
let lastCutIdx = -2;
function updateCutInfo() {
  const cut = J.cutAt(S.plan, S.t);
  const idx = cut ? cut.index : -1;
  const li = cut ? cut.line : -1;
  if (li !== S.curLine) { S.lineEls.forEach((el, i) => el.classList.toggle('cur', i === li)); S.curLine = li; }
  if (idx === lastCutIdx) return;
  lastCutIdx = idx;
  const el = $('cutInfo');
  if (!cut) { el.innerHTML = '<span class="hint">この位置にカットはありません</span>'; return; }
  const chip = (cls, k, v) => `<span class="chip ${cls}"><b>${k}</b>${v}</span>`;
  const n = (tbl, k) => (tbl[k] ? tbl[k].name : k);
  el.innerHTML = [
    `<span class="chip mono">#${String(cut.index + 1).padStart(2, '0')}</span>`,
    chip('l', 'レイアウト', n(J.LAYOUTS, cut.layout)), chip('e', '登場', n(J.ENTER, cut.enter)), chip('h', '保持', n(J.HOLD, cut.hold)), chip('x', '退場', n(J.EXIT, cut.exit)),
    cut.decor && cut.decor.length ? chip('', '装飾', cut.decor.map(d => n(J.DECOR, d.id)).join('・')) : '',
    cut.treat && cut.treat !== 'none' ? chip('t', '加工', n(J.TREAT, cut.treat)) : '',
    cut.bg && cut.bg !== 'none' ? chip('b', '背景', n(J.BG, cut.bg)) : '',
    cut.cam && cut.cam !== 'push' ? chip('c', 'カメラ', n(J.CAMERA, cut.cam)) : '',
  ].join('');
}

/* ---------------- line list ---------------- */
function renderLines() {
  const ol = $('lineList'); ol.innerHTML = ''; S.lineEls = []; S.curLine = -2;
  const ov = S.project.overrides;
  const layoutOpts = '<option value="">自動</option>' + J.LAYOUT_ORDER.map(k => `<option value="${k}">${J.LAYOUTS[k].name}</option>`).join('');
  S.plan.lines.forEach((ln, i) => {
    const o = ov[i] || {};
    const li = document.createElement('li'); li.className = 'ln';
    const manual = S.project.timing.lineTimes && S.project.timing.lineTimes[i] != null;
    const automatic = S.project.timing.autoTimes && S.project.timing.autoTimes[i] != null;
    li.innerHTML = `<span class="no">${String(i + 1).padStart(2, '0')}</span>
      <input class="time mono" type="number" step="0.01" min="0" value="${ln.start.toFixed(2)}" title="開始（秒）${manual ? '・手修整' : automatic ? '・仮配置' : '・自動'}" aria-label="${i + 1}行目の開始秒" style="${manual ? 'border-color:var(--cyan)' : ''}">
      <span class="txt" title="${escapeHtml(ln.text)}">${escapeHtml(ln.text)}</span>
      <div class="timing-tools">
        <button class="ghost small earlier" aria-label="${i + 1}行目を0.1秒早める">−0.1秒</button>
        <button class="ghost small later" aria-label="${i + 1}行目を0.1秒遅らせる">＋0.1秒</button>
        <button class="ghost small set-now" title="この行の開始を現在の再生位置に合わせる">今の位置</button>
      </div>
      <div class="meta"><span class="cuts"></span>
      <span class="tools">
        <select aria-label="レイアウト指定">${layoutOpts}</select>
        <button class="icon ghost dice" title="この行を再抽選">${ICON.dice}</button>
        <button class="icon ghost lock" title="この行の構成をロック" aria-pressed="${o.lock ? 'true' : 'false'}">${ICON.lock}</button>
      </span></div>`;
    li.querySelector('select').value = o.layout || '';
    li.querySelector('.time').addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      setLineTime(i, v);
    });
    li.querySelector('.earlier').addEventListener('click', () => setLineTime(i, ln.start - 0.1));
    li.querySelector('.later').addEventListener('click', () => setLineTime(i, ln.start + 0.1));
    li.querySelector('.set-now').addEventListener('click', () => setLineTime(i, S.audio && S.playing ? AP.time() : S.t));
    li.querySelector('.txt').addEventListener('click', () => seek(ln.start + 0.001));
    li.querySelector('select').addEventListener('change', e => { setOv(i, { layout: e.target.value || undefined }); replan(); });
    li.querySelector('.dice').addEventListener('click', () => { const cur = ov[i] || {}; setOv(i, { seed: (cur.seed | 0) + 1, lock: false }); replan(); seek(ln.start + 0.001); });
    li.querySelector('.lock').addEventListener('click', () => {
      const cur = ov[i] || {};
      if (cur.lock) setOv(i, { lock: false, lockedSeed: undefined });
      else setOv(i, { lock: true, lockedSeed: ln.seed });
      replan();
    });
    const cutsEl = li.querySelector('.cuts');
    S.plan.cuts.filter(c => c.line === i && J.LAYOUTS[c.layout] && !J.LAYOUTS[c.layout].special).forEach(c => {
      const sp = document.createElement('span'); sp.textContent = J.LAYOUTS[c.layout].name; sp.title = `${c.text}｜${J.ENTER[c.enter].name} → ${J.EXIT[c.exit].name}`;
      sp.style.borderColor = `hsla(${layoutHue(c.layout)},70%,58%,0.7)`;
      sp.addEventListener('click', () => seek(c.start + Math.min(c.dur * 0.5, c.inDur + 0.05)));
      cutsEl.appendChild(sp);
    });
    ol.appendChild(li); S.lineEls.push(li);
  });
  $('linesInfo').textContent = `${S.plan.lines.length}行 / ${S.plan.cuts.length}カット`;
}
function setOv(i, patch) {
  const cur = Object.assign({}, S.project.overrides[i] || {}, patch);
  for (const k of Object.keys(cur)) if (cur[k] === undefined || cur[k] === false || cur[k] === '') delete cur[k];
  if (Object.keys(cur).length) S.project.overrides[i] = cur; else delete S.project.overrides[i];
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- style tab ---------------- */
function drawStyleGrid() {
  const g = $('styleGrid');
  if (!g.children.length) {
    J.STYLE_ORDER.forEach(k => {
      const b = document.createElement('button'); b.className = 'stile'; b.dataset.k = k;
      b.title = J.STYLES[k].desc;
      b.innerHTML = `<canvas width="192" height="108"></canvas><span>${J.STYLES[k].name}</span>`;
      b.addEventListener('click', () => { remember(); S.project.style = k; S.project.colors.enabled = false; syncUI(); replan(); commit(); });
      g.appendChild(b);
    });
  }
  [...g.children].forEach(b => {
    const k = b.dataset.k, st = J.STYLES[k], sc = st.schemes[0], cv = b.querySelector('canvas'), x = cv.getContext('2d');
    b.setAttribute('aria-pressed', S.project.style === k ? 'true' : 'false');
    x.fillStyle = sc.bg; x.fillRect(0, 0, 192, 108);
    st.schemes.slice(1, 4).forEach((s2, i) => { x.fillStyle = s2.bg; x.fillRect(192 - 14 * (i + 1), 0, 14, 10); });
    const f = st.fonts.display[0];
    x.font = J.fontCSS(f, 46); x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = sc.ghostB; x.fillText('字面', 96 - 3, 54 - 1);
    x.fillStyle = sc.ghostA; x.fillText('字面', 96 + 3, 54 + 2);
    x.fillStyle = sc.fg; x.fillText('字面', 96, 54);
    x.fillStyle = sc.accent; x.fillRect(12, 90, 30, 4);
    x.font = J.fontCSS('mono', 9); x.textAlign = 'left'; x.fillStyle = sc.sub; x.fillText(k.toUpperCase(), 48, 93);
  });
}
function fontSelectOptions(sel) {
  return '<option value="">スタイルの既定</option>' + Object.entries(J.FONTS).map(([k, f]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('');
}
function renderFontRoles() {
  const box = $('fontRoles'); box.innerHTML = '';
  [['display', '見出し'], ['serif', '明朝枠'], ['body', '小さな文字']].forEach(([role, label]) => {
    const row = document.createElement('div'); row.className = 'font-row';
    row.innerHTML = `<span class="muted">${label}</span><select aria-label="${label}のフォント">${fontSelectOptions(S.project.fonts[role])}</select>`;
    row.querySelector('select').addEventListener('change', e => { if (e.target.value) S.project.fonts[role] = e.target.value; else delete S.project.fonts[role]; fontKey = ''; replan(); });
    box.appendChild(row);
  });
}
const BASE_KEYS = [['bg', '背景'], ['fg', '文字'], ['sub', '補助']];
const ACCENT_KEYS = [['accent', 'アクセント'], ['ghostA', 'ズレ色A'], ['ghostB', 'ズレ色B']];
function renderColors() {
  const st = J.STYLES[S.project.style] || J.STYLES.noir, sc = st.schemes[0];
  const c = S.project.colors;
  $('colorOn').checked = !!c.enabled;
  $('accentOn').checked = !!c.accentOn;
  const fill = (rowId, keys, flag) => {
    const row = $(rowId); row.innerHTML = '';
    keys.forEach(([k, label]) => {
      const l = document.createElement('label');
      const v = (c[flag] && c[k]) || c[k] || sc[k];
      l.innerHTML = `${label}<input type="color" value="${toColorInput(v)}">`;
      l.querySelector('input').addEventListener('input', e => {
        c[k] = e.target.value.toUpperCase();
        if (!c[flag]) { c[flag] = true; $(flag === 'enabled' ? 'colorOn' : 'accentOn').checked = true; }
        replanSoon(60); drawSwatch();
      });
      row.appendChild(l);
    });
  };
  fill('colorRow', BASE_KEYS, 'enabled');
  fill('colorRowAccent', ACCENT_KEYS, 'accentOn');
  drawSwatch();
}
const toColorInput = v => { const h = String(v || '#000000'); return /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : J.toHex(...J.hex(h)).toLowerCase(); };
function swatchHTML(cols) { return cols.map(c => `<i style="background:${c}" title="${c}"></i>`).join(''); }
function drawSwatch() {
  const sc = S.plan ? S.plan.style.schemes[0] : null; if (!sc) return;
  $('paletteSwatch').innerHTML = swatchHTML([sc.accent, sc.ghostA, sc.ghostB]);
}
function randomPalette() {
  remember();
  const c = S.project.colors;
  const sc0 = J.STYLES[S.project.style].schemes[0];
  const bg = c.enabled && c.bg ? c.bg : sc0.bg;
  let p, guard = 0;
  do { p = J.randomPalette(bg); } while (guard++ < 6 && p.ghostA === c.ghostA && p.ghostB === c.ghostB);
  Object.assign(c, { accent: p.accent, ghostA: p.ghostA, ghostB: p.ghostB, accentOn: true });
  renderColors(); replan(); commit();
  toast('配色：アクセント・ズレ色A/Bを変更', [p.accent, p.ghostA, p.ghostB]);
}

/* ---------------- history of looks (◀ ▶) ---------------- */
// only the "look" is tracked — lyrics, timing and output settings are never rolled back
const HKEYS = ['style', 'mood', 'seed', 'fx', 'enabled', 'fonts', 'colors', 'overrides'];
const H = { list: [], i: -1 };
const lookSnap = () => JSON.stringify(Object.fromEntries(HKEYS.map(k => [k, S.project[k] ?? null])));
function remember() {            // call before changing the look: makes sure the current look is on the stack
  const s = lookSnap();
  if (H.i >= 0 && H.list[H.i] === s) return;
  H.list = H.list.slice(0, H.i + 1); H.list.push(s); H.i = H.list.length - 1;
}
function commit() {              // call after changing the look
  const s = lookSnap();
  if (H.list[H.i] !== s) { H.list = H.list.slice(0, H.i + 1); H.list.push(s); H.i = H.list.length - 1; }
  if (H.list.length > 80) { H.list.splice(0, H.list.length - 80); H.i = H.list.length - 1; }
  updateHist();
}
function histGo(d) {
  if (S.exporting) return;
  remember();                    // hand edits made since the last step become a stop of their own
  const j = H.i + d; if (j < 0 || j >= H.list.length) return;
  H.i = j;
  Object.assign(S.project, JSON.parse(H.list[j]));
  fontKey = ''; syncUI(); replan(); updateHist();
  toast(`${j + 1} / ${H.list.length} 案目`);
  restartPreview();
}
function updateHist() {
  const canB = H.i > 0, canF = H.i < H.list.length - 1;
  ['btnPrev', 'btnPrev2'].forEach(id => { $(id).disabled = !canB; });
  ['btnNext', 'btnNext2'].forEach(id => { $(id).disabled = !canF; });
  $('histPos').textContent = H.list.length > 1 ? `${H.i + 1} / ${H.list.length}` : '';
}

/* ---------------- おまかせ ---------------- */
function restartPreview() { seek(0); if (!S.playing && S.mode === 'easy') play(); }
function omakase() {
  if (S.exporting || S.tap) return;
  remember();
  const r = J.omakase(S.project, Math.random, S.project.moodLock ? { mood: S.project.moodLock } : undefined);
  Object.assign(S.project, r);
  fontKey = ''; syncUI(); replan(); commit();
  toast(`おまかせ：${J.STYLES[r.style].name} × ${J.MOODS[r.mood].name}`, r.colors.accentOn ? [r.colors.accent, r.colors.ghostA, r.colors.ghostB] : null);
  restartPreview();
}
// change just one aspect of the current look
function rerollPart(part) {
  if (S.exporting || S.tap) return;
  remember();
  const P = S.project;
  let msg = '';
  if (part === 'style') {
    const pool = J.STYLE_ORDER.filter(k => k !== P.style);
    P.style = pool[Math.floor(Math.random() * pool.length)];
    P.colors.enabled = false;
    msg = `スタイル：${J.STYLES[P.style].name}`;
  } else if (part === 'mood') {
    const r = J.omakase(P, Math.random, P.moodLock ? { mood: P.moodLock } : undefined);
    Object.assign(P, { mood: r.mood, fx: r.fx, enabled: r.enabled });
    msg = `雰囲気：${J.MOODS[r.mood].name}`;
  } else if (part === 'cut') {
    P.seed = (Math.random() * 1e9) | 0;
    msg = '構成：レイアウトと動きを再抽選';
  }
  fontKey = ''; syncUI(); replan(); commit();
  toast(msg);
  restartPreview();
}
function showNow() {
  const el = $('easyNow'); if (!el || !S.plan || el.closest('[hidden]')) return;
  const P = S.project, sc = S.plan.style.schemes[0];
  const moodName = P.mood && J.MOODS[P.mood] ? J.MOODS[P.mood].name : 'カスタム';
  const fk = S.plan.style.fonts.display[0];
  const fontName = J.FONTS[fk] ? J.FONTS[fk].label : fk;
  const cuts = S.plan.cuts.filter(c => c.line >= 0 && c.layout !== 'interlude');
  const kinds = new Set(cuts.map(c => c.layout)).size;
  const row = (k, v) => `<div class="now-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  el.innerHTML = row('スタイル', `<b>${escapeHtml(J.STYLES[P.style].name)}</b>`)
    + row('雰囲気', escapeHtml(moodName))
    + row('配色', `<span class="swatches">${swatchHTML([sc.bg, sc.fg, sc.accent, sc.ghostA, sc.ghostB])}</span>${P.colors.accentOn ? '<span class="tagl">ランダム</span>' : ''}`)
    + row('見出し書体', escapeHtml(fontName))
    + row('構成', `${cuts.length} カット・レイアウト ${kinds} 種`)
    + row('演出', `加工 ${cuts.filter(c => c.treat && c.treat !== 'none').length}・背景 ${new Set(cuts.map(c => c.bg).filter(b => b && b !== 'none')).size}種・カメラ ${cuts.filter(c => c.cam && c.cam !== 'push').length}`);
}
let toastTimer = 0;
function toast(m, cols) {
  const el = $('toast'); if (!el) return;
  el.innerHTML = escapeHtml(m) + (cols ? `<span class="swatches">${swatchHTML(cols)}</span>` : '');
  el.hidden = false; el.classList.remove('out'); void el.offsetWidth; el.classList.add('in');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('in'); el.classList.add('out'); toastTimer = setTimeout(() => { el.hidden = true; }, 260); }, 1700);
}

/* ---------------- 写真PV ---------------- */
function phSyncUI() {
  const p = S.project.photo;
  $('phOn').checked = !!p.on; $('phOnPro').checked = !!p.on;
  $('phUnit').value = p.unit; $('phUnitPro').value = p.unit;
  $('phBeatsPer').value = String(p.beatsPer);
  $('phDim').value = p.dim; $('phDimOut').textContent = Math.round(p.dim * 100) + '%';
  $('phDimPro').value = p.dim; $('phDimProOut').textContent = Math.round(p.dim * 100) + '%';
  $('phFade').value = p.fade; $('phFadeOut').textContent = (+p.fade).toFixed(2) + 's';
  $('phKenBurns').checked = p.kenBurns !== false;
  const n = p.ids.length;
  $('phCount').textContent = n + '枚'; $('phCountPro').textContent = n + '枚';
  renderPhotoGrid();
}
function renderPhotoGrid() {
  const grid = $('phGrid'); if (!grid) return;
  grid.innerHTML = '';
  const ids = S.project.photo.ids;
  ids.forEach((id, i) => {
    const div = document.createElement('div'); div.className = 'ph-item';
    div.innerHTML = '<img alt="">'
      + '<button class="icon ghost ph-x" title="削除">×</button>'
      + '<span class="ph-mv l"><button class="ghost small" title="前へ">▲</button></span>'
      + '<span class="ph-mv r"><button class="ghost small" title="次へ">▼</button></span>';
    grid.appendChild(div);
    J.photo.thumbURL(id).then(url => { if (url) div.querySelector('img').src = url; });
    div.querySelector('.ph-x').addEventListener('click', async () => {
      await J.photo.remove(id);
      S.project.photo.ids = S.project.photo.ids.filter(x => x !== id);
      phSyncUI(); photoChanged();
    });
    div.querySelector('.ph-mv.l button').addEventListener('click', () => movePhoto(i, -1));
    div.querySelector('.ph-mv.r button').addEventListener('click', () => movePhoto(i, 1));
  });
}
function movePhoto(i, d) {
  const ids = S.project.photo.ids, j = i + d; if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]]; renderPhotoGrid(); photoChanged();
}
function photoChanged() { autosave(); replan(); } // 並び順・単位など、構成に影響する設定の変更後に呼ぶ
async function addPhotoFiles(files) {
  if (!files || !files.length) return;
  const boxes = [$('phProgress'), $('phProgressPro')].filter(Boolean);
  boxes.forEach(b => { b.hidden = false; });
  try {
    const ids = await J.photo.addFiles(files, (p, m) => {
      const pct = (p * 100).toFixed(0) + '%';
      const bar = $('phBar'), barPro = $('phBarPro'), txt = $('phProgText'), txtPro = $('phProgTextPro');
      if (bar) bar.style.width = pct; if (barPro) barPro.style.width = pct;
      if (txt) txt.textContent = m; if (txtPro) txtPro.textContent = m;
    });
    S.project.photo.ids = S.project.photo.ids.concat(ids);
    if (ids.length) S.project.photo.on = true;
    phSyncUI(); photoChanged();
    if (ids.length) toast(`写真 ${ids.length}枚を追加`);
  } finally { boxes.forEach(b => { b.hidden = true; }); }
}

/* ---------------- かんたん / 詳細 ---------------- */
function setMode(m) {
  S.mode = m === 'easy' ? 'easy' : 'pro';
  const easy = S.mode === 'easy';
  $('app').classList.toggle('is-easy', easy);
  $('easyPanel').hidden = !easy;
  $('modeEasy').setAttribute('aria-pressed', String(easy));
  $('modePro').setAttribute('aria-pressed', String(!easy));
  try { localStorage.setItem('jizura.mode', S.mode); } catch (e) {}
  if (easy) { showNow(); syncOut(); codecNote(); }
  sizeViewport(); drawTimeline();
}

/* ---------------- fx tab ---------------- */
const FX = [['motion', '動きの強さ'], ['glitch', 'グリッチ'], ['chroma', '色ズレ'], ['decor', '装飾の量'], ['density', 'カットの細かさ'], ['texture', '質感'], ['bgSwitch', '背景の切替']];
function renderFx() {
  const box = $('fxSliders'); box.innerHTML = '';
  FX.forEach(([k, label]) => {
    const row = document.createElement('div'); row.className = 'slider';
    const v = S.project.fx[k] ?? 0.5;
    row.innerHTML = `<label for="fx_${k}">${label}</label><input id="fx_${k}" type="range" min="0" max="1" step="0.01" value="${v}"><output>${Math.round(v * 100)}</output>`;
    const inp = row.querySelector('input'), out = row.querySelector('output');
    inp.addEventListener('input', () => { S.project.fx[k] = +inp.value; S.project.mood = null; out.textContent = Math.round(inp.value * 100); replanSoon(120); });
    box.appendChild(row);
  });
  $('fxFlash').checked = !!S.project.fx.flash;
  $('fxKoma').value = String(J.komaOf(S.project.fx));
  $('fxHud').value = S.project.fx.hud || 'auto';
  $('seed').value = S.project.seed;
}

/* ---------------- technique tab ---------------- */
const GROUPS = [['layout', 'レイアウト'], ['enter', '登場'], ['hold', '保持'], ['exit', '退場'], ['decor', '装飾'], ['treat', '文字の加工'], ['bg', '背景'], ['cam', 'カメラ'], ['fx', '画面効果']];
const openGroups = new Set();
function techItems(g) { return J.order(g).filter(k => J.registry(g)[k] && !J.registry(g)[k].special); }
function renderTech() {
  const box = $('techLists'); box.innerHTML = '';
  const q = ($('techFilter').value || '').trim().toLowerCase();
  let total = 0, onAll = 0;
  GROUPS.forEach(([g, label]) => {
    const tbl = J.registry(g), items = techItems(g), en = S.project.enabled[g] || (S.project.enabled[g] = {});
    const shown = q ? items.filter(k => (tbl[k].name + ' ' + k).toLowerCase().includes(q)) : items;
    const onN = items.filter(k => en[k] !== false).length;
    total += items.length; onAll += onN;
    if (q && !shown.length) return;
    const d = document.createElement('details'); d.className = 'tgroup';
    d.open = !!q || openGroups.has(g);
    d.addEventListener('toggle', () => { if (d.open) openGroups.add(g); else openGroups.delete(g); });
    d.innerHTML = `<summary><span class="tg-name">${label}</span><span class="tg-cnt mono">${onN}/${items.length}</span></summary><div class="tg-tools"><button class="ghost small" data-a="on">すべてON</button><button class="ghost small" data-a="off">すべてOFF</button><button class="ghost small" data-a="flip">反転</button></div>`;
    const list = document.createElement('div'); list.className = 'checks';
    shown.forEach(k => {
      const l = document.createElement('label');
      l.title = k + (tbl[k].tags && tbl[k].tags.length ? '（' + tbl[k].tags.map(t => (J.MOODS[t] ? J.MOODS[t].name : t)).join('・') + '）' : '');
      l.innerHTML = `<input type="checkbox" ${en[k] !== false ? 'checked' : ''}> ${escapeHtml(tbl[k].name)}`;
      l.querySelector('input').addEventListener('change', e => { en[k] = e.target.checked; S.project.mood = null; d.querySelector('.tg-cnt').textContent = `${items.filter(x => en[x] !== false).length}/${items.length}`; replanSoon(60); });
      list.appendChild(l);
    });
    d.querySelectorAll('.tg-tools button').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.a;
      shown.forEach(k => { en[k] = a === 'on' ? true : a === 'off' ? false : en[k] === false; });
      // keep a fallback so the planner always has something to use
      if (g === 'layout' && !items.some(k => en[k] !== false)) en.center = true;
      if (g === 'enter') en.cut = true; if (g === 'exit') en.cut = true; if (g === 'hold') en.still = true;
      if (g === 'treat') en.none = true; if (g === 'bg') en.none = true; if (g === 'cam') en.push = true;
      S.project.mood = null; openGroups.add(g); renderTech(); replan();
    }));
    d.appendChild(list);
    box.appendChild(d);
  });
  $('techTotal').textContent = `${onAll}/${total}`;
}

/* ---------------- output tab ---------------- */
function syncOut() {
  $('outAspect').value = S.project.aspect; $('outRes').value = String(S.project.res); $('outFps').value = String(S.project.fps);
  $('eAspect').value = S.project.aspect; $('eRes').value = String(S.project.res); $('eFps').value = String(S.project.fps);
  $('outQuality').value = S.project.quality || 'high'; $('outAudio').checked = S.project.includeAudio !== false;
}
async function codecNote() {
  const [w, h] = J.outputSize(S.project);
  const vc = await J.pickVideoCodec(w, h, S.project.fps, 12e6);
  $('codecNote').textContent = vc ? `このブラウザでは ${vc.label} で書き出します（${w}×${h} / ${S.project.fps}fps）。書き出し中はタブを開いたままにしてください。` : 'このブラウザは動画エンコード（WebCodecs）に対応していません。Chrome / Edge の最新版で開くか、連番PNGを使ってください。';
  $('btnMP4').disabled = !vc; $('eMP4').disabled = !vc;
  if (!vc) $('eMP4').title = 'このブラウザは MP4 書き出しに対応していません（Chrome / Edge 推奨）';
}
const EXP_BTNS = ['btnMP4', 'btnPNG', 'btnPNGA', 'eMP4'];
function baseName() { return ((S.project.title || 'jizura').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'jizura'); }
let lastDownload = null;
function showDownload(filename, blob) {
  const result = J.prepareDownload(filename, blob);
  if (lastDownload) lastDownload.dispose();
  lastDownload = result;
  $('downloadLink').href = result.url; $('downloadLink').download = filename;
  $('downloadOpen').href = result.url;
  $('downloadName').textContent = `${filename}（${(blob.size / 1048576).toFixed(1)}MB）`;
  $('downloadResult').hidden = false;
}
async function offerDownload(filename, blob) {
  showDownload(filename, blob);
  toast('書き出しが完了しました。「ダウンロード」を押して保存してください。');
}
async function runExport(kind) {
  if (S.exporting) return;
  pause();
  if (S.tap) stopTap();
  prepareRecovery();
  // Release the previous video before allocating another export.
  if (lastDownload) { lastDownload.dispose(); lastDownload = null; }
  $('downloadLink').removeAttribute('href'); $('downloadOpen').removeAttribute('href');
  $('downloadResult').hidden = true;
  const ac = new AbortController(); S.exporting = ac;
  const boxes = [...document.querySelectorAll('.exp-box')];
  const setText = m => boxes.forEach(b => { b.querySelector('.exp-text').textContent = m; });
  const txt = { set textContent(m) { setText(m); }, get textContent() { return boxes[0].querySelector('.exp-text').textContent; } };
  boxes.forEach(b => { b.hidden = false; b.querySelector('.exp-bar').style.width = '0%'; });
  setText('準備中…');
  EXP_BTNS.forEach(id => { $(id).disabled = true; });
  const onProgress = (p, m) => { boxes.forEach(b => { b.querySelector('.exp-bar').style.width = (p * 100).toFixed(1) + '%'; }); setText(m); };
  const t0 = performance.now();
  try {
    await J.ensureFonts(S.project.lyrics + (S.project.title || '') + (S.project.artist || '') + HUD_CHARS, null);
    if (kind === 'mp4') {
      const r = await J.exportMP4({ plan: S.plan, project: S.project, audio: S.project.includeAudio !== false ? S.audio : null, quality: S.project.quality || 'high', onProgress, signal: ac.signal });
      txt.textContent = `完成 ${(r.blob.size / 1048576).toFixed(1)}MB・${r.codec}${r.audio ? ' + ' + r.audio.toUpperCase() : ''}・${((performance.now() - t0) / 1000).toFixed(0)}秒`;
      await offerDownload(baseName() + '.mp4', r.blob);
      txt.textContent += '・ダウンロードを押して保存';
    } else {
      const blob = await J.exportPNGZip({ plan: S.plan, project: S.project, transparent: kind === 'pnga', onProgress, signal: ac.signal });
      txt.textContent = `完成 ${(blob.size / 1048576).toFixed(1)}MB`;
      await offerDownload(baseName() + (kind === 'pnga' ? '_alpha' : '') + '_png.zip', blob);
    }
  } catch (e) {
    txt.textContent = 'エラー: ' + (e && e.message ? e.message : e);
    console.error(e);
  } finally {
    S.exporting = null; S.need = true;
    EXP_BTNS.forEach(id => { $(id).disabled = false; });
    codecNote();
  }
}

/* ---------------- automatic draft timing + manual correction ---------------- */
let timingUndo = null;
function rememberTiming() {
  timingUndo = JSON.parse(JSON.stringify(S.project.timing));
  $('btnUndoTiming').disabled = false;
}
function setLineTime(i, value) {
  if (S.exporting) return;
  if (S.tap) { $('timingStatus').textContent = 'タップ同期を終了してから行を修整してください。'; return; }
  if (Number.isFinite(value)) value = +value.toFixed(3);
  const previous = i > 0 ? S.plan.lines[i - 1].start : -0.01;
  const next = i + 1 < S.plan.lines.length ? S.plan.lines[i + 1].start : (S.project.timing.autoEnd ?? S.audio?.duration ?? Infinity);
  const times = Object.assign({}, S.project.timing.lineTimes);
  if (Number.isFinite(value)) times[i] = value; else delete times[i];
  const candidate = Object.assign({}, S.project, { timing: Object.assign({}, S.project.timing, { lineTimes: times }) });
  const actual = J.computeTiming(candidate, J.parseLyrics(S.project.lyrics), audioLike()).starts[i];
  if (!Number.isFinite(actual) || actual < 0 || actual <= previous || actual >= next) {
    $('timingStatus').textContent = '開始秒は前の行より後、次の行（または歌い終わり）より前にしてください。';
    renderLines(); return;
  }
  rememberTiming();
  S.project.timing.lineTimes = times;
  $('timingStatus').textContent = `${i + 1}行目のタイミングを更新しました。`;
  replan();
}
function updateLyrics(raw) {
  const oldLines = J.parseLyrics(S.project.lyrics).lines, newLines = J.parseLyrics(raw).lines;
  const signature = lines => JSON.stringify(lines.map(l => [l.text, l.lrc, l.gapBefore]));
  if (signature(oldLines) !== signature(newLines)) {
    if (S.tap) { S.tap = null; pause(); $('tapPanel').hidden = true; $('btnTap').setAttribute('aria-pressed', 'false'); }
    const oldTimes = S.project.timing.lineTimes || {}, mapped = {};
    const oldIndices = new Map(), newIndices = new Map();
    oldLines.forEach((l, i) => oldIndices.set(l.text, [...(oldIndices.get(l.text) || []), i]));
    newLines.forEach((l, i) => newIndices.set(l.text, [...(newIndices.get(l.text) || []), i]));
    newLines.forEach((line, i) => {
      const oldMatches = oldIndices.get(line.text) || [], newMatches = newIndices.get(line.text) || [];
      let oldIndex = oldMatches.length === 1 && newMatches.length === 1 ? oldMatches[0] : -1;
      // With the same row count, preserve a correction when editing that row's words.
      // Existing matching rows take priority, so inserted or reordered rows are not misassigned.
      if (oldIndex < 0 && oldLines.length === newLines.length &&
          (oldLines[i].text === line.text || (!oldMatches.length && !newIndices.has(oldLines[i].text)))) oldIndex = i;
      if (oldIndex >= 0 && oldTimes[oldIndex] != null) mapped[i] = oldTimes[oldIndex];
    });
    // A reordering can make old anchors contradict the new order. Keep only compatible ones.
    let previous = -1;
    for (let i = 0; i < newLines.length; i++) {
      const value = mapped[i] != null ? +mapped[i] : newLines[i].lrc;
      if (value == null) continue;
      if (!Number.isFinite(value) || value <= previous) delete mapped[i];
      else previous = value;
    }
    S.project.timing.lineTimes = mapped;
    S.project.timing.autoTimes = {};
    timingUndo = null; $('btnUndoTiming').disabled = true;
    $('timingStatus').textContent = (oldLines.length !== newLines.length ? '行数が変わりました。対応する行の手修整を引き継ぎました。' : '歌詞を変更しました。対応する行の手修整を保ちました。') +
      (S.audio ? '「曲に合わせて仮配置」で再配置してください。' : '曲を読み込んで仮配置してください。');
  }
  S.project.lyrics = raw;
  replanSoon(260);
}
function autoTiming() {
  if (!S.audio || S.exporting) return;
  if (S.tap) { $('timingStatus').textContent = 'タップ同期を終了してから仮配置してください。'; return; }
  try {
    const start = Number($('autoStart').value);
    const end = $('autoEnd').value === '' ? S.audio.duration : Number($('autoEnd').value);
    const times = J.autoLyricTimes(J.parseLyrics(S.project.lyrics).lines, audioLike(), { start, end, anchors: S.project.timing.lineTimes });
    rememberTiming();
    Object.assign(S.project.timing, { autoStart: start, autoEnd: end, autoTimes: times });
    $('timingStatus').textContent = '仮配置しました。再生して、各行の開始秒・±0.1秒・「今の位置」で修整してください。';
    syncUI(); replan();
  } catch (e) { $('timingStatus').textContent = e.message; }
}

/* ---------------- tap sync ---------------- */
function startTap() {
  if (!S.plan.lines.length || S.exporting) return;
  rememberTiming();
  S.tap = { i: 0, times: {} };
  $('tapPanel').hidden = false; $('btnTap').setAttribute('aria-pressed', 'true');
  seek(0); play(); updateTap();
  $('tapBtn').focus();
}
function tapNow() {
  if (!S.tap) return;
  const time = +(S.audio && S.playing ? AP.time() : S.t).toFixed(3);
  if (time < 0 || (S.tap.i > 0 && time <= S.tap.times[S.tap.i - 1])) {
    $('timingStatus').textContent = '前の行より後の位置でタップしてください。'; return;
  }
  S.tap.times[S.tap.i] = time;
  S.tap.i++;
  if (S.tap.i >= S.plan.lines.length) stopTap(); else updateTap();
}
function stopTap() {
  const tap = S.tap;
  S.tap = null; $('tapPanel').hidden = true; $('btnTap').setAttribute('aria-pressed', 'false');
  if (tap && tap.i) {
    try {
      const lineTimes = Object.assign({}, S.project.timing.lineTimes, tap.times);
      const lines = J.parseLyrics(S.project.lyrics).lines;
      let timing = Object.assign({}, S.project.timing, { lineTimes, autoTimes: {} });
      if (S.audio) {
        const start = Math.min(timing.autoStart ?? 0, tap.times[0]);
        const end = timing.autoEnd ?? S.audio.duration;
        timing.autoTimes = J.autoLyricTimes(lines, audioLike(), { start, end, anchors: lineTimes });
        timing.autoStart = start; timing.autoEnd = end;
      } else {
        const starts = J.computeTiming(Object.assign({}, S.project, { timing }), { lines }, null).starts;
        if (starts.some((t, i) => !Number.isFinite(t) || t < 0 || (i && t <= starts[i - 1]))) {
          throw new Error('残りの行の確定時刻と前後しています。先に手修整を解除してください。');
        }
      }
      S.project.timing = timing;
      $('timingStatus').textContent = `${tap.i}行のタップを反映しました。` + (S.audio && tap.i < lines.length ? '残りは確定時刻を保って仮配置しました。' : '');
      syncUI();
    } catch (e) {
      $('timingStatus').textContent = 'タップは反映せず、元のタイミングを保ちました。' + e.message;
    }
  }
  replan();
}
function updateTap() { const ln = S.plan.lines[S.tap.i]; $('tapLine').textContent = ln ? `${S.tap.i + 1}. ${ln.text}` : '—'; }

/* ---------------- sync all inputs from project ---------------- */
function syncUI() {
  $('songTitle').value = S.project.title || ''; $('songArtist').value = S.project.artist || '';
  $('lyrics').value = S.project.lyrics;
  $('bpm').value = S.project.timing.bpm > 0 ? S.project.timing.bpm : '';
  $('bpm').placeholder = S.audio ? `自動 ${S.audio.bpm}` : 'なし';
  $('offset').value = S.project.timing.offset ?? 0.4;
  $('lineScale').value = S.project.timing.lineScale ?? 1;
  $('snap').checked = !!S.project.timing.snap;
  $('autoStart').value = S.project.timing.autoStart ?? 0;
  $('autoEnd').value = S.project.timing.autoEnd ?? '';
  $('autoEnd').placeholder = S.audio ? S.audio.duration.toFixed(2) : '曲の終わり';
  $('btnAutoTiming').disabled = !S.audio;
  $('moodLock').value = S.project.moodLock || '';
  renderFontRoles(); renderColors(); renderFx(); renderTech(); syncOut(); drawStyleGrid(); phSyncUI();
}

/* ---------------- wiring ---------------- */
function bind() {
  $('lyrics').addEventListener('input', e => updateLyrics(e.target.value));
  $('songTitle').addEventListener('input', e => { S.project.title = e.target.value; replanSoon(300); });
  $('songArtist').addEventListener('input', e => { S.project.artist = e.target.value; replanSoon(300); });
  $('btnSyntax').addEventListener('click', e => { const s = $('syntax'); s.hidden = !s.hidden; e.target.setAttribute('aria-expanded', String(!s.hidden)); });
  $('bpm').addEventListener('change', e => { S.project.timing.bpm = Math.max(0, parseFloat(e.target.value) || 0); replan(); });
  $('offset').addEventListener('change', e => { S.project.timing.offset = Math.max(0, parseFloat(e.target.value) || 0); replan(); });
  $('lineScale').addEventListener('change', e => { S.project.timing.lineScale = J.clamp(parseFloat(e.target.value) || 1, 0.3, 4); replan(); });
  $('snap').addEventListener('change', e => { S.project.timing.snap = e.target.checked; replan(); });
  // 雰囲気ロック：固定すると、以後の「おまかせ」は常にこの雰囲気を使う
  $('moodLock').innerHTML = '<option value="">おまかせ（毎回変える）</option>' + Object.keys(J.MOODS).map(k => `<option value="${k}">${escapeHtml(J.MOODS[k].name)}</option>`).join('');
  $('moodLock').addEventListener('change', e => { S.project.moodLock = e.target.value || null; autosave(); });
  $('btnResetTimes').addEventListener('click', () => { if (S.tap || S.exporting) return; rememberTiming(); S.project.timing.lineTimes = {}; replan(); });
  $('btnAutoTiming').addEventListener('click', autoTiming);
  $('btnAutoStart').addEventListener('click', () => { $('autoStart').value = S.t.toFixed(2); });
  $('btnAutoEnd').addEventListener('click', () => { $('autoEnd').value = S.t.toFixed(2); });
  $('btnUndoTiming').addEventListener('click', () => {
    if (!timingUndo || S.exporting || S.tap) return;
    S.project.timing = timingUndo; timingUndo = null; $('btnUndoTiming').disabled = true;
    $('timingStatus').textContent = '直前のタイミングに戻しました。'; syncUI(); replan();
  });
  $('audioFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    $('audioName').textContent = '解析中…';
    try {
      pause();
      if (S.tap) stopTap();
      S.audio = await J.analyzeAudio(f);
      $('audioName').textContent = `${f.name}（${J.fmtTime(S.audio.duration)}・約${S.audio.bpm}BPM）`;
      S.project.timing.snap = true;
      syncUI(); replan();
      const hasTimes = Object.keys(S.project.timing.lineTimes || {}).length || Object.keys(S.project.timing.autoTimes || {}).length || J.parseLyrics(S.project.lyrics).lines.some(l => l.lrc != null);
      if (!hasTimes) autoTiming();
      else $('timingStatus').textContent = '保存済みのタイミングを保持しました。必要なら範囲を指定して「曲に合わせて仮配置」を押してください。';
    } catch (err) { $('audioName').textContent = '読み込めませんでした: ' + err.message; S.audio = null; syncUI(); replan(); }
    e.target.value = '';
  });
  $('btnTap').addEventListener('click', () => (S.tap ? stopTap() : startTap()));
  $('tapBtn').addEventListener('click', tapNow);
  $('tapStop').addEventListener('click', () => { pause(); stopTap(); });
  $('btnPlay').addEventListener('click', () => (S.playing ? pause() : play()));
  $('btnLoop').addEventListener('click', e => { S.loop = !S.loop; e.target.setAttribute('aria-pressed', String(S.loop)); });
  $('btnShuffle').addEventListener('click', () => { remember(); S.project.seed = (Math.random() * 1e9) | 0; $('seed').value = S.project.seed; replan(); commit(); });
  const sc = $('scrub');
  sc.addEventListener('input', () => { S.scrubbing = true; seek(sc.value / 10000 * S.plan.duration); });
  sc.addEventListener('change', () => { S.scrubbing = false; });
  const tl = $('timeline');
  let drag = false;
  tl.addEventListener('pointerdown', e => { drag = true; tl.setPointerCapture(e.pointerId); timelineSeek(e); });
  tl.addEventListener('pointermove', e => { if (drag) timelineSeek(e); });
  tl.addEventListener('pointerup', () => { drag = false; });
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.tabpane').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    if (b.dataset.tab === 'out') codecNote();
  }));
  $('fxFlash').addEventListener('change', e => { S.project.fx.flash = e.target.checked; replan(); });
  $('techFilter').addEventListener('input', () => renderTech());
  $('fxKoma').addEventListener('change', e => { const k = +e.target.value; S.project.fx.koma = k; S.project.fx.onTwos = k > 0; S.project.mood = null; replan(); });
  $('fxHud').addEventListener('change', e => { S.project.fx.hud = e.target.value; replan(); });
  $('seed').addEventListener('change', e => { S.project.seed = parseInt(e.target.value, 10) || 0; replan(); });
  $('btnSeed').addEventListener('click', () => { S.project.seed = (Math.random() * 1e9) | 0; $('seed').value = S.project.seed; replan(); });
  const colorToggle = (flag, keys) => e => {
    remember();
    const c = S.project.colors; c[flag] = e.target.checked;
    if (c[flag]) { const sc0 = J.STYLES[S.project.style].schemes[0]; keys.forEach(([k]) => { if (!c[k]) c[k] = sc0[k]; }); }
    renderColors(); replan(); commit();
  };
  $('colorOn').addEventListener('change', colorToggle('enabled', BASE_KEYS));
  $('accentOn').addEventListener('change', colorToggle('accentOn', ACCENT_KEYS));
  $('btnRandPalette').addEventListener('click', randomPalette);
  $('btnAddFont').addEventListener('click', () => {
    const name = $('localFont').value.trim(); if (!name) return;
    const key = 'local_' + name.replace(/\s+/g, '_');
    const weight = /bold|太|black|heavy|w[6-9]|[6-9]00/i.test(name) ? 700 : 400;
    J.addUserFont(key, name + '（PC）', name, weight);
    S.project.userFonts = (S.project.userFonts || []).filter(u => u.key !== key).concat([{ key, label: name + '（PC）', family: name, weight }]);
    S.project.fonts.display = key; $('localFont').value = '';
    fontKey = ''; renderFontRoles(); replan();
  });
  $('fontFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try { const key = await J.loadFontFile(f); S.project.fonts.display = key; fontKey = ''; renderFontRoles(); replan(); }
    catch (err) { showMsg('フォントを読み込めませんでした'); setTimeout(() => showMsg(null), 2500); }
  });
  ['outAspect', 'eAspect'].forEach(id => $(id).addEventListener('change', e => { S.project.aspect = e.target.value; syncOut(); replan(); codecNote(); }));
  ['outRes', 'eRes'].forEach(id => $(id).addEventListener('change', e => { S.project.res = +e.target.value; syncOut(); autosave(); codecNote(); }));
  ['outFps', 'eFps'].forEach(id => $(id).addEventListener('change', e => { S.project.fps = +e.target.value; syncOut(); replan(); codecNote(); }));
  $('outQuality').addEventListener('change', e => { S.project.quality = e.target.value; autosave(); });
  $('outAudio').addEventListener('change', e => { S.project.includeAudio = e.target.checked; autosave(); });
  $('btnMP4').addEventListener('click', () => runExport('mp4'));
  $('btnPNG').addEventListener('click', () => runExport('png'));
  $('btnPNGA').addEventListener('click', () => runExport('pnga'));
  document.querySelectorAll('.exp-cancel').forEach(b => b.addEventListener('click', () => { if (S.exporting) S.exporting.abort(); }));
  $('eMP4').addEventListener('click', () => runExport('mp4'));
  // かんたんモード
  $('modeEasy').addEventListener('click', () => setMode('easy'));
  $('modePro').addEventListener('click', () => setMode('pro'));
  $('btnOmakase').addEventListener('click', omakase);
  $('btnOmakaseBig').addEventListener('click', omakase);
  ['btnPrev', 'btnPrev2'].forEach(id => $(id).addEventListener('click', () => histGo(-1)));
  ['btnNext', 'btnNext2'].forEach(id => $(id).addEventListener('click', () => histGo(1)));
  $('eStyle').addEventListener('click', () => rerollPart('style'));
  $('eMood').addEventListener('click', () => rerollPart('mood'));
  $('eCut').addEventListener('click', () => rerollPart('cut'));
  $('ePalette').addEventListener('click', () => { randomPalette(); restartPreview(); });
  $('btnSave').addEventListener('click', () => { prepareRecovery(); J.saveFile(baseName() + '.jizura.json', JSON.stringify(S.project, null, 1)); });
  $('btnAE').addEventListener('click', () => {
    if (S.plan.photo && S.plan.photo.on) toast('写真PVモードの写真はAE用データには含まれません');
    J.saveFile(baseName() + '_ae.json', JSON.stringify(J.planForAE(S.plan, S.project), null, 1));
  });
  $('fileProject').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try { S.project = mergeProject(JSON.parse(await f.text())); timingUndo = null; $('btnUndoTiming').disabled = true; syncUI(); replan(); reconcilePhotos(); }
    catch (err) { showMsg('プロジェクトを読み込めませんでした'); setTimeout(() => showMsg(null), 2500); }
    e.target.value = '';
  });
  // 写真PV
  J.photoNotify = toast;
  J.photoOnLoad = () => { S.need = true; };
  $('phOn').addEventListener('change', e => { S.project.photo.on = e.target.checked; $('phOnPro').checked = e.target.checked; photoChanged(); });
  $('phOnPro').addEventListener('change', e => { S.project.photo.on = e.target.checked; $('phOn').checked = e.target.checked; photoChanged(); });
  $('phAdd').addEventListener('change', e => { addPhotoFiles(e.target.files); e.target.value = ''; });
  $('phAddPro').addEventListener('change', e => { addPhotoFiles(e.target.files); e.target.value = ''; });
  $('phUnit').addEventListener('change', e => { S.project.photo.unit = e.target.value; $('phUnitPro').value = e.target.value; photoChanged(); });
  $('phUnitPro').addEventListener('change', e => { S.project.photo.unit = e.target.value; $('phUnit').value = e.target.value; photoChanged(); });
  $('phBeatsPer').addEventListener('change', e => { S.project.photo.beatsPer = +e.target.value; photoChanged(); });
  $('phDim').addEventListener('input', e => {
    S.project.photo.dim = +e.target.value; $('phDimOut').textContent = Math.round(e.target.value * 100) + '%';
    $('phDimPro').value = e.target.value; $('phDimProOut').textContent = Math.round(e.target.value * 100) + '%';
    replanSoon(120);
  });
  $('phDimPro').addEventListener('input', e => {
    S.project.photo.dim = +e.target.value; $('phDimProOut').textContent = Math.round(e.target.value * 100) + '%';
    $('phDim').value = e.target.value; $('phDimOut').textContent = Math.round(e.target.value * 100) + '%';
    replanSoon(120);
  });
  $('phFade').addEventListener('input', e => { S.project.photo.fade = +e.target.value; $('phFadeOut').textContent = (+e.target.value).toFixed(2) + 's'; replanSoon(120); });
  $('phKenBurns').addEventListener('change', e => { S.project.photo.kenBurns = e.target.checked; replan(); });
  $('phShuffle').addEventListener('click', () => {
    const ids = S.project.photo.ids;
    for (let i = ids.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [ids[i], ids[j]] = [ids[j], ids[i]]; }
    renderPhotoGrid(); photoChanged();
  });
  $('phClearAll').addEventListener('click', async () => {
    if (!S.project.photo.ids.length) return;
    if (!confirm('写真をすべて削除しますか？')) return;
    await J.photo.removeAll(S.project.photo.ids);
    S.project.photo.ids = [];
    phSyncUI(); photoChanged();
  });
  ['dragover', 'drop'].forEach(evt => $('app').addEventListener(evt, e => {
    if (e.dataTransfer && [...(e.dataTransfer.items || [])].some(it => it.kind === 'file')) e.preventDefault();
  }));
  $('app').addEventListener('drop', e => {
    const files = e.dataTransfer && e.dataTransfer.files; if (!files || !files.length) return;
    const imgs = [...files].filter(f => /^image\//.test(f.type));
    if (imgs.length) addPhotoFiles(imgs);
  });
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) && e.target.type !== 'range' && e.target.type !== 'checkbox';
    if (S.tap && (e.code === 'Space' || e.code === 'Enter') && !typing) { e.preventDefault(); tapNow(); return; }
    if (S.tap && e.code === 'Escape') { pause(); stopTap(); return; }
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
    else if (e.code === 'ArrowRight') seek(S.t + (e.shiftKey ? 1 : 1 / S.plan.fps));
    else if (e.code === 'ArrowLeft') seek(S.t - (e.shiftKey ? 1 : 1 / S.plan.fps));
    else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey && !e.altKey && !S.exporting) { e.preventDefault(); omakase(); }
  });
  window.addEventListener('pagehide', () => { saveNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  window.addEventListener('resize', () => { sizeViewport(); drawTimeline(); });
  if (window.ResizeObserver) new ResizeObserver(() => { sizeViewport(); drawTimeline(); }).observe($('viewport'));
}

/* ---------------- boot ---------------- */
function boot() {
  S.project = loadLocal();
  bind(); syncUI(); replan(); reconcilePhotos();
  let mode = 'easy'; try { mode = localStorage.getItem('jizura.mode') || 'easy'; } catch (e) {}
  setMode(mode); commit();
  // open on a representative frame (end of the first cut's entrance)
  const c0 = S.plan.cuts.find(c => c.line >= 0);
  if (c0) seek(c0.start + Math.min(c0.dur * 0.6, c0.inDur + 0.25));
  requestAnimationFrame(tick);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
J.ui = S;
})();

