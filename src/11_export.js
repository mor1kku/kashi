/* ============================================================
   JIZURA — export: MP4 (WebCodecs + mp4-muxer), PNG sequence ZIP,
   file saving (artifact download capability or plain browser download)
   ============================================================ */
(() => {
'use strict';

/* ---------- saving ---------- */
// Keep this object alive while a visible download link is offered. A real user
// click can save the completed export even when an automatic download is blocked.
J.prepareDownload = (filename, data) => {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const url = URL.createObjectURL(blob);
  let disposed = false;
  return { filename, blob, url, dispose() { if (!disposed) { URL.revokeObjectURL(url); disposed = true; } } };
};
J.saveFile = async (filename, data) => {
  const blob = data instanceof Blob ? data : new Blob([data]);
  try {
    if (window.claude && typeof window.claude.use === 'function') {
      const dl = await window.claude.use('downloads');
      if (dl) { await dl.save({ filename, data: blob }); return 'saved'; }
    }
  } catch (e) {
    if (e && e.code === 'declined') return 'declined';
    if (e && e.code && e.code !== 'unavailable' && e.code !== 'not_granted') throw e;
  }
  const download = J.prepareDownload(filename, blob);
  const a = document.createElement('a'); a.href = download.url; a.download = filename;
  document.body.appendChild(a);
  try { a.click(); } finally { a.remove(); setTimeout(() => download.dispose(), 60000); }
  // Browsers do not expose whether a download was accepted or saved to disk.
  return 'initiated';
};

/* ---------- codec negotiation ---------- */
J.pickVideoCodec = async (w, h, fps, bitrate) => {
  if (typeof VideoEncoder === 'undefined') return null;
  const cands = [
    { codec: 'avc1.640033', mux: 'avc', label: 'H.264 High' },
    { codec: 'avc1.4d0033', mux: 'avc', label: 'H.264 Main' },
    { codec: 'avc1.42003e', mux: 'avc', label: 'H.264 Baseline' },
    { codec: 'vp09.00.51.08', mux: 'vp9', label: 'VP9' },
    { codec: 'av01.0.12M.08', mux: 'av1', label: 'AV1' },
  ];
  for (const c of cands) {
    const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' };
    if (c.mux === 'avc') cfg.avc = { format: 'avc' };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return Object.assign({}, c, { cfg }); } catch (e) {}
  }
  return null;
};
J.pickAudioCodec = async (sr, chn) => {
  const c = { codec: 'mp4a.40.2', mux: 'aac', sr: 48000 };
  if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
    try { const s = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: c.sr, numberOfChannels: chn, bitrate: 192000 }); if (s.supported) return c; } catch (e) {}
  }
  // Opus in MP4 is silent in some phone/gallery players. Always produce AAC.
  if (J.createSoftwareAacEncoder) return { ...c, software: true };
  return null;
};

async function resample(buffer, sr, offset, length) {
  const chn = Math.min(2, buffer.numberOfChannels);
  const oc = new OfflineAudioContext(chn, length, sr);
  const src = oc.createBufferSource(); src.buffer = buffer; src.connect(oc.destination);
  if (offset < buffer.duration) src.start(0, offset);
  return oc.startRendering();
}

