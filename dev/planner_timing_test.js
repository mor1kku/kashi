// Run from the repository root: node dev/planner_timing_test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const J = { clamp: (x, a, b) => Math.max(a, Math.min(b, x)) };
for (const name of ['LAYOUT', 'ENTER', 'EXIT', 'HOLD', 'DECOR']) J[name + '_ORDER'] = [];
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/08_planner.js'), 'utf8'), { J, Intl });
const parsed = { lines: [{ text: 'あ', lrc: 1 }, { text: 'いう', lrc: 2 }, { text: 'えお', lrc: null }] };
const timing = { lineTimes: { 0: 1.2 }, autoTimes: { 0: 0.5, 1: 1.5, 2: 3 }, autoEnd: 4 };
let result = J.computeTiming({ timing }, parsed, { duration: 5 });
assert.deepEqual(Array.from(result.starts), [1.2, 2, 3], 'manual > LRC > automatic');
assert.deepEqual(Array.from(result.ends), [2, 3, 4]);
assert.equal(result.duration, 5);

result = J.computeTiming({ timing: { lineTimes: { 0: 0.8 } } }, { lines: parsed.lines.slice(0, 2) }, null);
assert.equal(result.starts[0], 0.8, 'fully timestamped LRC can be manually corrected');

const short = { lines: [{ text: 'あ' }, { text: 'い' }, { text: 'う' }] };
result = J.computeTiming({ timing: { autoTimes: { 0: 0, 1: 0.1, 2: 0.2 }, autoEnd: 0.3 } }, short, { duration: 0.3 });
assert.deepEqual(Array.from(result.ends), [0.1, 0.2, 0.3], 'rapid phrases do not overlap');
assert.equal(result.duration, 0.3, 'automatic alignment does not append silence to the song');

result = J.computeTiming({ timing: { autoTimes: { 0: 0, 1: 1, 2: 2 }, autoEnd: 3, lineTimes: { 2: 3.5 } } }, short, { duration: 4 });
assert.equal(result.ends[2], 4, 'manual correction after autoEnd stays within audio when possible');

result = J.computeTiming({ timing: { autoTimes: { 0: NaN, 1: Infinity }, lineTimes: { 0: NaN }, offset: 0.4 } }, short, null);
assert.deepEqual(Array.from(result.starts), [0.4, 1.7000000000000002, 3], 'invalid saved times fall back to legacy timing');
assert.equal(result.duration, 5.4, 'legacy timing keeps its tail');

result = J.computeTiming({ timing: { autoTimes: { 0: 1 }, autoEnd: 4, useAudioLength: false, tail: 0.5 } }, { lines: [{ text: 'あ' }] }, { duration: 10 });
assert.equal(result.duration, 4.5, 'explicit useAudioLength opt-out retains tail');

console.log('planner timing: 11 assertions passed');
