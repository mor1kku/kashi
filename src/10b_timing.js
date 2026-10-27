/* Rough lyric placement, entirely in the browser. This is not speech recognition:
   text length supplies pacing; the energy envelope and beat grid suggest boundaries. */
(() => {
'use strict';

// Suggest the audible region, not the vocal region. Ignore brief noise spikes and
// retain a small pad so an attack at the edge is not cut off.
J.suggestLyricRange = audio => {
  const duration = Number(audio && audio.duration);
  if (!(duration > 0) || !Number.isFinite(duration)) return { start: 0, end: 0 };
  const energy = audio.energy || [], rate = Number(audio.energyRate) || 50;
  const runLength = Math.max(1, Math.ceil(rate * 0.06));
  let run = 0, first = -1, last = -1;
  for (let i = 0; i < energy.length; i++) {
    run = energy[i] > 0.02 ? run + 1 : 0;
    if (run >= runLength) {
      if (first < 0) first = i - runLength + 1;
      last = i;
    }
  }
  if (first < 0) return { start: 0, end: duration };
  const start = Math.max(0, first / rate - 0.1);
  const end = Math.min(duration, (last + 1) / rate + 0.1);
  return end > start ? { start, end } : { start: 0, end: duration };
};

J.autoLyricTimes = (lines, audio, options = {}) => {
  const duration = Number(audio && audio.duration);
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('先に曲を読み込んでください。');
  const start = options.start == null ? 0 : Number(options.start);
  const end = options.end == null ? duration : Number(options.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end <= start) {
    throw new Error('歌い始めと歌い終わりを、曲の範囲内で指定してください。');
  }
  if (!lines.length) return {};
  const n = lines.length, anchors = options.anchors || {}, fixed = [];
  for (let i = 0; i < n; i++) {
    const value = anchors[i] != null ? anchors[i] : lines[i].lrc;
    if (value == null) continue;
    const t = Number(value);
    if (!Number.isFinite(t) || t < start || t >= end) {
      throw new Error(`${i + 1}行目の確定時刻が歌唱範囲外です。時刻か歌唱範囲を調整してください。`);
    }
    if (fixed.length && t <= fixed[fixed.length - 1].time) {
      throw new Error('確定済みの歌詞の時刻が前後しています。先に行の開始秒を調整してください。');
    }
    fixed.push({ index: i, time: t });
  }
  if (!fixed.length || fixed[0].index !== 0) {
    if (fixed.length && fixed[0].time <= start) throw new Error('歌い始めを、確定済みの行より前にしてください。');
    fixed.unshift({ index: 0, time: start });
  }
  fixed.push({ index: n, time: end });

  const energy = audio.energy || [], rate = Number(audio.energyRate) || 50;
  const energyAt = t => {
    const value = energy[Math.floor(t * rate)];
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  };
  // Ignore artificial beat grids from silent audio (the tempo analyser still returns a grid).
  const hasEnergy = Array.from(energy).some(v => Number.isFinite(v) && v > 0.01);
  const beats = hasEnergy ? (audio.beats || []).filter(t => Number.isFinite(t) && t >= start && t < end).sort((a, b) => a - b) : [];
  const weights = lines.map(line => {
    const count = Array.from(String(line.text || '').replace(/\s|[、。,.!?！？]/g, '')).length;
    return 0.8 + Math.sqrt(Math.max(1, count));
  });
  const times = {};
  for (let s = 0; s < fixed.length - 1; s++) {
    const left = fixed[s], right = fixed[s + 1];
    const count = right.index - left.index, span = right.time - left.time;
    times[left.index] = left.time;
    if (count === 1) continue;
    // Build an activity clock. A nonzero floor lets long quiet passages retain time,
    // while a modest energy contribution avoids assigning most lyrics to silence.
    const bins = Math.max(1, Math.min(20000, Math.ceil(span * 50)));
    const cumulative = [0];
    for (let k = 0; k < bins; k++) {
      cumulative.push(cumulative[k] + 0.65 + 0.35 * energyAt(left.time + (k + 0.5) / bins * span));
    }
    const intervals = [];
    for (let i = left.index; i < right.index; i++) {
      intervals.push(weights[i] + (i + 1 < n && lines[i + 1].gapBefore ? 1 : 0));
    }
    const totalWeight = intervals.reduce((a, b) => a + b, 0);
    const minGap = Math.min(0.1, span / count / 4);
    let usedWeight = 0, cursor = 0;
    for (let i = left.index + 1; i < right.index; i++) {
      usedWeight += intervals[i - left.index - 1];
      const target = cumulative[bins] * usedWeight / totalWeight;
      while (cursor + 1 < bins && cumulative[cursor + 1] < target) cursor++;
      const fraction = (target - cumulative[cursor]) / (cumulative[cursor + 1] - cumulative[cursor]);
      const ideal = left.time + (cursor + fraction) / bins * span;
      const low = times[i - 1] + minGap, high = right.time - (right.index - i) * minGap;
      const radius = Math.min(0.65, span / count * 0.18);
      let bestTime = Math.max(low, Math.min(high, ideal)), bestScore = -Infinity;
      // A quiet boundary or a beat may shift the estimate slightly, never a whole phrase.
      const candidates = [{ time: bestTime, beat: false }];
      if (hasEnergy) {
        for (let k = -4; k <= 4; k++) candidates.push({ time: ideal + radius * k / 4, beat: false });
        for (const beat of beats) if (Math.abs(beat - ideal) <= radius) candidates.push({ time: beat, beat: true });
      }
      for (const candidate of candidates) {
        const t = candidate.time;
        if (t < low || t > high) continue;
        const proximity = radius > 0 ? Math.abs(t - ideal) / radius : 0;
        const score = -proximity + (hasEnergy ? (1 - energyAt(t)) * 0.3 : 0) + (candidate.beat ? 0.35 : 0);
        if (score > bestScore) { bestScore = score; bestTime = t; }
      }
      times[i] = bestTime;
    }
  }
  return times;
};
})();
