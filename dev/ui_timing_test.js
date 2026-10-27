// Run: node dev/ui_timing_test.js. Exercise actual UI timing handlers without a browser.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const elements = {};
let playbackTime = 8;
const context = {
  J: {
    LAYOUT_ORDER: [], ENTER_ORDER: [], EXIT_ORDER: [], HOLD_ORDER: [], DECOR_ORDER: [],
    clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
  },
  S: {},
  $: id => elements[id] ||= { setAttribute() {}, focus() {} },
  pause() {}, play() {}, seek() {}, replan() {}, replanSoon() {}, syncUI() {}, renderLines() {},
  AP: { time: () => playbackTime },
  audioLike: () => context.S.audio,
};
vm.createContext(context);
vm.runInContext(read('src/08_planner.js'), context);
vm.runInContext(read('src/10b_timing.js'), context);
const source = read('src/12_ui.js');
const begin = source.indexOf('let timingUndo = null;');
const end = source.indexOf('/* ---------------- sync all inputs from project');
assert.ok(begin >= 0 && end > begin, 'UI timing handler section must be available');
vm.runInContext(source.slice(begin, end), context);

function reset() {
  playbackTime = 8;
  context.S = {
    project: { lyrics: 'A\nB\nC', timing: { lineTimes: { 1: 10 }, autoTimes: { 0: 0, 1: 10, 2: 20 } } },
    plan: { lines: [{ text: 'A', start: 0 }, { text: 'B', start: 10 }, { text: 'C', start: 20 }] },
    audio: { duration: 30 }, t: 8, playing: true, tap: null,
  };
}

// A newly inserted row must not inherit the old row's manual correction.
reset();
context.updateLyrics('X\nA\nB\nC');
assert.equal(context.S.project.timing.lineTimes[2], 10);
assert.equal(context.S.project.timing.lineTimes[1], undefined);
assert.equal(Object.keys(context.S.project.timing.autoTimes).length, 0);
assert.equal(elements.btnUndoTiming.disabled, true);
assert.match(elements.timingStatus.textContent, /仮配置/);

// Correcting words in place retains the row's manual timestamp.
reset();
context.updateLyrics('A\nB corrected\nC');
assert.equal(context.S.project.timing.lineTimes[1], 10);

// Reordering corrected rows never retains mutually contradictory manual anchors.
reset();
context.S.project.timing.lineTimes = { 0: 2, 1: 10, 2: 20 };
context.updateLyrics('C\nB\nA');
const anchors = Object.values(context.S.project.timing.lineTimes);
assert.ok(anchors.every((t, i) => !i || t > anchors[i - 1]));

// A partial tap is staged; stopping places remaining lyrics after the tapped anchor.
reset();
context.S.project.timing.lineTimes = {};
context.startTap();
context.tapNow();
assert.equal(Object.keys(context.S.project.timing.lineTimes).length, 0);
context.stopTap();
assert.equal(context.S.project.timing.lineTimes[0], 8);
assert.ok(context.S.project.timing.autoTimes[1] > 8);
assert.ok(context.S.project.timing.autoTimes[2] > context.S.project.timing.autoTimes[1]);
assert.equal(elements.btnUndoTiming.disabled, false);

// Contradictory untapped manual anchors reject the session without altering the project.
reset();
context.S.project.timing.lineTimes = { 1: 4 };
const beforeTap = JSON.stringify(context.S.project.timing);
context.startTap();
context.tapNow();
context.stopTap();
assert.equal(JSON.stringify(context.S.project.timing), beforeTap);
assert.match(elements.timingStatus.textContent, /元のタイミング/);

// Rounding cannot move a correction onto its neighbour's timestamp.
reset();
context.S.project.timing.autoTimes = { 0: 1.001, 1: 1.5, 2: 2 };
context.S.project.timing.lineTimes = {};
context.S.plan.lines = [{ start: 1.001 }, { start: 1.5 }, { start: 2 }];
context.setLineTime(1, 1.0014);
assert.equal(context.S.project.timing.lineTimes[1], undefined);

// Clearing a correction must not expose an automatic timestamp before the previous row.
reset();
context.S.project.timing.autoTimes = { 0: 0, 1: 5, 2: 10 };
context.S.project.timing.lineTimes = { 0: 7, 1: 8 };
context.S.plan.lines = [{ start: 7 }, { start: 8 }, { start: 10 }];
context.setLineTime(1, NaN);
assert.equal(context.S.project.timing.lineTimes[1], 8);

console.log('ui_timing_test: lyric edits, anchor remapping, staged taps, rollback and correction bounds passed');