/* ---------- MP4 ---------- */
// The whole MP4 still lives in browser memory. Keep the encoded output bounded,
// leaving room for the muxer's growing buffer, Blob copy, images and decoded song.
const MP4_MAX_BYTES = 256 * 1024 * 1024;
J.exportBitrate = (w, h, fps, quality = 'high') => {
  const pixels = w * h;
  const rates = pixels <= 1280 * 720 ? [4, 6, 10] : pixels <= 1920 * 1080 ? [6, 10, 16] : pixels <= 2560 * 1440 ? [10, 16, 24] : [16, 28, 40];
  return rates[quality === 'max' ? 2 : quality === 'high' ? 1 : 0] * (fps > 30 ? 1.5 : 1) * 1e6;
};
const memoryError = () => new Error('MP4の容量が大きすぎます。解像度を720p、fpsを24または30、画質を標準に下げて再試行してください。');
J.exportMP4 = async ({ plan, project, audio, quality = 'high', onProgress, signal }) => {
  const [w, h] = J.outputSize(project);
  const fps = plan.fps;
  const bitrate = J.exportBitrate(w, h, fps, quality);
  if (project.includeAudio !== false && !audio?.buffer) throw new Error('音声が未読込です。「曲を読み込む」でMP3などを指定してください。音声なしで作る場合は「曲を動画に含める」をOFFにしてください。');
  const wantsAudio = audio && audio.buffer && project.includeAudio !== false;
  if (!Number.isFinite(plan.duration) || plan.duration <= 0) throw new Error('動画の長さを確認してください。');
  if ((bitrate + (wantsAudio ? 192000 : 0)) * plan.duration / 8 * 1.05 > MP4_MAX_BYTES) throw memoryError();
  const vc = await J.pickVideoCodec(w, h, fps, bitrate);
  if (!vc) throw new Error('このブラウザは動画エンコード（WebCodecs）に対応していません。Chrome か Edge の最新版で開いてください。');
  let ac = null;
  if (wantsAudio) {
    ac = await J.pickAudioCodec(48000, Math.min(2, audio.buffer.numberOfChannels));
    if (!ac) throw new Error('このブラウザでは音声付きMP4を書き出せません。最新版のChrome / Edgeでページを開き直してください。');
  }
  const target = new Mp4Muxer.ArrayBufferTarget();
  // A local download can keep its metadata at the end. Unlike in-memory fast
  // start, this writes/relinquishes chunks as they arrive instead of retaining
  // a second full set of encoded samples until finalization.
  const muxOpts = { target, video: { codec: vc.mux, width: w, height: h, frameRate: fps }, fastStart: false, firstTimestampBehavior: 'offset' };
  if (ac) muxOpts.audio = { codec: ac.mux, numberOfChannels: Math.min(2, audio.buffer.numberOfChannels), sampleRate: ac.sr };
  const muxer = new Mp4Muxer.Muxer(muxOpts);
  let err = null, venc = null, aenc = null, softwareAudio = null, encodedBytes = 0, audioChunks = 0;
  const check = () => {
    if (signal && signal.aborted) throw new Error('キャンセルしました');
    if (err) throw err;
  };
  const close = encoder => { if (encoder && encoder.state !== 'closed') { try { encoder.close(); } catch (e) {} } };
  const abort = () => { close(venc); close(aenc); softwareAudio?.close(); };
  const output = add => (chunk, meta) => {
    if (err) return;
    try {
      encodedBytes += chunk.byteLength || chunk.data?.byteLength || 0;
      if (encodedBytes > MP4_MAX_BYTES) throw memoryError();
      add(chunk, meta);
    } catch (e) { err = e; }
  };
  const drain = async (encoder, limit) => {
    while (encoder.encodeQueueSize > limit) {
      check();
      await new Promise(r => setTimeout(r, 2));
    }
    check();
  };
  const prevRes = J.glyphs.maxRes;
  if (signal) signal.addEventListener('abort', abort);
  try {
    check();
    if (ac?.software) {
      onProgress && onProgress(0, '音声の書き出しを準備中');
      softwareAudio = await J.createSoftwareAacEncoder({ sampleRate: ac.sr, numberOfChannels: Math.min(2, audio.buffer.numberOfChannels), bitrate: 192000 },
        output((packet, meta) => { muxer.addAudioChunkRaw(packet.data, 'key', packet.timestamp, packet.duration, meta); audioChunks++; }), signal);
      check();
    }
    venc = new VideoEncoder({ output: output((chunk, meta) => muxer.addVideoChunk(chunk, meta)), error: e => { err = e; } });
    venc.configure(vc.cfg);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('描画領域を作成できません。解像度を下げて再試行してください。');
    const R = new J.Renderer();
    const total = Math.max(1, Math.round(plan.duration * fps));
    const scale = w / plan.W;
    J.glyphs.maxRes = h >= 1000 ? 768 : 512;
    for (let i = 0; i < total; i++) {
      check();
      if (plan.photo && plan.photo.on) await J.photo.ready(plan, i / fps);
      check();
      R.frame(ctx, plan, i / fps, { scale });
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      try { venc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); } finally { vf.close(); }
      await drain(venc, 4);
      if (i % 3 === 0) { onProgress && onProgress(0.95 * i / total, `フレーム ${i + 1}/${total}`); await new Promise(r => setTimeout(r, 0)); }
    }
    await venc.flush();
    check(); close(venc);
    if (ac) {
      onProgress && onProgress(0.95, '音声をエンコード中');
      const chn = Math.min(2, audio.buffer.numberOfChannels);
      if (!softwareAudio) {
        aenc = new AudioEncoder({ output: output((chunk, meta) => { muxer.addAudioChunk(chunk, meta); audioChunks++; }), error: e => { err = e; } });
        aenc.configure({ codec: ac.codec, sampleRate: ac.sr, numberOfChannels: chn, bitrate: 192000 });
      }
      const frames = Math.ceil(plan.duration * ac.sr), block = 4800, windowFrames = ac.sr * 5;
      for (let windowStart = 0; windowStart < frames; windowStart += windowFrames) {
        check();
        const rs = await resample(audio.buffer, ac.sr, windowStart / ac.sr, Math.min(windowFrames, frames - windowStart));
        check();
        if (softwareAudio) {
          const data = new Float32Array(rs.length * chn);
          for (let c = 0; c < chn; c++) {
            const plane = rs.getChannelData(c);
            for (let i = 0; i < rs.length; i++) data[i * chn + c] = plane[i];
          }
          await softwareAudio.encode(data); check();
          onProgress && onProgress(0.95 + 0.04 * Math.min(frames, windowStart + rs.length) / frames, '音声をエンコード中');
          continue;
        }
        for (let off = 0; off < rs.length; off += block) {
          check();
          const n = Math.min(block, rs.length - off);
          const data = new Float32Array(n * chn);
          for (let c = 0; c < chn; c++) data.set(rs.getChannelData(c).subarray(off, off + n), c * n);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: ac.sr, numberOfFrames: n, numberOfChannels: chn, timestamp: Math.round((windowStart + off) * 1e6 / ac.sr), data });
          try { aenc.encode(ad); } finally { ad.close(); }
          await drain(aenc, 16);
          if (off % (block * 16) === 0) {
            onProgress && onProgress(0.95 + 0.04 * (windowStart + off) / frames, '音声をエンコード中');
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }
      if (softwareAudio) await softwareAudio.flush();
      else await aenc.flush();
      check(); close(aenc); softwareAudio?.close();
      if (!audioChunks) throw new Error('音声を書き出せなかったため動画の保存を中止しました。ページを開き直して再試行してください。');
    }
    check();
    onProgress && onProgress(0.99, 'MP4を仕上げています');
    muxer.finalize();
    onProgress && onProgress(1, '完了');
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), codec: vc.label, audio: ac ? ac.mux : null, width: w, height: h };
  } catch (e) {
    check();
    throw e;
  } finally {
    close(venc); close(aenc); softwareAudio?.close();
    J.glyphs.maxRes = prevRes;
    if (signal) signal.removeEventListener('abort', abort);
  }
};

