// Run: node dev/timing_test.js. No browser or package installation required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { J: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/10b_timing.js'), 'utf8'), context);
const { autoLyricTimes: place, suggestLyricRange: range } = context.J;
const lines = ['短い', '少し長めの歌詞です', '最後のフレーズ'].map(text => ({ text, lrc: null }));
const audio = { duration: 30, energy: new Float32Array(1500), energyRate: 50, beats: [0, 1, 2, 3] };
function check(times, count, start, end) {
  assert.equal(Object.keys(times).length, count);
  for (let i = 0; i < count; i++) {
    assert.ok(Number.isFinite(times[i]));
    assert.ok(times[i] >= start && times[i] < end);
    if (i) assert.ok(times[i] > times[i - 1]);
  }
}

// Silence is deterministic and length weighted, without false beat snapping.
const silent = place(lines, audio, { start: 3, end: 27 });
check(silent, 3, 3, 27);
assert.equal(silent[0], 3);
assert.ok(silent[2] - silent[1] > silent[1] - silent[0]);
assert.deepEqual(place(lines, { duration: 30 }, { start: 3, end: 27 }), silent);
assert.equal(JSON.stringify(place([], audio)), '{}');
assert.equal(place([{ text: '一行' }], audio, { start: 2, end: 5 })[0], 2);

// Short clips and dense lyrics keep strict ordering and remain within the clip.
for (const duration of [0.00001, 0.01, 0.2, 1]) {
  const dense = Array.from({ length: 100 }, () => ({ text: '歌詞' }));
  check(place(dense, { duration }), dense.length, 0, duration);
}

// Manual values override LRC; both kinds of anchors survive exactly.
const anchored = Array.from({ length: 6 }, (_, i) => ({ text: '歌詞' + i, lrc: null }));
anchored[2].lrc = 10;
anchored[4].lrc = 20;
const fixed = place(anchored, audio, { start: 2, end: 28, anchors: { 2: 12, 5: 25 } });
check(fixed, 6, 2, 28);
assert.equal(fixed[0], 2);
assert.equal(fixed[2], 12);
assert.equal(fixed[4], 20);
assert.equal(fixed[5], 25);
const lrc = [{ text: '一', lrc: 5 }, { text: '二', lrc: 15 }];
const lrcResult = place(lrc, audio);
assert.equal(lrcResult[0], 5);
assert.equal(lrcResult[1], 15);

// Invalid ranges and contradictory anchors are rejected, never silently moved.
assert.throws(() => place(lines, null));
for (const opts of [{ start: -1 }, { end: 31 }, { start: 4, end: 4 }, { start: NaN }, { end: Infinity }]) {
  assert.throws(() => place(lines, audio, opts));
}
for (const anchors of [{ 1: 0 }, { 1: 30 }, { 0: 5, 1: 5 }, { 0: 8, 1: 4 }, { 1: NaN }]) {
  assert.throws(() => place(lines, audio, { anchors }));
}

// Audio features influence the guess, but cannot break bounds or order.
const active = { ...audio, energy: new Float32Array(1500).fill(0.7), beats: Array.from({ length: 60 }, (_, i) => i / 2) };
active.energy.fill(0, 400, 500);
const adjusted = place(lines, active, { start: 3, end: 27 });
check(adjusted, 3, 3, 27);
assert.notEqual(adjusted[1], silent[1]);
const corrupt = { ...active, energy: [NaN, Infinity, -1], beats: [NaN, Infinity, -1, 3, 2] };
check(place(lines, corrupt), 3, 0, 30);

// Sustained near-silence does not receive lyric starts between audible sections.
const four = Array.from({ length: 4 }, () => ({ text: 'らららら' }));
const phrases = { duration: 10, energyRate: 50, energy: new Float32Array(500).fill(0.005), beats: [2.5, 5, 7.5] };
phrases.energy.fill(0.8, 0, 100);
phrases.energy.fill(0.8, 400, 500);
const voiced = place(four, phrases, { snapStrength: 0 });
check(voiced, 4, 0, 10);
assert.ok(Math.abs(voiced[1] - 1) < 0.03);
assert.ok(Math.abs(voiced[2] - 8) < 0.03);
assert.ok(Math.abs(voiced[3] - 9) < 0.03);
assert.deepEqual(place(four, phrases, { snapStrength: 0 }), voiced, 'same audio and lyrics must be deterministic');

