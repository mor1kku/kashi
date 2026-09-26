/* JIZURA pack: vocalo — ニコニコ動画/ボカロ曲PV風の演出（弾幕コメント・高速点滅・ドット化） */
(() => {
'use strict';
const E = J.E;
const P = 'vocalo';
const reg = (g, k, d) => J.register(g, k, d, P);
const clamp = J.clamp, DEG = J.DEG, TAU = J.TAU;
const fontsOf = J.fontsOf;

/* ================= LAYOUTS ================= */

// ニコニコ風の定番コメント（歌詞の断片と混ぜて弾幕にする）
const STOCK = ['888888', 'wwwwwww', 'ｷﾀ━━━(ﾟ∀ﾟ)━━━!!', 'うおおおお', '神', 'これは神曲', '中毒性', 'ここすき', 'たまらん', 'すごい', '最高'];

reg('layout', 'danmaku', {
  name: '弾幕', tags: ['pop', 'glitch', 'vocalo'], w: 0.85, busy: true, fits: n => n >= 1 && n <= 16,
  plan(rng, cut, st) {
    const lanesN = rng.int(5, 8);
    const count = rng.int(11, 16);
    const words = (cut.words && cut.words.length ? cut.words : [cut.lineText || cut.text]).filter(Boolean);
    // レーンごとに速さを揃えて追い越しを防ぎ、同じレーン内は位相を等間隔にずらして重ならないようにする
    const laneSpeed = Array.from({ length: lanesN }, () => rng.range(0.75, 1.35));
    const perLane = Math.ceil(count / lanesN);
    const comments = [];
    for (let i = 0; i < count; i++) {
      const useStock = !words.length || rng.chance(0.55);
      const lane = i % lanesN, slot = Math.floor(i / lanesN);
      comments.push({
        lane,
        text: useStock ? rng.pick(STOCK) : rng.pick(words),
        speed: laneSpeed[lane],
        size: rng.pick([0.6, 0.8, 1.0]),   // サイズを段階に揃えて字形キャッシュを効かせる
        phase: (slot + rng.range(0, 0.35)) / perLane + J.r(lane, 77) * 0.5,   // 開始時点で画面内に散らばる
        hot: useStock && rng.chance(0.4),
      });
    }
    return { font: rng.pick(fontsOf(st, ['display', 'body'])), lanesN, comments, oy: rng.range(-0.02, 0.02) };
  },
  render(env) {
    const { W, H, sc } = env, P2 = env.cut.params;
    const text = J.splitLines(env.cut.text, W < H ? 6 : 12);
    const size = Math.min(J.fitSize(text, P2.font, W * 0.72, H * 0.34, { lead: 1.15 }), H * 0.26);
    const laneH = H / P2.lanesN;
    const inA = E.outExpo(clamp(env.lt / 0.35)), outA = 1 - E.inCubic(env.pOut);
    // コメントは歌詞の後ろに流して読みやすさを保つ（旧プランの delay 形式にも対応）
    // 1レーンあたりのコメント数に応じて周回距離を伸ばし、縦長の狭い画面でも重ならないようにする
    const perLane = Math.ceil(P2.comments.length / P2.lanesN);
    const span = Math.max(W * 1.6, perLane * Math.min(W, H) * 0.95);
    for (const c of P2.comments) {
      const fs = Math.min(clamp(laneH * 0.58 * c.size, H * 0.018, H * 0.09), W * 0.07);
      const vel = Math.max(W, span * 0.45) * 0.38 * c.speed;
      const loop = span / vel;
      const tt = c.phase != null ? ((env.ltb / loop + c.phase) % 1 + 1) % 1 * loop : ((env.ltb - c.delay) % loop + loop) % loop;
      const x = W / 2 + span / 2 - vel * tt;
      const y = laneH * (c.lane + 0.5);
      env.draw({ text: c.text, font: P2.font, size: fs, x, y, color: c.hot ? sc.accent : sc.sub, alpha: 0.62 * inA * outA, ghost: false });
    }
    return J.mainDraw(env, { text, font: P2.font, size, x: W / 2, y: H / 2 + P2.oy * H, lead: 1.15, color: sc.fg, stroke: size * 0.14, strokeColor: sc.bg, strokeUnder: true });
  },
});

reg('layout', 'fillRepeat', {
  name: '埋め尽くし', tags: ['pop', 'graphic', 'vocalo'], w: 0.75, busy: true, fits: n => n <= 14,
  plan(rng, cut, st) {
    const rowsN = rng.pick([9, 10, 11, 12]);
    return {
      rowsN, mainRow: rng.int(3, rowsN - 3),
      font: rng.pick(fontsOf(st, ['display'])), tileFont: rng.pick(fontsOf(st, ['body', 'serif', 'display'])),
      speed: rng.range(16, 30), plate: rng.pick(['ink', 'accent', 'ink']),
    };
  },
  render(env) {
    const { W, H, sc } = env, P2 = env.cut.params, lb = env.ltb;
    const rowsN = P2.rowsN, rowH = H / rowsN;
    // メイン帯は横長で2段分、縦長で2行に割れるときは3段分の高さを取る
    const mt = W < H ? J.splitLines(env.cut.text, 6) : env.cut.text;
    const span = mt.includes('\n') ? 3 : 2;
    const mainRow = clamp(P2.mainRow, 1, rowsN - 1 - span) | 0;
    const unit = env.cut.text + '　';
    const ts = rowH * 0.68;
    const period = Math.max(1, J.measure({ text: unit, font: P2.tileFont, size: ts, track: 0.02 }).w);
    const reps = Math.ceil((W * 1.6) / period) + 2;
    const inA = E.outExpo(clamp(env.lt / 0.4));
    // sc.dim は背景に近すぎるので、背景と sub の中間色で「埋め尽くし」が見える濃さにする
    const tileCol = J.mix(sc.bg, sc.sub, 0.42);
    for (let r = 0; r < rowsN; r++) {
      if (r >= mainRow && r < mainRow + span) continue;
      const dir = r % 2 ? 1 : -1;
      const off = (((r % 2) * period * 0.5 + lb * P2.speed * dir) % period + period) % period;
      env.draw({ text: unit.repeat(reps), font: P2.tileFont, size: ts, track: 0.02, align: 'left', x: -period + off - period * 0.5, y: (r + 0.5) * rowH, color: tileCol, alpha: 0.9 * inA, ghost: false });
    }
    const bandY = mainRow * rowH, bandH = rowH * span;
    const plateCol = P2.plate === 'accent' ? sc.accent : sc.ink;
    const e = E.outExpo(clamp((env.lt * 1.4) / Math.max(0.2, env.cut.inDur))) * (1 - E.inCubic(env.pOut));
    env.rect(0, bandY, W, bandH, plateCol, e);
    const textCol = J.lum(plateCol) > 0.55 ? '#111111' : '#FFFFFF';
    const size = Math.min(J.fitSize(mt, P2.font, W * 0.86, bandH * 0.8, { track: 0.03 }), bandH * 0.72);
    return J.mainDraw(env, { text: mt, font: P2.font, size, x: W / 2, y: bandY + bandH / 2, track: 0.03, color: textCol });
  },
});

/* ================= ENTER ================= */

reg('enter', 'rapidFlash', {
  name: '高速連打', tags: ['pop', 'glitch', 'vocalo'], w: 0.8,
  inDur: (dur) => clamp(dur * 0.4, 0.22, 0.65),
  apply(env, it, p) {
    const seed = it.seed | 0, steps = 12;
    const q = Math.floor(p * steps);
    const decay = 1 - E.outCubic(clamp(p));
    if (decay <= 0.01) return;                    // resolved: no leftover offset, exactly the resting item
    it.charFns.push((i) => {
      const vis = J.r(seed, q, i, 1) < clamp(p * 1.3);
      if (!vis) return { hide: true };
      const dx = J.rs(seed, q, i, 2) * it.size * 0.55 * decay;
      const dy = J.rs(seed, q, i, 3) * it.size * 0.4 * decay;
      const s = 1 + J.rs(seed, q, i, 4) * 0.7 * decay;
      return J.r(seed, q, i, 5) < 0.3 * decay ? { dx, dy, s, color: env.sc.accent } : { dx, dy, s };
    });
  },
});

reg('enter', 'pixelIn', {
  name: 'ピクセル解像', tags: ['glitch', 'graphic', 'vocalo'], w: 0.7,
  apply(env, it, p) {
    const seed = it.seed | 0, steps = 5;
    const lvl = Math.min(steps, Math.floor(p * (steps + 1)));
    if (lvl >= steps) return;                      // resolved: sharp, no change left (resting item)
    const k = 1 - lvl / steps;                     // 1 = coarsest block, 0 = about to resolve
    it.blur = (it.blur || 0) + 12 * k * k;
    it.charFns.push((i) => {
      if (J.r(seed, lvl, i, 1) < 0.5 * k) return { hide: true };   // coarse pixels flicker missing blocks
      const cell = it.size * 0.5 * k;
      const dx = Math.round(J.rs(seed, lvl, i, 2) * 2) * (cell / 2);
      const dy = Math.round(J.rs(seed, lvl, i, 3) * 2) * (cell / 2);
      return { dx, dy, s: 1 + 0.15 * k, blur: 6 * k };
    });
  },
});

/* ================= HOLD ================= */

reg('hold', 'beatBlink', {
  name: '拍で点滅', tags: ['pop', 'glitch', 'vocalo'], w: 0.7,
  apply(env, it, amt) {
    const m = env.fx.motion ?? 0.7, b = env.beat;
    const decay = b ? Math.exp(-b.since * 8) : Math.pow(0.5 + 0.5 * Math.sin(env.lt * TAU * 2), 4);
    const k = decay * amt * m * 0.85;
    if (k < 0.025) return;
    const swap = b ? (b.index % 2 === 0) : (Math.floor(env.lt * 2) % 2 === 0);
    const sc = env.sc;
    it.charFns.push(() => (swap ? { color: sc.accent, a: 1 - 0.25 * k } : { a: 1 - 0.4 * k }));
  },
});

/* ================= BG ================= */

// 直前の同じ背景の連続カットからの経過時間（見た目のフェードインを1回にまとめる）
const bgRunV = new WeakMap();
const bgT = env => {
  const c = env.cut; if (!c) return env.t;
  let s = bgRunV.get(c);
  if (s == null) {
    s = c.start;
    const cs = (env.plan && env.plan.cuts) || [], P0 = c.bgP || {};
    for (let i = (c.index | 0) - 1; i >= 0 && i < cs.length; i--) {
      const pc = cs[i];
      if (pc.bg === c.bg && (pc.bgP || {}).seed === P0.seed && Math.abs(pc.end - s) < 0.06) s = pc.start; else break;
    }
    bgRunV.set(c, s);
  }
  return env.t - s;
};
const layC = (sc, k) => J.mix(sc.bg, sc.fg, k);
// bg / fx の draw() は呼び出し側で save/restore されないので、自前で状態を戻す（looks.js の bgReg/fxReg と同じ方針）
const bgReg = (k, d) => reg('bg', k, Object.assign({}, d, { draw(env, PP) { const ctx = env.ctx; ctx.save(); try { d.draw(env, PP || {}, ctx); } finally { ctx.restore(); } } }));
const fxReg = (k, d) => reg('fx', k, Object.assign({}, d, { draw(ctx, ev, kk, I) { ctx.save(); try { d.draw(ctx, ev, kk, I); } finally { ctx.restore(); } } }));

bgReg('beatStrobe', {
  name: '拍ストロボ', tags: ['pop', 'glitch', 'vocalo'],
  plan: rng => ({ stripes: rng.chance(0.5), ang: rng.pick([0, 20, -20, 45]), k: rng.range(0.14, 0.22) }),
  draw(env, P2, ctx) {
    const { W, H, sc } = env, b = env.beat;
    const decay = b ? Math.exp(-b.since * 10) : Math.pow(0.5 + 0.5 * Math.sin(env.t * TAU * 2.4), 5);
    const e = E.outCubic(clamp(bgT(env) / 0.4));
    const a = decay * (P2.k || 0.18) * e;
    if (a > 0.01) { ctx.globalAlpha = a; ctx.fillStyle = J.mix(sc.bg, sc.accent, 0.85); ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
    if (P2.stripes && a > 0.02) {
      const per = Math.min(W, H) * 0.16, R = Math.hypot(W, H) / 2 + 10;
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate((P2.ang || 0) * DEG);
      ctx.globalAlpha = a * 0.5; ctx.fillStyle = layC(sc, 0.16);
      for (let x = -R; x < R; x += per * 2) ctx.fillRect(x, -R, per, 2 * R);
      ctx.restore(); ctx.globalAlpha = 1;
    }
  },
});

/* ================= FX (post effect) ================= */

const bell = k => Math.sin(Math.PI * clamp(k));
const ampOf = ev => clamp(ev.amp ?? 1, 0.3, 1.6);

fxReg('pixelate', {
  name: 'ドット化', tags: ['glitch', 'pop', 'vocalo'], w: 0.8, dur: 3, amp: 1, mid: true, scratch: true,
  draw(ctx, ev, k, I) {
    const { cw, ch, S } = I; if (!S) return;
    const a = ampOf(ev) * bell(k);
    if (a < 0.04) return;
    const cells = Math.max(6, Math.round(18 - 11 * a));    // 内蔵モザイクより粗く・硬いグリッド
    const tw = cells, th = Math.max(2, Math.round(cells * ch / cw));
    const T = I.tmp(tw, th), tx = T.getContext('2d');
    tx.imageSmoothingEnabled = true; tx.drawImage(S, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = false;
    if (I.allowFilter) ctx.filter = `contrast(${(1 + 0.5 * a).toFixed(2)}) saturate(${(1 + 0.9 * a).toFixed(2)})`;
    ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(T, 0, 0, tw, th, 0, 0, cw, ch);
    ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = true;
  },
});
})();