/* ---------- PNG sequence as ZIP (store, no compression) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; }
  add(name, u8) {
    const nb = new TextEncoder().encode(name), crc = crc32(u8);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, u8.length, true); lh.setUint32(22, u8.length, true);
    lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    this.parts.push(lh.buffer, nb, u8);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, u8.length, true); ch.setUint32(24, u8.length, true);
    ch.setUint16(28, nb.length, true); ch.setUint32(42, this.offset, true);
    this.central.push(ch.buffer, nb);
    this.offset += 30 + nb.length + u8.length;
  }
  finish() {
    const cdSize = this.central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
    const n = this.central.length / 2;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, n, true); end.setUint16(10, n, true); end.setUint32(12, cdSize, true); end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
  }
}
J.exportPNGZip = async ({ plan, project, transparent, onProgress, signal, every = 1 }) => {
  const [w, h] = J.outputSize(project);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const R = new J.Renderer();
  const fps = plan.fps, total = Math.max(1, Math.round(plan.duration * fps));
  const zip = new ZipWriter();
  const scale = w / plan.W;
  for (let i = 0; i < total; i += every) {
    if (signal && signal.aborted) throw new Error('キャンセルしました');
    if (plan.photo && plan.photo.on && !transparent) await J.photo.ready(plan, i / fps); // 透過PNGには写真を出さないので待たない
    R.frame(ctx, plan, i / fps, { scale, transparent });
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (signal && signal.aborted) throw new Error('キャンセルしました');
    if (!blob) throw new Error('PNGを作成できません。解像度を下げて再試行してください。');
    zip.add(`jizura_${String(i).padStart(5, '0')}.png`, new Uint8Array(await blob.arrayBuffer()));
    onProgress && onProgress(i / total, `PNG ${i + 1}/${total}`);
  }
  onProgress && onProgress(1, '完了');
  return zip.finish();
};

/* ---------- plan JSON for the After Effects panel ---------- */
/* The After Effects panel implements the original expression set. Newer pack entries are exported as their
   closest original counterpart (the browser key is kept in web* fields so nothing is lost). */