// Equal spacing is exact in wall-clock time with snapping off, even over silence.
const equal = place(four, phrases, { spacing: 'equal', snapStrength: 0 });
for (let i = 0; i < 4; i++) assert.equal(equal[i], i * 2.5);
const equalAnchored = place(four, { duration: 20 }, { spacing: 'equal', snapStrength: 0, anchors: { 1: 5 } });
for (let i = 0; i < 4; i++) assert.equal(equalAnchored[i], i * 5);

// Speech-length weighting meaningfully separates short and long lines.
const kana = place([{ text: 'あ' }, { text: 'あいうえお' }], { duration: 20 }, { snapStrength: 0 });
assert.ok(20 - kana[1] > kana[1] * 3);
const latin = place([{ text: 'go' }, { text: 'we go away today' }], { duration: 20 }, { snapStrength: 0 });
assert.ok(20 - latin[1] > latin[1] * 3);
const digraph = place([{ text: 'きゃ' }, { text: 'か' }], { duration: 10 }, { snapStrength: 0 });
assert.ok(Math.abs(digraph[1] - 5) < 1e-9, 'kana digraph shares one mora');

// Snap strength varies continuously toward the nearest usable beat.
const pair = [{ text: 'らららら' }, { text: 'らららら' }];
const steady = { duration: 10, energyRate: 50, energy: new Float32Array(500).fill(0.5), beats: [5.4] };
assert.equal(place(pair, steady, { spacing: 'equal', snapStrength: 0 })[1], 5);
assert.equal(place(pair, steady, { spacing: 'equal', snapStrength: 0.5 })[1], 5.2);
assert.equal(place(pair, steady, { spacing: 'equal', snapStrength: 1 })[1], 5.4);
assert.equal(place(pair, steady, { spacing: 'equal', snapStrength: 10 })[1], 5.4);
assert.equal(place(pair, steady, { spacing: 'equal', snapStrength: -1 })[1], 5);

// Prefer the attack after a quiet passage, not a beat in the quiet passage's centre.
const onset = { ...steady, energy: new Float32Array(500).fill(0.6), beats: [5] };
onset.energy.fill(0, 220, 275); // 4.4..5.5 seconds
const snappedOnset = place(pair, onset, { spacing: 'equal', snapStrength: 1 });
assert.ok(Math.abs(snappedOnset[1] - 5.5) < 0.03);

// LRC may explicitly be ignored, while manual anchors are always respected.
const imported = [{ text: 'らら', lrc: 3 }, { text: 'らら', lrc: 22 }];
const respectLrc = place(imported, { duration: 30 }, { spacing: 'equal', snapStrength: 0 });
assert.equal(respectLrc[0], 3); assert.equal(respectLrc[1], 22);
const ignoreLrc = place(imported, { duration: 30 }, { spacing: 'equal', snapStrength: 0, ignoreLrc: true });
assert.equal(ignoreLrc[0], 0); assert.equal(ignoreLrc[1], 15);
const manualWins = place(imported, { duration: 30 }, { ignoreLrc: true, anchors: { 1: 17 } });
assert.equal(manualWins[1], 17);

// Suggest only audible bounds. Silence stays full-length, noise spikes ignored.
assert.equal(JSON.stringify(range(audio)), JSON.stringify({ start: 0, end: 30 }));
const trimmed = { duration: 10, energyRate: 50, energy: new Float32Array(500) };
trimmed.energy[5] = 1;
trimmed.energy.fill(0.5, 100, 400);
assert.ok(Math.abs(range(trimmed).start - 1.9) < 1e-9);
assert.ok(Math.abs(range(trimmed).end - 8.1) < 1e-9);
console.log('timing_test: speech pacing, silence gaps, equal spacing, snapping, LRC options, anchors and bounds passed');
