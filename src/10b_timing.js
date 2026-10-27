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

// A pacing proxy, not a pronunciation dictionary. Kana digraphs share one mora;
// kanji receive a modest reading allowance, while Latin words use vowel groups.
function speechLength(text) {
  const tokens = String(text || '').match(/[A-Za-z]+(?:['’][A-Za-z]+)*|[0-9]+|[\p{L}\p{N}ー]/gu) || [];
  let units = 0;
  for (const token of tokens) {
    if (/^[A-Za-z]/.test(token)) {
      const word = token.toLowerCase().replace(/['’]/g, '');
      let syllables = (word.match(/[aeiouy]+/g) || []).length;
      if (word.length > 3 && /[^aeiou]e$/.test(word) && !/[^aeiou]le$/.test(word)) syllables--;
      units += Math.max(1, syllables);
    } else if (/^[0-9]+$/.test(token)) units += token.length;
    else if (/^[ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ]$/.test(token)) { if (!units) units++; }
    else units += /^[\u3400-\u9fff]$/.test(token) ? 2 : 1;
  }
  return Math.max(1, units) + 0.5;
}

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
    const value = anchors[i] != null ? anchors[i] : options.ignoreLrc === true ? null : lines[i].lrc;
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

  const energy = audio.energy || [], rate = Number(audio.energyRate) > 0 && Number.isFinite(Number(audio.energyRate)) ? Number(audio.energyRate) : 50;
  const equal = options.spacing === 'equal';
  const strength = options.snapStrength == null ? 0.65 : Number(options.snapStrength);
  const snapStrength = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0.65;
  const energyAt = t => {
    const value = energy[Math.floor(t * rate)];
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  };
  // Ignore artificial beat grids from silent audio (the tempo analyser still returns a grid).
  const hasEnergy = Array.from(energy).some(v => Number.isFinite(v) && v > 0.01);
  const beats = hasEnergy ? (audio.beats || []).filter(t => Number.isFinite(t) && t >= start && t < end && energyAt(t + 0.04) > 0.035).sort((a, b) => a - b) : [];
  const weights = lines.map(line => equal ? 1 : speechLength(line.text));
  const times = {};
  for (let s = 0; s < fixed.length - 1; s++) {
    const left = fixed[s], right = fixed[s + 1];
    const count = right.index - left.index, span = right.time - left.time;
    times[left.index] = left.time;
    if (count === 1) continue;
    // Long near-silent passages carry no lyric weight. Small pauses retain weight;
    // a wholly silent/missing envelope falls back to time instead of dividing by zero.
    const bins = Math.max(1, Math.min(20000, Math.ceil(span * 50)));
    const levels = Array.from({ length: bins }, (_, k) => energyAt(left.time + (k + 0.5) / bins * span));
    const activity = levels.map(level => 0.25 + 0.75 * Math.sqrt(level));
    const onsets = [];
    for (let k = 0; k < bins;) {
      if (levels[k] > 0.035) { k++; continue; }
      const from = k;
      while (k < bins && levels[k] <= 0.035) k++;
      if ((k - from) / bins * span >= 0.18) {
        activity.fill(0, from, k);
        if (k < bins) onsets.push({ time: left.time + k / bins * span, confidence: 1 });
      }
    }
    for (let k = 2; k < bins; k++) {
      const rise = levels[k] - levels[k - 2];
      if (rise >= 0.15 && levels[k] >= levels[k - 1]) {
        onsets.push({ time: left.time + k / bins * span, confidence: Math.min(0.9, 0.55 + rise) });
      }
    }
    const useActivity = !equal && hasEnergy && activity.some(value => value > 0);
    const cumulative = [0];
    for (let k = 0; k < bins; k++) {
      cumulative.push(cumulative[k] + (useActivity ? activity[k] : 1));
    }
    const intervals = [];
    for (let i = left.index; i < right.index; i++) {
      intervals.push(weights[i] + (!equal && i + 1 < n && lines[i + 1].gapBefore ? 1 : 0));
    }
    const totalWeight = intervals.reduce((a, b) => a + b, 0);
    const minGap = Math.min(0.1, span / count / 4);
    let usedWeight = 0, cursor = 0;
    for (let i = left.index + 1; i < right.index; i++) {
      usedWeight += intervals[i - left.index - 1];
      const target = cumulative[bins] * usedWeight / totalWeight;
      // Right-biased inversion skips silent plateaus, placing the next line at the
      // next audible attack instead of the middle of an instrumental pause.
      const epsilon = cumulative[bins] * 1e-12;
      while (cursor + 1 < bins && cumulative[cursor + 1] <= target + epsilon) cursor++;
      const step = cumulative[cursor + 1] - cumulative[cursor];
      const fraction = step > 0 ? Math.max(0, Math.min(1, (target - cumulative[cursor]) / step)) : 0;
      const ideal = left.time + (cursor + fraction) / bins * span;
      const low = times[i - 1] + minGap, high = right.time - (right.index - i) * minGap;
      const radius = Math.min(1.2, span / count * 0.35);
      let bestTime = ideal, bestScore = 0;
      // Prefer quiet-to-active transitions and rising energy, not quiet centres.
      if (hasEnergy && snapStrength > 0) {
        const candidates = onsets.concat(beats.map(time => ({ time, confidence: 0.45 })));
        for (const candidate of candidates) {
          const t = candidate.time, distance = Math.abs(t - ideal);
          if (t < low || t > high || distance > radius) continue;
          const score = candidate.confidence - distance / radius * 0.8;
          if (score > bestScore) { bestScore = score; bestTime = t; }
        }
      }
      times[i] = Math.max(low, Math.min(high, ideal + (bestTime - ideal) * snapStrength));
    }
  }
  return times;
};
})();