J.AE_MAP = {
  layout: { lowerThird: 'center', corners: 'mixed', staircase: 'mixed', zigzag: 'wave', arcTop: 'ring', spiral: 'ring', gridCells: 'labels', dropCap: 'mixed', justified: 'tile', frameBox: 'center', bubble: 'pill', subtitleBar: 'center', ticker: 'marquee', splitScreen: 'diag', mirror: 'stack', sideways: 'vcols', edgeFrame: 'marquee', perspective: 'stack', hanko: 'vcols', genkou: 'vcols', panels: 'diag', filmstrip: 'labels', quote: 'center', ruler: 'gloss', searchBar: 'type', chat: 'labels', notification: 'pill', ticket: 'pill',
    rain: 'tile', hanging: 'scatter', orbit: 'ring', tunnel: 'tile', wordCloud: 'scatter', bounceLine: 'mixed', elastic: 'condensed', crossBands: 'diag', stickerBomb: 'labels', neon: 'center', keycaps: 'labels', bubbles: 'scatter', slotMachine: 'labels', flipBoard: 'labels', credits: 'type', zoomRepeat: 'stack', splitHalves: 'stack', columnsBig: 'vcols', circleWords: 'ring', dotMatrix: 'type', depthStack: 'stack', typeSpecimen: 'stack', kanjiFocus: 'huge', halfVertical: 'vcols', curtain: 'center', equalizer: 'mixed', tape: 'diag', danmaku: 'marquee', fillRepeat: 'tile' },
  enter: { riseMask: 'drop', dropMask: 'drop', slideL: 'wipe', slideR: 'wipe', slideWhole: 'stretch', flipX: 'spin', flipY: 'spin', domino: 'spin', fold: 'pop', unroll: 'wipe', strokeDraw: 'assemble', outlineFill: 'blur', splitJoin: 'slice', vSlice: 'slice', shutter: 'wipe', iris: 'zoom', diagWipe: 'wipe', blinds: 'slice', checker: 'flicker', randomOrder: 'flicker', bounceBig: 'drop', squashDrop: 'drop', rubber: 'stretch', glitchIn: 'scramble', echoIn: 'zoom', whip: 'stretch', skewIn: 'stretch', trackIn: 'blur', trackOut: 'blur', blurStagger: 'blur', fadeStagger: 'blur', waveIn: 'pop', spiralIn: 'spin', zoomOut: 'zoom', resolve: 'scramble', magnet: 'assemble', inkBleed: 'blur', neonOn: 'flicker', cursorSweep: 'type', stamp: 'zoom', rapidFlash: 'flicker', pixelIn: 'scramble' },
  exit: { sinkMask: 'fall', riseOut: 'drift', slideOutL: 'stretch', slideOutR: 'stretch', flipOutX: 'shrink', flipOutY: 'fall', foldOut: 'shrink', squash: 'shrink', trackOutWide: 'blur', collapse: 'shrink', zoomThrough: 'blur', zoomFar: 'shrink', spinOut: 'scatter', twist: 'shrink', waveOut: 'scatter', blurOutStagger: 'blur', undraw: 'blur', outlineOut: 'blur', irisClose: 'shrink', diagWipeOut: 'wipe', blindsClose: 'slice', checkerOut: 'glitch', splitApart: 'slice', vSliceDrop: 'fall', melt: 'fall', dissolve: 'drift', backspace: 'wipe', scrambleOut: 'glitch', glitchDissolve: 'glitch', echoOut: 'blur', whipOut: 'stretch', gravity: 'fall', popOut: 'scatter', burn: 'drift', sweepCover: 'wipe', shatterLite: 'explode' },
  hold: { float: 'drift', sway: 'wave', pulse: 'breathe', shimmer: 'still', colorRun: 'still', rotateSlow: 'drift', trackBreathe: 'breathe', skewWobble: 'wave', beatHop: 'wave', hWave: 'wave', heartbeat: 'breathe', orbitSmall: 'jitter', jelly: 'breathe', scanBand: 'glitchtick', noiseDrift: 'drift', tilt: 'drift', zoomSlow: 'drift', stretchPulse: 'breathe', glitchJump: 'glitchtick', echoTrail: 'drift', beatBlink: 'glitchtick' },
  decor: { crosshair: 'brackets', cropMarks: 'brackets', reticle: 'rings', radar: 'rings', progressRing: 'rings', timecodeBar: 'barcode', rulerEdge: 'grid', dimension: 'leaders', indexNum: 'counter', dateStamp: 'barcode', qrBlock: 'barcode', glitchRects: 'bars', concentricSquares: 'shapes', triangleSpin: 'shapes', lineBurst: 'sparks', plusGrid: 'grid', guides: 'grid', waveLine: 'waveform', spiralLine: 'rings', halftonePatch: 'shapes', checkerStrip: 'stripes', beatRing: 'rings', orbitDots: 'dots', constellation: 'sparks', confetti: 'shapes', petals: 'shapes', rainStreaks: 'slash', snow: 'dots', lightLeak: 'blobs', bokeh: 'blobs', speedCorner: 'slash', risingParticles: 'sparks', twinkle: 'sparks', brushStroke: 'bars', tapePieces: 'bars', scribbleCircle: 'rings', scribbleUnder: 'slash', crossOut: 'slash', highlightMark: 'bars', heartsStars: 'shapes', watermarkKanji: 'counter', verticalStrip: 'leaders', romajiLine: 'leaders', bracketsJP: 'brackets', seal: 'shapes' },
  fx: { rgbSplit: 'chroma', smear: 'slice', vhsRoll: 'slice', trackingNoise: 'slice', waveWarp: 'slice', pixelDrift: 'slice', tileShift: 'block', gridRepeat: 'block', mirrorFlash: 'block', strobe: 'invert', blackFrame: 'invert', whiteFrame: 'flash', filmBurn: 'flash', lightSweep: 'flash', panelWipe: 'flash', zoomPunch: 'zoom', whipBlur: 'zoom', posterize: 'mosaic', hueShift: 'chroma', pixelate: 'mosaic' },
};
const aeKey = (g, k, dflt) => (J.CORE_ORDER[g] && J.CORE_ORDER[g].includes(k)) || (g === 'layout' && (k === 'title' || k === 'interlude')) ? k : (J.AE_MAP[g][k] || dflt);
J.planForAE = (plan, project) => {
  const clean = JSON.parse(JSON.stringify(plan, (k, v) => (k === 'energy' || k === 'buffer' || k === 'peaks' ? undefined : v)));
  let subs = 0;
  for (const c of clean.cuts) {
    const L = aeKey('layout', c.layout, 'center');
    if (L !== c.layout) { c.webLayout = c.layout; c.layout = L; subs++; try { c.params = J.LAYOUTS[L].plan(J.rng(J.h(c.seed, 31)), { text: c.text, n: J.glyphCount(c.text) }, plan.style); } catch (e) { c.params = {}; } }
    const en = aeKey('enter', c.enter, 'blur'); if (en !== c.enter) { c.webEnter = c.enter; c.enter = en; subs++; }
    const ex = aeKey('exit', c.exit, 'blur'); if (ex !== c.exit) { c.webExit = c.exit; c.exit = ex; subs++; }
    const ho = aeKey('hold', c.hold, 'still'); if (ho !== c.hold) { c.webHold = c.hold; c.hold = ho; }
    const seen = new Set();
    c.decor = (c.decor || []).map(d => { const id = aeKey('decor', d.id, null); if (id !== d.id) subs++; return id ? Object.assign({}, d, { id, webId: d.id }) : null; })
      .filter(d => d && !seen.has(d.id) && seen.add(d.id));
  }
  clean.events = clean.events.map(ev => { const FX = J.FXE[ev.type]; if (!FX || FX.builtin) return ev; const t = J.AE_MAP.fx[ev.type]; return t ? Object.assign({}, ev, { type: t, webType: ev.type }) : null; }).filter(Boolean);
  if (subs) clean.aeNote = `ブラウザ版の新しい表現 ${subs} 箇所を、AEパネルにある近い表現に置き換えています（文字加工・背景・カメラはAE版では未対応）`;
  clean.width = J.outputSize(project)[0]; clean.height = J.outputSize(project)[1];
  clean.fonts = {};
  for (const [role, keys] of Object.entries(plan.style.fonts)) clean.fonts[role] = keys.map(k => J.FONTS[k] ? J.FONTS[k].label : k);
  clean.fontTable = Object.fromEntries(Object.entries(J.FONTS).map(([k, f]) => [k, { label: f.label, family: f.family.replace(/"/g, ''), weight: f.weight, kind: f.kind }]));
  return clean;
};
})();

