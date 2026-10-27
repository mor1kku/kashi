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

// Suggest only audible bounds. Silence stays full-length, noise spikes ignored.
assert.equal(JSON.stringify(range(audio)), JSON.stringify({ start: 0, end: 30 }));
const trimmed = { duration: 10, energyRate: 50, energy: new Float32Array(500) };
trimmed.energy[5] = 1;
trimmed.energy.fill(0.5, 100, 400);
assert.ok(Math.abs(range(trimmed).start - 1.9) < 1e-9);
assert.ok(Math.abs(range(trimmed).end - 8.1) < 1e-9);
console.log('timing_test: rough placement, anchors, range validation, audio bounds and short clips passed');
