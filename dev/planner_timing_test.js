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

result = J.computeTiming({ timing: { ignoreLrc: true, lineTimes: { 0: 1.1 }, autoTimes: { 0: 0.5, 1: 1.5, 2: 3 }, autoEnd: 4 } }, parsed, { duration: 5 });
assert.deepEqual(Array.from(result.starts), [1.1, 1.5, 3], 'ignoring LRC retains manual priority and uses replacement automatic times');
result = J.computeTiming({ timing: { ignoreLrc: true, offset: 0.7 } }, { lines: parsed.lines.slice(0, 2) }, null);
assert.equal(result.starts[0], 0.7, 'resetting LRC permits a new untimestamped start');

result = J.computeTiming({ timing: { lineTimes: { 0: 1, 1: 2, 2: 3 }, autoEnd: 3.2 } }, short, { duration: 3.2 });
assert.equal(result.ends[2], 3.2, 'an explicit singing end applies to purely manual timings');
assert.equal(result.duration, 3.2, 'a manual singing end at the song end adds no artificial tail');
result = J.computeTiming({ timing: { lineTimes: { 0: 1 }, autoEnd: NaN } }, { lines: [{ text: 'あ' }] }, null);
assert.equal(result.ends[0], 2.5, 'an invalid explicit singing end is ignored');
result = J.computeTiming({ timing: { lineTimes: { 0: 1 }, autoEnd: 0.5 } }, { lines: [{ text: 'あ' }] }, null);
assert.equal(result.ends[0], 2.5, 'an end before the last start cannot produce a negative duration');

// Exercise the real planner and core layout registries, not a stand-in for the
// cut-building logic. Canvas measurement is unused by planning but initialized
// when loading the font module.
const engine = { window: {}, Intl, document: { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 1 }) }) }) } };
vm.createContext(engine);
const srcDir = path.join(__dirname, '../src');
for (const file of fs.readdirSync(srcDir).sort().filter(file => /^0[1-8]_/.test(file) || file === '05b_registry.js')) {
  vm.runInContext(fs.readFileSync(path.join(srcDir, file), 'utf8'), engine, { filename: file });
}
const core = engine.window.J;
for (const mode of ['manual', 'auto']) {
  const project = core.defaultProject();
  project.lyrics = '[00:01.00]one/two/three\n[00:03.00]four/five/six';
  project.timing.ignoreLrc = true;
  project.timing.snap = true;
  project.timing[mode === 'manual' ? 'lineTimes' : 'autoTimes'] = { 0: 1.237, 1: 3.119 };
  project.timing.autoEnd = 5.321;
  const plan = core.plan(project, { duration: 5.321, beats: [1.2, 2, 3.1, 4, 5.3] });
  assert.deepEqual(Array.from(plan.lines, line => line.start), [1.237, 3.119]);
  for (const line of plan.lines) {
    const firstCut = plan.cuts.find(cut => cut.line === line.index && cut.layout !== 'interlude');
    assert.equal(firstCut.start, line.start, `${mode} line start must reach the rendered cut without beat snapping`);
  }
  assert.equal(plan.lines[1].end, 5.321);
  assert.equal(plan.cuts.filter(cut => cut.line === 1).at(-1).end, 5.321);
}
console.log('planner timing: priority, LRC reset, explicit end and exact cut-boundary regressions passed');
